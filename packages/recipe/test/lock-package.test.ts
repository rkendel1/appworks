/**
 * `appport.recipe-lock/1` (portable part) and `appport.recipe-package/1` (spec/recipe-1.md §5–§8).
 *
 * Locks built from real resolutions, and everything about provider evidence, are in `canonical-resolution.test.ts`.
 * No resolution record here is constructed by hand.
 */
import { describe, expect, it } from "vitest";
import { canonicalize, contractDigest, sha256 } from "@appport/protocol";
import {
  RECIPE_PACKAGE_BINDING_SCHEME,
  RecipePackageError,
  checkRecipeLock,
  createRecipeLock,
  createRecipePackage,
  loadRecipePackage,
  recipePackageBinding,
  recipePackageDigest,
  recipePackageIdentity,
  serializeRecipePackage
} from "../src/index.js";
import { CONTRACT, accountingContract, canonicalEnvironment, claimFor, example } from "./fixtures.js";

const contracts = (contract = accountingContract()) => ({ [CONTRACT]: contract });

describe("portable dependency lock", () => {
  it("records each declared requirement with its portable canonical identity, and no environment resolution", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts() });
    const entry = lock.dependencies.find((d) => d.id === "submit-invoice")!;
    expect(entry.declared).toEqual(recipe.requires[1]);
    expect(entry.canonical).toEqual({
      contract: CONTRACT,
      contractDigest: contractDigest(accountingContract()),
      capability: "invoice.submit",
      version: 1,
      capabilityDigest: claimFor(accountingContract(), "invoice.submit", 1).digest
    });
    expect(lock.dependencies.map((d) => d.id)).toEqual(["find-duplicate", "get-invoice", "submit-invoice"]);
    expect(lock.dependencies.every((d) => !("resolution" in d))).toBe(true);
    // Contracts are referenced by digest, not copied in.
    expect(canonicalize(lock)).not.toContain("inputSchema");
    expect(checkRecipeLock(lock, recipe, { contracts: contracts() })).toEqual({ ok: true, findings: [] });
  });

  it("cannot be made without the contract", () => {
    expect(() => createRecipeLock(example(), { contracts: {} })).toThrow(/org.example.accounting is not available/);
  });

  it("a changed contract or capability digest requires revalidation", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: contracts() });
    const revised = accountingContract({ description: "Record an invoice (clarified)" });
    const findings = checkRecipeLock(lock, recipe, { contracts: contracts(revised) }).findings;
    // Only invoice.submit changed, but the whole contract revision changed for every dependency on it.
    expect(findings.filter((f) => f.code === "LOCK_CAPABILITY_CHANGED").map((f) => f.path)).toEqual(["/dependencies/2/canonical/capabilityDigest"]);
    expect(findings.filter((f) => f.code === "LOCK_CONTRACT_CHANGED")).toHaveLength(3);
    expect(new Set(findings.map((f) => f.action))).toEqual(new Set(["revalidate"]));
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
});

describe("recipe package", () => {
  const build = () => {
    const recipe = example();
    return createRecipePackage(recipe, createRecipeLock(recipe, { contracts: contracts() }), { provenance: { tool: "appworks-test" } });
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
    expect(loadRecipePackage(serializeRecipePackage(pkg))).toMatchObject({ ok: true, executable: false });
    const compiled = { ...pkg, kind: "compiled" };
    const refused = loadRecipePackage(JSON.stringify({ ...compiled, digest: recipePackageDigest(compiled as never) }));
    expect(refused).toMatchObject({ ok: false, executable: false });
    expect(refused.findings.map((f) => f.code)).toEqual(["PACKAGE_KIND_UNSUPPORTED"]);
  });

  it("has an identity with no registry or location in it", () => {
    const pkg = build();
    expect(recipePackageIdentity(pkg)).toEqual({ recipe: "org.example.recipes.supplier-invoice", digest: pkg.digest });
    // Provenance is content: changing it changes the digest, not the recipe identity.
    const moved = createRecipePackage(example(), pkg.lock, { provenance: { tool: "appworks-test", source: { repository: "https://mirror.example.net/recipes" } } });
    expect(recipePackageIdentity(moved).recipe).toBe(recipePackageIdentity(pkg).recipe);
    expect(moved.digest).not.toBe(pkg.digest);
    expect(JSON.stringify(recipePackageIdentity(pkg))).not.toMatch(/https?:|registry|product:\/\//);
  });

  it("keeps the package digest, the artifact digest and the binding distinct", () => {
    const pkg = build();
    const bytes = serializeRecipePackage(pkg);
    const artifactDigest = `sha256:${sha256(new TextDecoder().decode(bytes))}`;
    expect(artifactDigest).not.toBe(pkg.digest);
    expect(recipePackageBinding(pkg)).toEqual({ scheme: RECIPE_PACKAGE_BINDING_SCHEME, value: pkg.digest });
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

  it("refuses an environment-specific lock, even with a correct digest, and a package built from one carries none", async () => {
    const recipe = example();
    const env = await canonicalEnvironment();
    const environmentLock = createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    expect(environmentLock.dependencies.every((d) => d.resolution)).toBe(true);
    // A package made from it carries only the portable part.
    expect(createRecipePackage(recipe, environmentLock).lock.dependencies.every((d) => !("resolution" in d))).toBe(true);
    // A package that smuggles the resolutions back in is refused.
    const pkg = build();
    const withResolution = { ...pkg, lock: environmentLock };
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
