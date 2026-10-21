/**
 * Acquisition (spec/distribution-1.md §4): from a channel to bytes that are, provably, the package a trusted publisher released.
 * In Distribution Protocol's order, nothing in a release is read before its signature verifies, no bytes are fetched except
 * against the signed digest, and no bytes are returned until they match it. The consumer supplies what it expects (the package
 * digest); the release never supplies that for it. Success makes the package neither installed, authorized nor executable.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireArtifact, receiptFromAcquisition, validateReceipt, verifyAcquisitionTrust, verifyRelease, TrustOutcome } from "@distribution-protocol/protocol";
import type { RecipePackage } from "@appport/recipe";
import { FileChannel, type SignedRelease } from "./channel.js";
import { acceptAcquiredRecipePackage, type AcceptanceStage, type RecipePackageAcceptance } from "./release.js";

export type AcquireStage = "resolve" | AcceptanceStage;

export interface TrustPolicyInput {
  /** A Distribution Protocol trust policy (`createTrustPolicy`): publishers trusted, anchored by document or pinned key. */
  policy: unknown;
}

export interface AcquireResult {
  ok: boolean;
  /** The first check that failed, or `accepted`. */
  stage: AcquireStage;
  reason?: string;
  /** `verified` only with a policy that anchors the publisher. Without it the package may be inspected, never installed. */
  publisherTrust: "verified" | "not-evaluated";
  installable: boolean;
  /** Always false: acquiring a package authorizes nothing and executes nothing. */
  executable: false;
  release?: SignedRelease;
  package?: RecipePackage;
  bytes?: Uint8Array;
  /** The Distribution Protocol receipt of this acquisition. Evidence of what was verified, not a grant. */
  receipt?: Record<string, any>;
  acceptance?: RecipePackageAcceptance;
  /** Which source served the bytes. */
  source?: string;
}

export function acquireRecipePackage(input: {
  channel: FileChannel;
  product: string;
  version: string;
  /** What the consumer expects: the package digest (from its own pin or out-of-band announcement), optionally the recipe id. */
  expect: { digest: string; recipe?: string };
  trust?: TrustPolicyInput;
  artifactId?: string;
  now?: () => Date;
}): Promise<AcquireResult> {
  return run(input);
}

async function run(input: Parameters<typeof acquireRecipePackage>[0]): Promise<AcquireResult> {
  const artifactId = input.artifactId ?? "recipe-package";
  const refuse = (stage: AcquireStage, reason: string, extra: Partial<AcquireResult> = {}): AcquireResult => ({ ok: false, stage, reason, publisherTrust: "not-evaluated", installable: false, executable: false, ...extra });

  const release = input.channel.readRelease(input.product, input.version) as SignedRelease | undefined;
  if (!release) return refuse("resolve", `${input.product}@${input.version} is not in the channel`);

  // 1. Authenticate the release before reading anything it says (including where its bytes are).
  const signature = verifyRelease(release);
  if (!signature.valid) return refuse("release", `the release does not verify: ${signature.reason}`);
  const artifact = (release.manifest?.artifacts as Array<{ id: string; digest: string; size?: number }> | undefined)?.find((a) => a.id === artifactId);
  if (!artifact) return refuse("artifact", `the release has no artifact ${artifactId}`);

  // 2. Trust, anchored by the consumer's own policy (its result is also recorded in the receipt).
  const documents = input.channel.readLineage(release.manifest!.publisher!.id);
  const trust = input.trust ? verifyAcquisitionTrust({ release, documents, policy: input.trust.policy }) : undefined;
  if (trust && trust.outcome !== TrustOutcome.VALID) return refuse("trust", `the publisher is not trusted: ${trust.outcome}${trust.reason ? ` (${trust.reason})` : ""}`);

  // 3. Fetch against the signed digest; nothing is returned unless it hashes to it.
  // Where the bytes are is the channel's business, derived from its own layout and the signed digest; the release says only which bytes.
  const location = pathToFileURL(join(input.channel.dir, FileChannel.artifactPath(artifact.digest))).href;
  const fetched = await acquireArtifact({ digest: artifact.digest, ...(artifact.size !== undefined ? { size: artifact.size } : {}), sources: [{ uri: location }] });
  if (!fetched.ok || !fetched.bytes) return refuse("artifact", `${fetched.outcome}: ${fetched.reason ?? "no source produced the signed bytes"}`, { publisherTrust: trust ? "verified" : "not-evaluated" });

  // 4. The same checks, once more, on the bytes in hand, plus the package itself against the consumer's expectation.
  const acceptance = acceptAcquiredRecipePackage({ release, artifactId, bytes: fetched.bytes, expect: input.expect, ...(input.trust ? { trust: { documents, policy: input.trust.policy } } : {}) });
  if (!acceptance.ok) return refuse(acceptance.stage, acceptance.reason ?? "refused", { publisherTrust: acceptance.publisherTrust, acceptance });

  const receipt = receiptFromAcquisition({
    release,
    artifact,
    timestamp: (input.now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z"),
    verification: {
      // Both were checked above, in this order, before any of this was read or returned.
      digest: "verified",
      signature: "verified",
      publisherTrust: acceptance.publisherTrust,
      revocation: trust?.revocationChecked ? "checked" : "not-checked",
      ...(trust?.anchor ? { trustAnchor: trust.anchor } : {}),
      ...(trust?.publisherDocument ? { publisherDocument: trust.publisherDocument } : {})
    }
  });
  const valid = validateReceipt(receipt, { release });
  if (!valid.valid) return refuse("accepted", `the receipt does not validate against its release: ${valid.errors.join("; ")}`);

  return {
    ok: true,
    stage: "accepted",
    publisherTrust: acceptance.publisherTrust,
    installable: acceptance.installable,
    executable: false,
    release,
    package: acceptance.package!,
    bytes: fetched.bytes,
    receipt,
    acceptance,
    ...(fetched.source ? { source: fetched.source } : {})
  };
}
