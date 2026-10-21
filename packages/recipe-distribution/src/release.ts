/**
 * @appport/recipe-distribution — the boundary between AppWorks recipe packages and Distribution Protocol releases
 * (spec/recipe-1.md §7).
 *
 * Distribution Protocol (`distribution/1`, `@distribution-protocol/protocol` 1.0.0) owns signed immutable releases,
 * registry-independent product identity, artifact digests and sizes, acquisition, publisher trust and receipts. AppWorks
 * owns what is inside the artifact. This package connects the two and nothing more:
 *
 * - {@link recipeReleaseManifest} describes one recipe package as a `distribution/1` release manifest, validated by
 *   Distribution Protocol itself. (`publish.ts` signs and publishes it into a channel.)
 * - {@link acceptAcquiredRecipePackage} runs the consumer-side checks in order on acquired bytes: release signature,
 *   publisher trust (when a policy is given), the signed package binding against the consumer's expectation, artifact
 *   digest and size, and finally the package itself, whose identity is recomputed from the bytes.
 *

 * Fetching, publishing, receipts and installation are in `channel.ts`, `publish.ts`, `acquire.ts` and `install.ts`
 * (spec/distribution-1.md); registries are not implemented. Accepting a package establishes that these bytes are the package
 * a publisher released. It grants no authorization, proves no fulfillment, and establishes no business outcome; a
 * source package is never executable.
 */
import {
  BindingOutcome,
  PROTOCOL_ID,
  TrustOutcome,
  checkArtifactBinding,
  digestOfBytes,
  validateManifest,
  verifyAcquisitionTrust,
  verifyArtifactBytes,
  verifyRelease
} from "@distribution-protocol/protocol";
import {
  RECIPE_PACKAGE_BINDING_SCHEME,
  RECIPE_PACKAGE_MEDIA_TYPE,
  loadRecipePackage,
  recipePackageBinding,
  serializeRecipePackage,
  type RecipePackage,
  type RecipePackageFinding
} from "@appport/recipe";

/** The Distribution Protocol version this adapter is written against. */
export const DISTRIBUTION_PROTOCOL = "distribution/1" as const;

/** A `distribution/1` interface entry. Which kind a recipe declares is an open decision (spec/recipe-1.md §10). */
export interface ReleaseInterface {
  id: string;
  type: "api" | "cli" | "desktop" | "library" | "mobile" | "service" | "stream" | "web";
  capabilities?: string[];
  mediaType?: string;
}

export interface RecipeReleaseOptions {
  /** `product://namespace/slug`: the registry-independent product the recipe is released as. */
  product: { id: string; name: string; version: string };
  /** `publisher://namespace`. */
  publisher: { id: string };
  /** Required by `distribution/1`. No default is chosen on the caller's behalf. */
  interfaces: ReleaseInterface[];
  /** Defaults to `recipe-package`. */
  artifactId?: string;
  permissions?: unknown[];
  requirements?: unknown[];
}

