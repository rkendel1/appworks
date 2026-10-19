/**
 * `appport.recipe-lock/1` and `appport.recipe-package/1` (spec/recipe-1.md §5–§8).
 */
import { describe, expect, it } from "vitest";
import { canonicalize, contractDigest, digestOf, sha256 } from "@appport/protocol";
import {
  RECIPE_PACKAGE_BINDING_SCHEME,
  RecipeLockError,
  RecipePackageError,
  checkRecipeLock,
  createRecipeLock,
  createRecipePackage,
  loadRecipePackage,
  portableLock,
  recipePackageBinding,
  recipePackageDigest,
  recipePackageIdentity,
  serializeRecipePackage,
  substituteProvider,
  type RecipeSource,
  type ResolvedDependencyRecord
} from "../src/index.js";
import { CONTRACT, accountingContract, claimFor, example } from "./fixtures.js";

const contracts = (contract = accountingContract()) => ({ [CONTRACT]: contract });

/** A resolution as AppPort `@appport/core`'s `resolvedDependency()` produces it (AppPort `spec/fulfillment-1.md` §5.2). */
function resolution(recipe: RecipeSource, id: string, options: { provider?: string; registrationId?: string; contract?: ReturnType<typeof accountingContract>; status?: "valid" | "stale" } = {}): ResolvedDependencyRecord {
  const contract = options.contract ?? accountingContract();
  const declared = recipe.requires.find((d) => d.id === id)!;
  const name = (declared.target as { capability: string }).capability;
  const claim = claimFor(contract, name, 1);
  return {
    dependency: declared,
    target: { kind: "canonical", contract: CONTRACT, contractRevision: 3, contractDigest: contractDigest(contract), capability: name, version: 1, capabilityDigest: claim.digest, versionConstraint: "^1" },
    provider: { application: options.provider ?? "com.acme.erp", registrationId: options.registrationId ?? "reg_1", fingerprint: "f".repeat(64), revision: 1, capability: { name: `ap.${name.split(".")[1]}`, version: 2 } },
    fulfillment: { claim, status: options.status ?? "valid", compatible: true }
  };
}
const resolutions = (recipe: RecipeSource, options: Parameters<typeof resolution>[2] = {}) =>
  Object.fromEntries(recipe.requires.map((d) => [d.id, resolution(recipe, d.id, options)]));

