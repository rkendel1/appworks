/**
 * Installation (spec/distribution-1.md §5): an acquired, trusted package is checked against the receiving environment, locked
 * to the providers that environment resolves, and recorded. Installing is not authorizing: the record says so, and the lock
 * grants nothing. The runtime executes from this record's package bytes, never from a source checkout.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestOfBytes } from "@distribution-protocol/protocol";
import {
  RecipeLockError,
  checkRecipeLock,
  createRecipeLock,
  loadRecipePackage,
  validateRecipe,
  type RecipeEnvironment,
  type RecipeFinding,
  type RecipeLock,
  type RecipePackage,
  type RecipeSource,
  type ResolvedDependencyRecord
} from "@appport/recipe";
import { parseProduct, writeAtomic } from "./channel.js";
import type { AcquireResult } from "./acquire.js";

export const INSTALL_FORMAT = "appworks.recipe-install/1" as const;

/** What the receiving environment must answer: its active contracts and eligible providers, and who actually resolves each dependency. */
export interface InstallEnvironment {
  snapshot(requires: RecipeSource["requires"]): Promise<RecipeEnvironment>;
  /** AppPort `resolvedDependency()` records, one per declared dependency; rejects if one does not resolve to exactly one provider. */
  resolve(requires: RecipeSource["requires"]): Promise<Record<string, ResolvedDependencyRecord>>;
}

export interface InstallRecord {
  format: typeof INSTALL_FORMAT;
  product: { id: string; version: string };
  release: { id: string; publisher: string; keyId: string };
  package: { recipe: string; digest: string };
  artifact: { id: string; digest: string; size?: number };
  /** The environment's lock (providers it resolved), by byte digest. A lock grants nothing. */
  lock: { digest: string };
  /** What the environment must provide that no lock can check: the roles human tasks are assigned to. */
  requirements: { roles: string[] };
  trust: { publisherTrust: "verified"; anchor?: string; publisherDocument?: string };
  /** Contracts whose revision here differs from the one the publisher locked (compatibility is decided by validation, not by equality). */
  contractDrift: Array<{ id: string; published: string; local: string }>;
  installedAt: string;
  /** Always none: installing a package authorizes no invocation. Grants are the environment's, per consumer, per capability. */
  authorizes: "nothing";
}

export type InstallStage = "trust" | "environment" | "conflict" | "installed" | "already-installed";

export interface InstallResult {
  ok: boolean;
  stage: InstallStage;
  reason?: string;
  findings?: RecipeFinding[] | string[];
  dir?: string;
  record?: InstallRecord;
}

export class InstallStore {
  constructor(readonly dir: string) {}
  pathFor(product: string, version: string): string {
    const { namespace, slug } = parseProduct(product);
    return join(this.dir, namespace, slug, version);
  }
  list(): InstallRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: InstallRecord[] = [];
    for (const ns of readdirSync(this.dir)) {
      const nsDir = join(this.dir, ns);
      for (const slug of safeList(nsDir)) for (const version of safeList(join(nsDir, slug))) {
        const file = join(nsDir, slug, version, "install.json");
        if (existsSync(file)) out.push(JSON.parse(readFileSync(file, "utf8")) as InstallRecord);
      }
    }
    return out;
  }
}
const safeList = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.includes(".tmp-")) : []);

