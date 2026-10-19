/**
 * Recipe dependency locks: `appport.recipe-lock/1` (spec/recipe-1.md §5).
 *
 * A lock records, for each canonical dependency a recipe declares, the exact canonical revision its assumptions were
 * checked against and, optionally, the provider an environment resolved it to. Two parts are kept apart because they
 * mean different things:
 *
 * - `canonical`: the **portable** contract identity (contract id, `contractDigest`, canonical capability, major version,
 *   `capabilityDigest`). The same in every environment that holds that contract revision.
 * - `resolution`: the **environment-specific** selection (provider application and its own capability, registration
 *   incarnation and fingerprint, contract registry revision, the fulfillment claim's digest and status). Meaningless in
 *   another environment; a portable lock has none.
 *
 * A lock is a record of assumptions, not a source of authority: it grants nothing to anyone, never makes a stale or
 * invalid claim eligible, and a provider can change only through {@link substituteProvider}, which re-checks the
 * canonical identity and requires a valid fulfillment.
 *
 * It is built from the `resolvedDependency()` records of `@appport/core` (AppPort `fulfillment-1` §5.2) that the caller's
 * resolution produced. This package does not depend on the runtime: it reads the part of the record it needs.
 */
import {
  capabilityDigest,
  contractDigest,
  digestOf,
  isCanonicalContract,
  isCanonicalDependencyTarget,
  parseDependencyRef,
  satisfiesVersionConstraint,
  type AppPortManifest,
  type Dependency,
  type FulfillmentClaim,
  type FulfillmentStatus
} from "@appport/protocol";
import type { RecipeSource } from "./source.js";

export const RECIPE_LOCK_FORMAT = "appport.recipe-lock/1" as const;

/** The portable identity of the canonical capability revision a dependency was locked against. */
export interface LockedCanonical {
  contract: string;
  /** `contractDigest` of the whole contract revision. */
  contractDigest: string;
  capability: string;
  /** Canonical major version. Integer, as everywhere in AppPort; never SemVer. */
  version: number;
  /** `capabilityDigest` of that capability version. */
  capabilityDigest: string;
}

/** What one environment resolved a dependency to. Environment-specific: never portable. */
export interface LockedResolution {
  /** The provider application, and its own capability version: what invocation targets. */
  provider: { application: string; capability: { name: string; version: number } };
  /** The registration incarnation that was selected. Ephemeral: not a package or product identity. */
  registration: { registrationId: string; fingerprint: string; revision: number };
  /** The contract registry's revision counter when resolved (`contractDigest` is the portable pin). */
  contractRevision: number;
  /** The claim that made the provider eligible, by digest, and its evaluation. Only `valid` is ever locked. */
  fulfillment: { claim: string; status: "valid"; compatible: boolean };
}

export interface RecipeLockEntry {
  /** The declared dependency id. */
  id: string;
  /** The dependency as the recipe declares it. */
  declared: Dependency;
  canonical: LockedCanonical;
  resolution?: LockedResolution;
}

export interface RecipeLock {
  format: typeof RECIPE_LOCK_FORMAT;
  /** The recipe the lock belongs to, and the digest of its declared dependencies (`requires`). */
  recipe: { id: string; requires: string };
  /** One entry per declared dependency, sorted by id. */
  dependencies: RecipeLockEntry[];
}

/** The part of `@appport/core`'s `ResolvedDependency` a lock reads; core's published record satisfies it. */
export interface ResolvedDependencyRecord {
  dependency: Dependency;
  target:
    | { kind: "canonical"; contract: string; contractRevision: number; contractDigest: string; capability: string; version: number; capabilityDigest: string; versionConstraint: string }
    | { kind: "application"; capability: string; versionConstraint: string; application?: string };
  provider: { application: string; registrationId: string; fingerprint: string; revision: number; capability: { name: string; version: number } };
  /** The lock records only the claim's digest. */
  fulfillment?: { claim: FulfillmentClaim; status: FulfillmentStatus; compatible: boolean };
}

