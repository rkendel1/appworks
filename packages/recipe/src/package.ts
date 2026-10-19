/**
 * Recipe packages: `appport.recipe-package/1` (spec/recipe-1.md §6–§8).
 *
 * A package is one immutable, self-describing JSON document: the recipe source, its portable dependency lock, the
 * canonical contract revisions it was locked against, what the receiving environment must provide, and provenance.
 *
 * Identities, kept apart:
 * - **recipe identity** (`recipe.id`): the business identity of the logical recipe, shared by all its releases;
 * - **package digest** (`digest`): `digestOf` the package without its `digest` member. Identifies one exact package
 *   content, independently of how it is encoded, where it is stored or which registry serves it;
 * - **distribution identity**: a Distribution Protocol product and release (`product://ns/slug@1.2.0`), signed by a
 *   publisher. Release lineage and versioning belong there, not here: a package mints no release identity of its own;
 * - **artifact digest**: Distribution Protocol's digest of the distributed bytes. It identifies bytes, never a package,
 *   and is never derived from or substituted for the package digest.
 *
 * `kind: "source"` is the only kind defined. A source package is not executable: there is no compiler yet, and the
 * reserved `compiled` kind is refused by this reader rather than mistaken for something that can run.
 *
 * Nothing here talks to a registry, verifies a signature, or grants authority.
 */
import { canonicalize, digestOf, isDigest } from "@appport/protocol";
import { checkRecipeLock, portableLock, type RecipeLock, type RecipeLockFinding } from "./lock.js";
import { validateRecipe, type RecipeValidation } from "./validate.js";
import type { RecipeSource } from "./source.js";

export const RECIPE_PACKAGE_FORMAT = "appport.recipe-package/1" as const;
/** Media type of a distributed recipe package artifact. */
export const RECIPE_PACKAGE_MEDIA_TYPE = "application/vnd.appport.recipe-package+json" as const;
/**
 * Distribution Protocol identity-binding scheme for a recipe package. Its value is the package digest. A publisher's
 * signed binding is a claim; a consumer recomputes the digest from the acquired bytes with {@link loadRecipePackage}.
 */
export const RECIPE_PACKAGE_BINDING_SCHEME = "appport/recipe-package/1" as const;
export const RECIPE_VALIDATION_SUMMARY = "appport.recipe-validation/1" as const;
/** Package kinds this reader knows. `compiled` is reserved for a future compiler and refused. */
export const RECIPE_PACKAGE_KINDS = ["source"] as const;
export const RESERVED_PACKAGE_KINDS = ["compiled"] as const;

export interface RecipePackage {
  format: typeof RECIPE_PACKAGE_FORMAT;
  kind: "source";
  recipe: RecipeSource;
  /** Portable: canonical identities only, no environment resolutions. */
  lock: RecipeLock;
  /** The canonical contract revisions the lock names, by id and `contractDigest`, sorted. */
  contracts: Array<{ id: string; digest: string }>;
  /** What the receiving environment must provide besides the contracts: the roles human tasks are assigned to. */
  requirements: { roles: string[] };
  /** Who and what produced the package. Descriptive and covered by the digest; never a trust claim. */
  provenance?: { tool?: string; authors?: string[]; source?: { repository?: string; path?: string; revision?: string } };
  /**
   * The source validation the packager ran. Informational only: a consumer MUST validate again, because the result
   * depends on the validator, and in the receiving environment on contracts this package does not carry.
   */
  validation: { format: typeof RECIPE_VALIDATION_SUMMARY; sourceOk: true; warnings: string[] };
  /** `digestOf` this document without `digest`. */
  digest: string;
}

const MEMBERS = ["format", "kind", "recipe", "lock", "contracts", "requirements", "provenance", "validation", "digest"];