describe("dependency lock", () => {
  it("records the declared requirement, the portable canonical identity and the environment resolution separately", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) });
    const entry = lock.dependencies.find((d) => d.id === "submit-invoice")!;
    expect(entry.declared).toEqual(recipe.requires[1]);
    expect(entry.canonical).toEqual({
      contract: CONTRACT,
      contractDigest: contractDigest(accountingContract()),
      capability: "invoice.submit",
      version: 1,
      capabilityDigest: claimFor(accountingContract(), "invoice.submit", 1).digest
    });
    // The provider's own capability is kept apart from the canonical one.
    expect(entry.resolution).toEqual({
      provider: { application: "com.acme.erp", capability: { name: "ap.submit", version: 2 } },
      registration: { registrationId: "reg_1", fingerprint: "f".repeat(64), revision: 1 },
      contractRevision: 3,
      fulfillment: { claim: digestOf(claimFor(accountingContract(), "invoice.submit", 1)), status: "valid", compatible: true }
    });
    expect(lock.dependencies.map((d) => d.id)).toEqual(["find-duplicate", "get-invoice", "submit-invoice"]);
    // Contracts are referenced by digest, not copied in.
    expect(canonicalize(lock)).not.toContain("inputSchema");
    expect(checkRecipeLock(lock, recipe, { contracts: contracts() })).toEqual({ ok: true, findings: [] });
  });

  it("can be portable: canonical identities only, no environment resolution", () => {
    const recipe = example();
    const portable = portableLock(createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) }));
    expect(portable).toEqual(createRecipeLock(recipe, { contracts: contracts() }));
    expect(portable.dependencies.every((d) => !("resolution" in d))).toBe(true);
  });

  it("never locks a stale, invalid or mismatched resolution", () => {
    const recipe = example();
    expect(() => createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe, { status: "stale" }) })).toThrow(/only a valid fulfillment can satisfy/);
    const old = accountingContract({ description: "an earlier revision" });
    expect(() => createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe, { contract: old }) })).toThrow(RecipeLockError);
    expect(() => createRecipeLock(recipe, { contracts: {} })).toThrow(/org.example.accounting is not available/);
  });

  it("refuses a resolution made against another contract revision, even when the locked capability itself is unchanged", () => {
    const recipe = example();
    // Revise only invoice.duplicate: invoice.submit keeps its capability digest, the contract digest changes.
    const resolvedAgainst = accountingContract();
    (resolvedAgainst.capabilities[0] as { description?: string }).description = "an earlier wording";
    const stale = resolution(recipe, "submit-invoice", { contract: resolvedAgainst });
    expect(stale.target.kind === "canonical" && stale.target.capabilityDigest).toBe(claimFor(accountingContract(), "invoice.submit", 1).digest);
    expect(() => createRecipeLock(recipe, { contracts: contracts(), resolutions: { "submit-invoice": stale } })).toThrow(/evaluated a different contract revision/);
  });

  it("a changed contract or capability digest requires revalidation", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts() });
    const revised = accountingContract({ description: "Record an invoice (clarified)" });
    const findings = checkRecipeLock(lock, recipe, { contracts: contracts(revised) }).findings;
    // Only invoice.submit changed, but the whole contract revision changed for every dependency on it.
    expect(findings.filter((f) => f.code === "LOCK_CAPABILITY_CHANGED").map((f) => f.path)).toEqual([`/dependencies/2/canonical/capabilityDigest`]);
    expect(findings.filter((f) => f.code === "LOCK_CONTRACT_CHANGED")).toHaveLength(3);
    expect(new Set(findings.map((f) => f.action))).toEqual(new Set(["revalidate"]));
  });

  it("a provider registration change requires the resolution to be checked again, without touching the source", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) });
    const providers = (registrationId: string, status = "active") => ({ "com.acme.erp": { registrationId, fingerprint: "f".repeat(64), status } });
    expect(checkRecipeLock(lock, recipe, { providers: providers("reg_1") }).ok).toBe(true);
    const changed = checkRecipeLock(lock, recipe, { providers: providers("reg_2") });
    expect(changed.findings.map((f) => [f.code, f.action, f.scope])).toEqual(Array(3).fill(["LOCK_PROVIDER_CHANGED", "re-resolve", "environment"]));
    expect(checkRecipeLock(lock, recipe, { providers: providers("reg_1", "retired") }).findings.map((f) => f.code)).toEqual(Array(3).fill("LOCK_PROVIDER_UNAVAILABLE"));
    expect(checkRecipeLock(portableLock(lock), recipe, { providers: providers("reg_2") }).ok).toBe(true);
  });

  it("changed declarations require a new lock; step edits do not", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts() });
    const edited = example();
    edited.steps[0]!.description = "Reworded";
    expect(checkRecipeLock(lock, edited).ok).toBe(true);
    const redeclared = example();
    redeclared.requires[1]!.versionConstraint = "^2";
    expect(checkRecipeLock(lock, redeclared).findings.map((f) => [f.code, f.action])).toEqual([["LOCK_DECLARATIONS_CHANGED", "regenerate"]]);
  });

  it("a stale or invalid fulfillment written into a lock by hand is refused", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) });
    (lock.dependencies[0]!.resolution!.fulfillment as { status: string }).status = "stale";
    expect(checkRecipeLock(lock, recipe).findings.map((f) => f.code)).toEqual(["LOCK_FULFILLMENT_INELIGIBLE"]);
  });

  it("substitutes a provider only explicitly, and only with a valid fulfillment of the same canonical revision", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) });
    const next = substituteProvider(lock, "submit-invoice", resolution(recipe, "submit-invoice", { provider: "com.globex.erp", registrationId: "reg_9" }));
    expect(next.dependencies.find((d) => d.id === "submit-invoice")?.resolution?.provider.application).toBe("com.globex.erp");
    expect(next.dependencies.find((d) => d.id === "get-invoice")?.resolution?.provider.application).toBe("com.acme.erp");
    expect(() => substituteProvider(lock, "submit-invoice", resolution(recipe, "submit-invoice", { status: "stale" }))).toThrow(/only a valid fulfillment/);
    expect(() => substituteProvider(lock, "submit-invoice", resolution(recipe, "get-invoice"))).toThrow(/not org.example.accounting invoice.submit@1/);
  });

  it("carries no authority: there is nothing in it a runtime could treat as a grant", () => {
    const recipe = example();
    const text = canonicalize(createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) }));
    expect(text).not.toMatch(/grant|scope|permission|authoriz|token|credential/i);
  });
});