export async function installRecipePackage(input: { store: InstallStore; acquired: AcquireResult; environment: InstallEnvironment; now?: () => Date }): Promise<InstallResult> {
  const { acquired } = input;
  const refuse = (stage: InstallStage, reason: string, extra: Partial<InstallResult> = {}): InstallResult => ({ ok: false, stage, reason, ...extra });
  if (!acquired.ok || !acquired.package || !acquired.bytes || !acquired.receipt || !acquired.release) return refuse("trust", "there is no accepted package to install");
  // Distribution Protocol requires trust to be evaluated before an artifact is installed: a package merely acquired is not installable.
  if (!acquired.installable) return refuse("trust", "the publisher's trust was not evaluated against a policy, so this package can be inspected but not installed");

  const pkg = acquired.package as RecipePackage;
  const recipe = pkg.recipe;
  const manifest = (acquired.release as { manifest: { product: { id: string; version: string }; publisher: { id: string }; artifacts: Array<{ id: string; digest: string; size?: number }> } }).manifest;
  const signature = acquired.release.signature as { keyId: string };

  const dir = input.store.pathFor(manifest.product.id, manifest.product.version);
  if (existsSync(join(dir, "install.json"))) {
    const existing = JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) as InstallRecord;
    if (existing.package.digest === pkg.digest && existing.artifact.digest === manifest.artifacts[0]!.digest) return { ok: true, stage: "already-installed", dir, record: existing };
    return refuse("conflict", `${manifest.product.id}@${manifest.product.version} is already installed with a different package (${existing.package.digest}); an installed version never changes`, { dir });
  }

  // The receiving environment decides compatibility: its contracts, its providers, validated afresh (the package's own validation is informational).
  let snapshot: RecipeEnvironment;
  try {
    snapshot = await input.environment.snapshot(recipe.requires);
  } catch (error) {
    return refuse("environment", `the environment could not be inspected: ${(error as Error).message}`);
  }
  const validation = validateRecipe(recipe, snapshot);
  if (!validation.ok) return refuse("environment", "the recipe cannot run in this environment", { findings: validation.findings.filter((f) => f.severity === "error") });
  let lock: RecipeLock;
  try {
    lock = createRecipeLock(recipe, { contracts: snapshot.contracts ?? {}, resolutions: await input.environment.resolve(recipe.requires) });
  } catch (error) {
    const problems = error instanceof RecipeLockError ? [...error.problems] : [(error as Error).message];
    return refuse("environment", `the dependencies do not resolve here: ${problems.join("; ")}`, { findings: problems });
  }
  const consistent = checkRecipeLock(lock, recipe);
  if (!consistent.ok) return refuse("environment", "the environment's lock does not match the recipe", { findings: consistent.findings.map((f) => `${f.code}: ${f.message}`) });

  const lockBytes = `${JSON.stringify(lock, null, 2)}\n`;
  const published = new Map(pkg.lock.dependencies.map((d) => [d.canonical.contract, d.canonical.contractDigest]));
  const contractDrift = lock.dependencies
    .map((d) => ({ id: d.canonical.contract, published: published.get(d.canonical.contract) ?? "", local: d.canonical.contractDigest }))
    .filter((c, i, all) => c.published !== c.local && all.findIndex((x) => x.id === c.id) === i);
  const trust = (acquired.receipt as { verification?: { trustAnchor?: string; publisherDocument?: string } }).verification ?? {};
  const record: InstallRecord = {
    format: INSTALL_FORMAT,
    product: { id: manifest.product.id, version: manifest.product.version },
    release: { id: `${manifest.product.id}@${manifest.product.version}`, publisher: manifest.publisher.id, keyId: signature.keyId },
    package: { recipe: recipe.id, digest: pkg.digest },
    artifact: { id: manifest.artifacts[0]!.id, digest: manifest.artifacts[0]!.digest, ...(manifest.artifacts[0]!.size !== undefined ? { size: manifest.artifacts[0]!.size } : {}) },
    lock: { digest: digestOfBytes(lockBytes) },
    requirements: pkg.requirements,
    trust: { publisherTrust: "verified", ...(trust.trustAnchor ? { anchor: trust.trustAnchor } : {}), ...(trust.publisherDocument ? { publisherDocument: trust.publisherDocument } : {}) },
    contractDrift,
    installedAt: (input.now?.() ?? new Date()).toISOString(),
    authorizes: "nothing"
  };

  // Written whole and moved into place, so an install is either all there or not there.
  const staging = `${dir}.tmp-${randomUUID()}`;
  try {
    writeAtomic(join(staging, "package.bin"), acquired.bytes);
    writeAtomic(join(staging, "lock.json"), lockBytes);
    writeAtomic(join(staging, "release.json"), `${JSON.stringify(acquired.release, null, 2)}\n`);
    writeAtomic(join(staging, "receipt.json"), `${JSON.stringify(acquired.receipt, null, 2)}\n`);
    writeAtomic(join(staging, "install.json"), `${JSON.stringify(record, null, 2)}\n`);
    mkdirSync(join(dir, ".."), { recursive: true });
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // A concurrent installer of the same version may have won; that is only fine if it installed the same package.
    if (existsSync(join(dir, "install.json"))) {
      const winner = JSON.parse(readFileSync(join(dir, "install.json"), "utf8")) as InstallRecord;
      return winner.package.digest === pkg.digest ? { ok: true, stage: "already-installed", dir, record: winner } : refuse("conflict", `${record.release.id} was installed concurrently with a different package`, { dir });
    }
    throw error;
  }
  return { ok: true, stage: "installed", dir, record };
}

export interface InstalledPackage {
  ok: boolean;
  record?: InstallRecord;
  package?: RecipePackage;
  lock?: RecipeLock;
  findings: string[];
}

/** Reads an installed package back and checks it against its own record: the bytes still are the package, the lock still is the lock. */
export function readInstalledPackage(dir: string): InstalledPackage {
  const findings: string[] = [];
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : undefined);
  const recordBytes = read("install.json");
  if (!recordBytes) return { ok: false, findings: [`${dir} holds no install.json`] };
  const record = JSON.parse(recordBytes.toString("utf8")) as InstallRecord;
  if (record.format !== INSTALL_FORMAT) return { ok: false, findings: [`not an ${INSTALL_FORMAT} record`] };
  const bytes = read("package.bin");
  const lockBytes = read("lock.json");
  if (!bytes || !lockBytes) return { ok: false, record, findings: ["the install is missing its package or lock"] };
  const loaded = loadRecipePackage(new Uint8Array(bytes), { digest: record.package.digest, recipe: record.package.recipe });
  if (!loaded.ok) findings.push(...loaded.findings.map((f) => `${f.code}: ${f.message}`));
  if (digestOfBytes(lockBytes) !== record.lock.digest) findings.push("lock.json does not match the digest in install.json");
  const lock = JSON.parse(lockBytes.toString("utf8")) as RecipeLock;
  if (loaded.package) {
    const checked = checkRecipeLock(lock, loaded.package.recipe);
    if (!checked.ok) findings.push(...checked.findings.map((f) => `${f.code}: ${f.message}`));
  }
  return { ok: findings.length === 0, record, ...(loaded.package ? { package: loaded.package } : {}), lock, findings };
}