export class RecipePackageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Cannot package the recipe: ${problems.join("; ")}`);
    this.name = "RecipePackageError";
  }
}

/** The content digest of a package: canonical JSON (RFC 8785) of every member except `digest`, SHA-256. */
export function recipePackageDigest(pkg: Omit<RecipePackage, "digest"> | RecipePackage): string {
  const { digest: _digest, ...content } = pkg as RecipePackage;
  return digestOf(content);
}

/**
 * Builds a source package. The recipe must pass source validation and the lock must belong to it; the lock is made
 * portable. Deterministic: the same inputs give the same package and digest.
 *
 * @throws RecipePackageError on source errors or a lock that does not belong to the recipe.
 */
export function createRecipePackage(recipe: RecipeSource, lock: RecipeLock, options: { provenance?: RecipePackage["provenance"] } = {}): RecipePackage {
  const validation = validateRecipe(recipe);
  const problems = validation.findings.filter((f) => f.severity === "error").map((f) => `${f.code} at ${f.path || "/"}: ${f.message}`);
  const portable = portableLock(lock);
  problems.push(...checkRecipeLock(portable, recipe).findings.map((f) => `${f.code} at lock${f.path}: ${f.message}`));
  if (problems.length) throw new RecipePackageError(problems);
  const content: Omit<RecipePackage, "digest"> = {
    format: RECIPE_PACKAGE_FORMAT,
    kind: "source",
    recipe: structuredClone(recipe),
    lock: portable,
    contracts: contractsOf(portable),
    requirements: { roles: rolesOf(recipe) },
    ...(options.provenance ? { provenance: structuredClone(options.provenance) } : {}),
    validation: { format: RECIPE_VALIDATION_SUMMARY, sourceOk: true, warnings: [...new Set(validation.findings.map((f) => f.code))].sort() }
  };
  return { ...content, digest: recipePackageDigest(content) };
}

function contractsOf(lock: RecipeLock): Array<{ id: string; digest: string }> {
  const byId = new Map<string, string>();
  for (const entry of lock.dependencies) byId.set(entry.canonical.contract, entry.canonical.contractDigest);
  return [...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, digest]) => ({ id, digest }));
}

function rolesOf(recipe: RecipeSource): string[] {
  return [...new Set(recipe.steps.flatMap((s) => (s.kind === "task" && typeof s.assignee?.role === "string" ? [s.assignee.role] : [])))].sort();
}

/** The bytes to distribute: the package's canonical JSON, UTF-8. Their SHA-256 is the artifact digest, not the package digest. */
export function serializeRecipePackage(pkg: RecipePackage): Uint8Array {
  return new TextEncoder().encode(canonicalize(pkg));
}

/** The identity a consumer pins: the logical recipe and the exact package content. Contains no registry or location. */
export function recipePackageIdentity(pkg: Pick<RecipePackage, "recipe" | "digest">): { recipe: string; digest: string } {
  return { recipe: pkg.recipe.id, digest: pkg.digest };
}

/** The Distribution Protocol artifact binding a publisher signs for this package. */
export function recipePackageBinding(pkg: Pick<RecipePackage, "digest">): { scheme: typeof RECIPE_PACKAGE_BINDING_SCHEME; value: string } {
  return { scheme: RECIPE_PACKAGE_BINDING_SCHEME, value: pkg.digest };
}

export interface RecipePackageFinding {
  code:
    | "PACKAGE_FORMAT"
    | "PACKAGE_KIND_UNSUPPORTED"
    | "PACKAGE_DIGEST_MISMATCH"
    | "PACKAGE_BINDING_MISMATCH"
    | "PACKAGE_EXPECTATION_MISMATCH"
    | "PACKAGE_RECIPE_MISMATCH"
    | "PACKAGE_RECIPE_INVALID"
    | "PACKAGE_LOCK_INVALID"
    | "PACKAGE_LOCK_NOT_PORTABLE"
    | "PACKAGE_INCONSISTENT";
  path: string;
  message: string;
}

export interface RecipePackageLoad {
  /** The package's own format, identity and source are consistent. Says nothing about trust, environment or authority. */
  ok: boolean;
  package?: RecipePackage;
  /** Recomputed from the content, never read from it. */
  identity?: { recipe: string; digest: string };
  /** Always false in this version: no compiler exists, and a source package is never executable. */
  executable: false;
  findings: RecipePackageFinding[];
  /** The source validation of the embedded recipe, run again here. */
  recipe?: RecipeValidation;
  lock?: { ok: boolean; findings: RecipeLockFinding[] };
}

/**
 * Loads acquired package bytes and checks the package against itself and the caller's expectations. This is the
 * AppPort half of acquisition: run it only after Distribution Protocol has verified the release signature, the
 * consumer's trust policy, and the artifact's digest and size.
 *
 * - `binding`: the value of the release's signed `appport/recipe-package/1` binding, read only from a release that
 *   verified. The package digest is recomputed from the bytes and must equal it: a signed binding is a publisher's
 *   claim, and this is where the claim is checked against the content.
 * - `digest` / `recipe`: what the consumer itself expects (from its own install request or lock).
 *
 * Success establishes only that these bytes are the package they claim to be. It grants no authorization, does not
 * evaluate fulfillment or the environment's contracts (see `validateRecipe` and `checkRecipeLock` with an environment),
 * and establishes nothing about any business outcome.
 */
export function loadRecipePackage(bytes: Uint8Array | string, expect: { binding?: string; digest?: string; recipe?: string } = {}): RecipePackageLoad {
  const findings: RecipePackageFinding[] = [];
  const add = (code: RecipePackageFinding["code"], path: string, message: string) => findings.push({ code, path, message });
  const fail = (): RecipePackageLoad => ({ ok: false, executable: false, findings });

  let value: unknown;
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    add("PACKAGE_FORMAT", "", "the artifact is not UTF-8 JSON");
    return fail();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    add("PACKAGE_FORMAT", "", "a recipe package is a JSON object");
    return fail();
  }
  const doc = value as Record<string, unknown>;
  if (doc["format"] !== RECIPE_PACKAGE_FORMAT) {
    add("PACKAGE_FORMAT", "/format", `format must be ${RECIPE_PACKAGE_FORMAT}`);
    return fail();
  }
  if ((RESERVED_PACKAGE_KINDS as readonly unknown[]).includes(doc["kind"])) {
    add("PACKAGE_KIND_UNSUPPORTED", "/kind", `"${String(doc["kind"])}" packages are reserved; this reader has no compiler and refuses them rather than treating them as executable`);
    return fail();
  }
  if (!(RECIPE_PACKAGE_KINDS as readonly unknown[]).includes(doc["kind"])) {
    add("PACKAGE_FORMAT", "/kind", `kind must be one of ${RECIPE_PACKAGE_KINDS.join(", ")}`);
    return fail();
  }
  for (const key of Object.keys(doc)) if (!MEMBERS.includes(key)) add("PACKAGE_FORMAT", `/${key}`, `unknown member "${key}"; undocumented members are rejected, never ignored`);
  for (const key of ["recipe", "lock", "contracts", "requirements", "validation"]) if (doc[key] === undefined) add("PACKAGE_FORMAT", `/${key}`, `${key} is missing`);
  if (!isDigest(doc["digest"])) add("PACKAGE_FORMAT", "/digest", "digest must be sha256:<64 hex>");
  if (findings.length) return fail();

  const pkg = doc as unknown as RecipePackage;
  const digest = recipePackageDigest(pkg);
  const identity = { recipe: String(pkg.recipe?.id), digest };
  if (pkg.digest !== digest) add("PACKAGE_DIGEST_MISMATCH", "/digest", "the package's stated digest is not the digest of its content");
  if (expect.binding !== undefined && expect.binding !== digest) add("PACKAGE_BINDING_MISMATCH", "/digest", "the signed binding names a different package than these bytes contain");
  if (expect.digest !== undefined && expect.digest !== digest) add("PACKAGE_EXPECTATION_MISMATCH", "/digest", "this is not the package the consumer expected");
  if (expect.recipe !== undefined && expect.recipe !== identity.recipe) add("PACKAGE_RECIPE_MISMATCH", "/recipe/id", `the package holds ${identity.recipe}, not ${expect.recipe}`);

  const recipe = validateRecipe(pkg.recipe);
  if (!recipe.sourceOk) add("PACKAGE_RECIPE_INVALID", "/recipe", "the embedded recipe has source errors");
  const lock = recipe.sourceOk ? checkRecipeLock(pkg.lock, pkg.recipe) : undefined;
  if (lock && !lock.ok) add("PACKAGE_LOCK_INVALID", "/lock", "the lock does not belong to the embedded recipe");
  if (Array.isArray(pkg.lock?.dependencies)) {
    if (pkg.lock.dependencies.some((d) => d && "resolution" in d)) add("PACKAGE_LOCK_NOT_PORTABLE", "/lock", "a package lock carries no environment resolutions: provider registrations belong to one environment");
    if (canonicalize(contractsOf(pkg.lock)) !== canonicalize(pkg.contracts)) add("PACKAGE_INCONSISTENT", "/contracts", "contracts do not match the lock");
  }
  if (recipe.sourceOk && canonicalize({ roles: rolesOf(pkg.recipe) }) !== canonicalize(pkg.requirements)) add("PACKAGE_INCONSISTENT", "/requirements", "requirements do not match the recipe");

  return {
    ok: findings.length === 0,
    ...(findings.length === 0 ? { package: pkg } : {}),
    identity,
    executable: false,
    findings,
    recipe,
    ...(lock ? { lock } : {})
  };
}