export class RecipeLockError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Cannot lock the recipe: ${problems.join("; ")}`);
    this.name = "RecipeLockError";
  }
}

/** The digest a lock pins the recipe's declared dependencies with. Editing steps does not change it. */
export function requiresDigest(recipe: Pick<RecipeSource, "requires">): string {
  return digestOf(recipe.requires);
}

/** The canonical versions a declared dependency accepts, from a contract. */
function acceptedVersions(dependency: Dependency, contract: AppPortManifest): number[] {
  if (!isCanonicalDependencyTarget(dependency.target)) return [];
  const ref = parseDependencyRef(dependency.target.capability);
  if (!ref) return [];
  return (contract.capabilities.find((c) => c.name === ref.name)?.definitions ?? [])
    .map((d) => d.version)
    .filter((v) => (ref.version !== undefined ? v === ref.version : satisfiesVersionConstraint(v, dependency.versionConstraint ?? "")));
}

/**
 * Locks a recipe's dependencies against the given canonical contracts and, optionally, an environment's resolutions.
 * Without resolutions the lock is portable. With one, it must be for the same canonical capability and revision, and
 * its fulfillment must be valid.
 *
 * @throws RecipeLockError listing every dependency that cannot be locked.
 */
export function createRecipeLock(
  recipe: RecipeSource,
  options: { contracts: Readonly<Record<string, AppPortManifest | undefined>>; resolutions?: Readonly<Record<string, ResolvedDependencyRecord | undefined>> }
): RecipeLock {
  const problems: string[] = [];
  const entries: RecipeLockEntry[] = [];
  for (const declared of recipe.requires) {
    if (!isCanonicalDependencyTarget(declared.target)) {
      problems.push(`${declared.id}: not a canonical dependency`);
      continue;
    }
    const ref = parseDependencyRef(declared.target.capability);
    const contract = options.contracts[declared.target.contract];
    if (!ref || !contract || !isCanonicalContract(contract)) {
      problems.push(`${declared.id}: canonical contract ${declared.target.contract} is not available`);
      continue;
    }
    const resolved = options.resolutions?.[declared.id];
    const versions = acceptedVersions(declared, contract);
    const version = resolved?.target.kind === "canonical" ? resolved.target.version : Math.max(...versions);
    if (!versions.includes(version)) {
      problems.push(`${declared.id}: ${declared.target.contract} defines no accepted version of ${ref.name}${resolved ? ` (resolved ${version})` : ""}`);
      continue;
    }
    const canonical: LockedCanonical = {
      contract: declared.target.contract,
      contractDigest: contractDigest(contract),
      capability: ref.name,
      version,
      capabilityDigest: capabilityDigest(contract, ref.name, version)!
    };
    const entry: RecipeLockEntry = { id: declared.id, declared: structuredClone(declared), canonical };
    if (resolved) {
      const problem = resolutionProblem(canonical, resolved);
      if (problem) {
        problems.push(`${declared.id}: ${problem}`);
        continue;
      }
      entry.resolution = toResolution(resolved);
    }
    entries.push(entry);
  }
  if (problems.length) throw new RecipeLockError(problems);
  return {
    format: RECIPE_LOCK_FORMAT,
    recipe: { id: recipe.id, requires: requiresDigest(recipe) },
    dependencies: entries.sort((a, b) => a.id.localeCompare(b.id))
  };
}

/** Why a resolution cannot satisfy a locked canonical identity, or undefined when it can. */
function resolutionProblem(canonical: LockedCanonical, resolved: ResolvedDependencyRecord): string | undefined {
  const t = resolved.target;
  if (t.kind !== "canonical") return "the resolution is of an application dependency, not a canonical one";
  if (t.contract !== canonical.contract || t.capability !== canonical.capability || t.version !== canonical.version) {
    return `the resolution is for ${t.contract} ${t.capability}@${t.version}, not ${canonical.contract} ${canonical.capability}@${canonical.version}`;
  }
  if (t.contractDigest !== canonical.contractDigest) return "the resolution evaluated a different contract revision; re-resolve against the current one";
  if (t.capabilityDigest !== canonical.capabilityDigest) return "the resolution evaluated a different capability revision";
  if (!resolved.fulfillment || resolved.fulfillment.status !== "valid") return `the fulfillment is ${resolved.fulfillment?.status ?? "missing"}, and only a valid fulfillment can satisfy a canonical dependency`;
  return undefined;
}

function toResolution(resolved: ResolvedDependencyRecord): LockedResolution {
  const t = resolved.target as Extract<ResolvedDependencyRecord["target"], { kind: "canonical" }>;
  return {
    provider: { application: resolved.provider.application, capability: { name: resolved.provider.capability.name, version: resolved.provider.capability.version } },
    registration: { registrationId: resolved.provider.registrationId, fingerprint: resolved.provider.fingerprint, revision: resolved.provider.revision },
    contractRevision: t.contractRevision,
    fulfillment: { claim: digestOf(resolved.fulfillment!.claim), status: "valid", compatible: resolved.fulfillment!.compatible }
  };
}

/** The lock without environment-specific resolutions: what a package carries. */
export function portableLock(lock: RecipeLock): RecipeLock {
  return { ...lock, dependencies: lock.dependencies.map(({ resolution: _resolution, ...entry }) => structuredClone(entry)) };
}

/**
 * Replaces one dependency's provider. Explicit by construction: the new resolution must be for the same canonical
 * capability at the same contract and capability digests, with a valid fulfillment. A different canonical revision is
 * not a substitution: the recipe must be revalidated and relocked.
 *
 * @throws RecipeLockError when the resolution cannot satisfy the locked canonical requirement.
 */
export function substituteProvider(lock: RecipeLock, dependencyId: string, resolved: ResolvedDependencyRecord): RecipeLock {
  const entry = lock.dependencies.find((d) => d.id === dependencyId);
  if (!entry) throw new RecipeLockError([`${dependencyId}: not locked`]);
  const problem = resolutionProblem(entry.canonical, resolved);
  if (problem) throw new RecipeLockError([`${dependencyId}: ${problem}`]);
  return { ...lock, dependencies: lock.dependencies.map((d) => (d.id === dependencyId ? { ...structuredClone(d), resolution: toResolution(resolved) } : structuredClone(d))) };
}

/** What a lock finding asks for. */
export type LockAction =
  /** The recipe's declared dependencies changed: create a new lock. */
  | "regenerate"
  /** The canonical contract changed: revalidate the recipe against it, then relock. */
  | "revalidate"
  /** The provider registration changed or disappeared: resolve again and check the fulfillment. */
  | "re-resolve";

export interface RecipeLockFinding {
  code:
    | "LOCK_FORMAT"
    | "LOCK_RECIPE_MISMATCH"
    | "LOCK_DECLARATIONS_CHANGED"
    | "LOCK_INCOMPLETE"
    | "LOCK_UNDECLARED"
    | "LOCK_FULFILLMENT_INELIGIBLE"
    | "LOCK_CONTRACT_UNAVAILABLE"
    | "LOCK_CONTRACT_CHANGED"
    | "LOCK_CAPABILITY_CHANGED"
    | "LOCK_PROVIDER_UNAVAILABLE"
    | "LOCK_PROVIDER_CHANGED";
  severity: "error";
  scope: "source" | "environment";
  /** JSON Pointer into the lock. */
  path: string;
  message: string;
  action: LockAction;
}

/** What an environment currently holds, supplied by the caller. Nothing is fetched. */
export interface RecipeLockEnvironment {
  /** Active canonical contracts by id. */
  contracts?: Readonly<Record<string, AppPortManifest | undefined>>;
  /** Current provider registrations by application id. */
  providers?: Readonly<Record<string, { registrationId: string; fingerprint: string; status: string } | undefined>>;
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Checks a lock against its recipe and, when given, an environment. Valid only when there are no findings.
 *
 * - The recipe's declared dependencies changed (`requires` digest): regenerate.
 * - A contract's `contractDigest` changed: revalidate, even when the locked capability's own digest did not, because a
 *   fulfillment also depends on other capabilities of the contract (probes). A changed `capabilityDigest` makes claims
 *   pinned to the old revision stale.
 * - A provider registration changed (registration id or fingerprint) or was retired: resolve again. The recipe source
 *   itself is not invalidated by this.
 */
export function checkRecipeLock(lock: unknown, recipe: RecipeSource, environment?: RecipeLockEnvironment): { ok: boolean; findings: RecipeLockFinding[] } {
  const findings: RecipeLockFinding[] = [];
  const add = (code: RecipeLockFinding["code"], path: string, message: string, action: LockAction, scope: "source" | "environment" = "source") =>
    findings.push({ code, severity: "error", scope, path, message, action });
  const done = () => ({ ok: findings.length === 0, findings });

  if (!isPlain(lock) || lock["format"] !== RECIPE_LOCK_FORMAT || !isPlain(lock["recipe"]) || !Array.isArray(lock["dependencies"])) {
    add("LOCK_FORMAT", "", `not an ${RECIPE_LOCK_FORMAT} lock`, "regenerate");
    return done();
  }
  const l = lock as unknown as RecipeLock;
  if (l.recipe.id !== recipe.id) add("LOCK_RECIPE_MISMATCH", "/recipe/id", `the lock is for ${l.recipe.id}, not ${recipe.id}`, "regenerate");
  if (l.recipe.requires !== requiresDigest(recipe)) add("LOCK_DECLARATIONS_CHANGED", "/recipe/requires", "the recipe's declared dependencies changed since the lock was made", "regenerate");
  const declared = new Set(recipe.requires.map((d) => d.id));
  const locked = new Set(l.dependencies.map((d) => d?.id));
  for (const id of declared) if (!locked.has(id)) add("LOCK_INCOMPLETE", "/dependencies", `declared dependency "${id}" is not locked`, "regenerate");

  l.dependencies.forEach((entry, index) => {
    const path = `/dependencies/${index}`;
    if (!isPlain(entry) || !isPlain(entry.canonical) || typeof entry.id !== "string") return void add("LOCK_FORMAT", path, "a lock entry has an id and a canonical identity", "regenerate");
    if (!declared.has(entry.id)) add("LOCK_UNDECLARED", `${path}/id`, `"${entry.id}" is not a declared dependency of the recipe`, "regenerate");
    if (entry.resolution && entry.resolution.fulfillment?.status !== "valid") {
      add("LOCK_FULFILLMENT_INELIGIBLE", `${path}/resolution/fulfillment/status`, "only a valid fulfillment can satisfy a locked canonical dependency", "re-resolve");
    }
    if (!environment) return;
    const contract = environment.contracts?.[entry.canonical.contract];
    if (environment.contracts) {
      if (!contract || !isCanonicalContract(contract)) {
        add("LOCK_CONTRACT_UNAVAILABLE", `${path}/canonical/contract`, `canonical contract ${entry.canonical.contract} is not available`, "revalidate", "environment");
      } else {
        if (capabilityDigest(contract, entry.canonical.capability, entry.canonical.version) !== entry.canonical.capabilityDigest) {
          add("LOCK_CAPABILITY_CHANGED", `${path}/canonical/capabilityDigest`, `${entry.canonical.capability}@${entry.canonical.version} changed; fulfillment claims pinned to the locked revision are stale`, "revalidate", "environment");
        }
        if (contractDigest(contract) !== entry.canonical.contractDigest) {
          add("LOCK_CONTRACT_CHANGED", `${path}/canonical/contractDigest`, `${entry.canonical.contract} is at a different revision than the one locked`, "revalidate", "environment");
        }
      }
    }
    if (entry.resolution && environment.providers) {
      const current = environment.providers[entry.resolution.provider.application];
      if (!current || current.status === "retired") {
        add("LOCK_PROVIDER_UNAVAILABLE", `${path}/resolution/provider`, `provider ${entry.resolution.provider.application} is not registered or is retired`, "re-resolve", "environment");
      } else if (current.registrationId !== entry.resolution.registration.registrationId || current.fingerprint !== entry.resolution.registration.fingerprint) {
        add("LOCK_PROVIDER_CHANGED", `${path}/resolution/registration`, `provider ${entry.resolution.provider.application} was re-registered; the locked resolution must be checked again`, "re-resolve", "environment");
      }
    }
  });
  return done();
}
