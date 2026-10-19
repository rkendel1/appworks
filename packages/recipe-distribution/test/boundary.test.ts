/**
 * The recipe package ↔ Distribution Protocol boundary, against the published `@distribution-protocol/protocol` 1.0.0:
 * real manifests validated by it, real Ed25519 releases signed by it, real binding and digest checks.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTrustPolicy, digestOfBytes, generatePublisherKeypair, signRelease } from "@distribution-protocol/protocol";
import { createRecipeLock, createRecipePackage, recipePackageDigest, serializeRecipePackage, type RecipePackage, type RecipeSource } from "@appport/recipe";
import { RecipeReleaseError, acceptAcquiredRecipePackage, recipeReleaseManifest } from "../src/index.js";
import { CONTRACT, accountingContract } from "../../recipe/test/fixtures.js";

const example = (): RecipeSource => JSON.parse(readFileSync(fileURLToPath(new URL("../../../examples/supplier-invoice/recipe.json", import.meta.url)), "utf8"));
const build = (): RecipePackage => {
  const recipe = example();
  return createRecipePackage(recipe, createRecipeLock(recipe, { contracts: { [CONTRACT]: accountingContract() } }));
};
const options = {
  product: { id: "product://example/supplier-invoice", name: "Supplier invoice recipe", version: "1.0.0" },
  publisher: { id: "publisher://example" },
  interfaces: [{ id: "recipe", type: "library" as const }]
};
const release = (pkg: RecipePackage, manifest = recipeReleaseManifest(pkg, options).manifest) => signRelease(manifest, generatePublisherKeypair().privateKey);

describe("release manifest", () => {
  it("is a valid distribution/1 manifest: one artifact, its byte digest and size, and the signed package binding", () => {
    const pkg = build();
    const { manifest, bytes } = recipeReleaseManifest(pkg, options);
    expect(manifest).toMatchObject({
      protocol: "distribution/1",
      product: options.product,
      artifacts: [{
        id: "recipe-package",
        target: { os: "any", arch: "any" },
        mediaType: "application/vnd.appport.recipe-package+json",
        digest: digestOfBytes(bytes),
        size: bytes.byteLength,
        bindings: [{ scheme: "appport/recipe-package/1", value: pkg.digest }]
      }]
    });
    // Four identities, never one another: recipe, package content, release, bytes.
    const artifact = (manifest["artifacts"] as Array<{ digest: string }>)[0]!;
    expect(artifact.digest).not.toBe(pkg.digest);
    expect(pkg.recipe.id).toBe("org.example.recipes.supplier-invoice");
    expect(options.product.id).not.toContain(pkg.recipe.id);
  });

  it("is rejected by Distribution Protocol's own validation when it is not one", () => {
    // Release versions are SemVer in Distribution Protocol only; canonical capability versions stay integer majors.
    expect(() => recipeReleaseManifest(build(), { ...options, product: { ...options.product, version: "1" } })).toThrow(/malformed semantic version "1"/);
    expect(() => recipeReleaseManifest(build(), { ...options, product: { ...options.product, id: "https://registry.example.org/supplier-invoice" } })).toThrow(RecipeReleaseError);
  });

  it("chooses no interface on the caller's behalf (observed: validateManifest 1.0.0 does not enforce the interface type enum its schema declares)", () => {
    const { manifest } = recipeReleaseManifest(build(), { ...options, interfaces: [{ id: "recipe", type: "recipe" as never }] });
    expect(manifest["interfaces"]).toEqual([{ id: "recipe", type: "recipe" }]);
  });
});

describe("acceptance of acquired bytes", () => {
  it("accepts the expected package from a verified release, without making it installable, executable or authorized", () => {
    const pkg = build();
    const signed = release(pkg);
    const result = acceptAcquiredRecipePackage({ release: signed, artifactId: "recipe-package", bytes: serializeRecipePackage(pkg), expect: { digest: pkg.digest, recipe: pkg.recipe.id } });
    expect(result).toMatchObject({ ok: true, stage: "accepted", publisherTrust: "not-evaluated", installable: false, executable: false, identity: { recipe: pkg.recipe.id, digest: pkg.digest } });
    expect(Object.keys(result).sort()).toEqual(["executable", "findings", "identity", "installable", "ok", "package", "publisherTrust", "stage"]);
  });

  it("refuses an unauthenticated or altered release before reading anything in it", () => {
    const pkg = build();
    const signed = release(pkg);
    const tampered = structuredClone(signed);
    tampered.manifest.product.version = "1.0.1";
    expect(acceptAcquiredRecipePackage({ release: tampered, artifactId: "recipe-package", bytes: serializeRecipePackage(pkg), expect: { digest: pkg.digest } })).toMatchObject({ ok: false, stage: "release" });
  });

  it("refuses a publisher the consumer's trust policy does not trust", () => {
    const pkg = build();
    const result = acceptAcquiredRecipePackage({ release: release(pkg), artifactId: "recipe-package", bytes: serializeRecipePackage(pkg), expect: { digest: pkg.digest }, trust: { documents: [], policy: createTrustPolicy() } });
    expect(result).toMatchObject({ ok: false, stage: "trust", installable: false });
  });

  it("refuses a release whose signed binding is missing or names another package, before accepting the bytes", () => {
    const pkg = build();
    const other = { ...pkg, provenance: { tool: "something else" } };
    const otherPkg = { ...other, digest: recipePackageDigest(other) } as RecipePackage;
    expect(acceptAcquiredRecipePackage({ release: release(pkg), artifactId: "recipe-package", bytes: serializeRecipePackage(pkg), expect: { digest: otherPkg.digest } })).toMatchObject({ ok: false, stage: "binding", reason: expect.stringMatching(/^BINDING_MISMATCH/) });
    const { manifest } = recipeReleaseManifest(pkg, options);
    delete (manifest["artifacts"] as Array<{ bindings?: unknown }>)[0]!.bindings;
    expect(acceptAcquiredRecipePackage({ release: release(pkg, manifest), artifactId: "recipe-package", bytes: serializeRecipePackage(pkg), expect: { digest: pkg.digest } })).toMatchObject({ ok: false, stage: "binding", reason: expect.stringMatching(/^BINDING_MISSING/) });
  });

  it("refuses bytes that do not match the signed artifact digest", () => {
    const pkg = build();
    const bytes = serializeRecipePackage(pkg);
    const altered = new Uint8Array(bytes);
    altered[altered.length - 3] ^= 1;
    expect(acceptAcquiredRecipePackage({ release: release(pkg), artifactId: "recipe-package", bytes: altered, expect: { digest: pkg.digest } })).toMatchObject({ ok: false, stage: "artifact" });
  });

  it("recomputes the package identity: a publisher's signed claim about other content is refused by the loader", () => {
    // The publisher signs a binding and a digest for bytes whose content does not have the bound identity.
    const pkg = build();
    const forged = { ...structuredClone(pkg), digest: pkg.digest };
    forged.recipe.description = "altered after the digest was computed";
    const bytes = new TextEncoder().encode(JSON.stringify(forged));
    const { manifest } = recipeReleaseManifest(pkg, options);
    Object.assign((manifest["artifacts"] as Array<Record<string, unknown>>)[0]!, { digest: digestOfBytes(bytes), size: bytes.byteLength });
    const result = acceptAcquiredRecipePackage({ release: release(pkg, manifest), artifactId: "recipe-package", bytes, expect: { digest: pkg.digest } });
    expect(result).toMatchObject({ ok: false, stage: "package" });
    expect(result.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["PACKAGE_DIGEST_MISMATCH", "PACKAGE_BINDING_MISMATCH", "PACKAGE_EXPECTATION_MISMATCH"]));
  });
});