describe("recipe package", () => {
  const build = () => {
    const recipe = example();
    return createRecipePackage(recipe, createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) }), { provenance: { tool: "appport-test" } });
  };

  it("is deterministic: same content, same digest, independent of member order and encoding", () => {
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(recipePackageDigest(a));
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(a).reverse()), null, 2);
    expect(loadRecipePackage(reordered).identity?.digest).toBe(a.digest);
  });

  it("carries a portable lock, the contract revisions it names, and the roles it needs", () => {
    const pkg = build();
    expect(pkg.kind).toBe("source");
    expect(pkg.lock.dependencies.every((d) => !("resolution" in d))).toBe(true);
    expect(pkg.contracts).toEqual([{ id: CONTRACT, digest: contractDigest(accountingContract()) }]);
    expect(pkg.requirements).toEqual({ roles: ["role:ap-manager"] });
    expect(pkg.validation).toEqual({ format: "appport.recipe-validation/1", sourceOk: true, warnings: [] });
  });

  it("is never executable, and a compiled package is refused rather than mistaken for one", () => {
    const pkg = build();
    const loaded = loadRecipePackage(serializeRecipePackage(pkg));
    expect(loaded).toMatchObject({ ok: true, executable: false });
    const compiled = { ...pkg, kind: "compiled" };
    const refused = loadRecipePackage(JSON.stringify({ ...compiled, digest: recipePackageDigest(compiled as never) }));
    expect(refused).toMatchObject({ ok: false, executable: false });
    expect(refused.findings.map((f) => f.code)).toEqual(["PACKAGE_KIND_UNSUPPORTED"]);
  });

  it("has an identity with no registry or location in it", () => {
    const pkg = build();
    expect(recipePackageIdentity(pkg)).toEqual({ recipe: "org.example.recipes.supplier-invoice", digest: pkg.digest });
    // Provenance names where the source is maintained; it is content, and changing it changes the digest, not the recipe identity.
    const moved = createRecipePackage(example(), pkg.lock, { provenance: { tool: "appport-test", source: { repository: "https://mirror.example.net/recipes" } } });
    expect(recipePackageIdentity(moved).recipe).toBe(recipePackageIdentity(pkg).recipe);
    expect(JSON.stringify(recipePackageIdentity(pkg))).not.toMatch(/https?:|registry|product:\/\//);
  });

  it("keeps the package digest, the artifact digest and the binding distinct", () => {
    const pkg = build();
    const bytes = serializeRecipePackage(pkg);
    const artifactDigest = `sha256:${sha256(new TextDecoder().decode(bytes))}`;
    expect(artifactDigest).not.toBe(pkg.digest);
    expect(recipePackageBinding(pkg)).toEqual({ scheme: RECIPE_PACKAGE_BINDING_SCHEME, value: pkg.digest });
    // A loader recomputes the identity from the bytes; it never trusts the artifact digest or the stated digest for it.
    expect(loadRecipePackage(bytes, { binding: pkg.digest, digest: pkg.digest, recipe: pkg.recipe.id }).ok).toBe(true);
    expect(loadRecipePackage(bytes, { binding: artifactDigest }).findings.map((f) => f.code)).toEqual(["PACKAGE_BINDING_MISMATCH"]);
  });

  it("detects altered content, a false digest and an unexpected package", () => {
    const pkg = build();
    const tampered = structuredClone(pkg);
    (tampered.recipe.steps[3] as { cases: Array<{ when: unknown }> }).cases[0]!.when = { value: false };
    expect(loadRecipePackage(JSON.stringify(tampered)).findings.map((f) => f.code)).toEqual(["PACKAGE_DIGEST_MISMATCH"]);
    expect(loadRecipePackage(JSON.stringify(pkg), { recipe: "org.example.recipes.other" }).findings.map((f) => f.code)).toEqual(["PACKAGE_RECIPE_MISMATCH"]);
    expect(loadRecipePackage(JSON.stringify(pkg), { digest: "sha256:" + "0".repeat(64) }).findings.map((f) => f.code)).toEqual(["PACKAGE_EXPECTATION_MISMATCH"]);
    expect(loadRecipePackage(new Uint8Array([0xff, 0xfe])).findings.map((f) => f.code)).toEqual(["PACKAGE_FORMAT"]);
    expect(loadRecipePackage(JSON.stringify({ ...pkg, signature: "x" })).findings.map((f) => f.code)).toEqual(["PACKAGE_FORMAT"]);
  });

  it("refuses an environment-specific lock, even with a correct digest", () => {
    const recipe = example();
    const pkg = build();
    const withResolution = { ...pkg, lock: createRecipeLock(recipe, { contracts: contracts(), resolutions: resolutions(recipe) }) };
    const restamped = { ...withResolution, digest: recipePackageDigest(withResolution) };
    expect(loadRecipePackage(JSON.stringify(restamped)).findings.map((f) => f.code)).toEqual(["PACKAGE_LOCK_NOT_PORTABLE"]);
  });

  it("cannot be built from invalid source", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts() });
    recipe.steps[5] = { ...recipe.steps[5]!, on: { success: "submitted", failure: "submission-failed" } } as never;
    expect(() => createRecipePackage(recipe, lock)).toThrow(RecipePackageError);
  });
});