export class RecipeReleaseError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Not a valid ${DISTRIBUTION_PROTOCOL} release manifest: ${problems.join("; ")}`);
    this.name = "RecipeReleaseError";
  }
}

/**
 * The release manifest for one recipe package, and the artifact bytes it describes. The artifact is the package's
 * canonical serialization, for any target, with the media type of a recipe package, its Distribution Protocol digest
 * and size, and one signed binding: `appport/recipe-package/1` → the package digest. The package digest is never the
 * artifact digest.
 *
 * @throws RecipeReleaseError when Distribution Protocol rejects the manifest.
 */
export function recipeReleaseManifest(pkg: RecipePackage, options: RecipeReleaseOptions): { manifest: Record<string, unknown>; bytes: Uint8Array } {
  if (PROTOCOL_ID !== DISTRIBUTION_PROTOCOL) throw new RecipeReleaseError([`installed Distribution Protocol speaks ${PROTOCOL_ID}, not ${DISTRIBUTION_PROTOCOL}`]);
  const bytes = serializeRecipePackage(pkg);
  const manifest = {
    protocol: DISTRIBUTION_PROTOCOL,
    product: { ...options.product },
    publisher: { ...options.publisher },
    artifacts: [
      {
        id: options.artifactId ?? "recipe-package",
        target: { os: "any", arch: "any" },
        mediaType: RECIPE_PACKAGE_MEDIA_TYPE,
        digest: digestOfBytes(bytes),
        size: bytes.byteLength,
        bindings: [recipePackageBinding(pkg)]
      }
    ],
    interfaces: options.interfaces.map((i) => ({ ...i })),
    permissions: [...(options.permissions ?? [])],
    requirements: [...(options.requirements ?? [])]
  };
  const errors = validateManifest(manifest);
  if (errors.length) throw new RecipeReleaseError(errors.map((e) => `${e.path || "/"}: ${e.message}`));
  return { manifest, bytes };
}

export type AcceptanceStage = "release" | "trust" | "binding" | "artifact" | "package" | "accepted";

export interface RecipePackageAcceptance {
  /** Every check that ran passed, and the package is the one expected. */
  ok: boolean;
  /** The first check that failed, or `accepted`. */
  stage: AcceptanceStage;
  reason?: string;
  /** `verified` only when a trust policy was given and accepted the publisher. */
  publisherTrust: "verified" | "not-evaluated";
  /**
   * `ok` and publisher trust verified. Distribution Protocol requires trust to be evaluated before an artifact is
   * installed; without a policy, a package can be inspected but is not installable.
   */
  installable: boolean;
  /** Always false: a source package is not executable, and acceptance authorizes nothing. */
  executable: false;
  package?: RecipePackage;
  identity?: { recipe: string; digest: string };
  findings: RecipePackageFinding[];
}

/**
 * Consumer-side acceptance of acquired recipe-package bytes, in Distribution Protocol's order:
 *
 * 1. the release signature verifies (`verifyRelease`), so nothing unauthenticated is read;
 * 2. with `trust`, the publisher is trusted by the consumer's policy (`verifyAcquisitionTrust`);
 * 3. the release binds the artifact to the package digest the consumer expects (`checkArtifactBinding`), checked
 *    before the bytes are accepted;
 * 4. the bytes match the signed artifact digest (`verifyArtifactBytes`) and size;
 * 5. the bytes are that package: format, recomputed digest against the signed binding and the expectation, embedded
 *    recipe and lock (`loadRecipePackage`).
 *
 * The expectation (`expect.digest`, and optionally `expect.recipe`) comes from the consumer, never from the release.
 */
export function acceptAcquiredRecipePackage(input: {
  release: { manifest?: { artifacts?: Array<{ id: string; digest: string; size?: number }> } };
  artifactId: string;
  bytes: Uint8Array;
  expect: { digest: string; recipe?: string };
  trust?: { documents: unknown[]; policy: unknown };
}): RecipePackageAcceptance {
  const refuse = (stage: AcceptanceStage, reason: string, extra: Partial<RecipePackageAcceptance> = {}): RecipePackageAcceptance => ({
    ok: false,
    stage,
    reason,
    publisherTrust: "not-evaluated",
    installable: false,
    executable: false,
    findings: [],
    ...extra
  });

  const signature = verifyRelease(input.release);
  if (!signature.valid) return refuse("release", `the release does not verify: ${signature.reason}`);

  let publisherTrust: RecipePackageAcceptance["publisherTrust"] = "not-evaluated";
  if (input.trust) {
    const trust = verifyAcquisitionTrust({ release: input.release, documents: input.trust.documents, policy: input.trust.policy });
    if (trust.outcome !== TrustOutcome.VALID) return refuse("trust", `the publisher is not trusted: ${trust.outcome}${trust.reason ? ` (${trust.reason})` : ""}`);
    publisherTrust = "verified";
  }

  const binding = checkArtifactBinding({ release: input.release, artifactId: input.artifactId, scheme: RECIPE_PACKAGE_BINDING_SCHEME, expected: input.expect.digest });
  if (binding.outcome !== BindingOutcome.VERIFIED) return refuse("binding", `${binding.outcome}: ${binding.reason ?? "the signed binding does not match the expected package"}`, { publisherTrust });

  const artifact = input.release.manifest!.artifacts!.find((a) => a.id === input.artifactId)!;
  if (!verifyArtifactBytes(input.bytes, artifact)) return refuse("artifact", "the bytes do not match the signed artifact digest", { publisherTrust });
  if (artifact.size !== undefined && artifact.size !== input.bytes.byteLength) return refuse("artifact", `the artifact is ${input.bytes.byteLength} bytes, the release signed ${artifact.size}`, { publisherTrust });

  const loaded = loadRecipePackage(input.bytes, { binding: binding.actual!, digest: input.expect.digest, ...(input.expect.recipe ? { recipe: input.expect.recipe } : {}) });
  if (!loaded.ok) return refuse("package", "the bytes are not the expected recipe package", { publisherTrust, findings: loaded.findings, ...(loaded.identity ? { identity: loaded.identity } : {}) });

  return {
    ok: true,
    stage: "accepted",
    publisherTrust,
    installable: publisherTrust === "verified",
    executable: false,
    package: loaded.package!,
    identity: loaded.identity!,
    findings: []
  };
}
