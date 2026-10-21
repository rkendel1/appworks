/**
 * Publishing (spec/distribution-1.md §3): turn a recipe package into a signed Distribution Protocol release in a channel.
 * The release is signed by the publisher's key and bound to the publisher's document; the artifact is the package's
 * canonical bytes; the signed `appport/recipe-package/1` binding ties the release to the package digest. Publishing
 * authorizes nothing and makes nothing run.
 */
import { digestOfBytes, signRelease } from "@distribution-protocol/protocol";
import { basename } from "node:path";
import { createRecipeLock, createRecipePackage, type RecipeEnvironment, type RecipePackage, type RecipeSource } from "@appport/recipe";
import { FileChannel, ChannelError, type PublisherEnvelope, type SignedRelease } from "./channel.js";
import { recipeReleaseManifest, type ReleaseInterface } from "./release.js";

/**
 * The package `appworks package publish <recipe.json>` builds from a recipe file and the publisher's environment: a portable lock
 * against that environment's contracts, and provenance naming the file. One function, so that whatever previews a package (the
 * Studio) and the command that publishes it cannot disagree about its digest. Carries no provider and grants nothing.
 */
export function packageForPublish(recipe: RecipeSource, snapshot: RecipeEnvironment, source: { file: string; revision?: string }): RecipePackage {
  return createRecipePackage(recipe, createRecipeLock(recipe, { contracts: snapshot.contracts ?? {} }), {
    provenance: { tool: "appworks package publish", source: { path: basename(source.file), ...(source.revision !== undefined ? { revision: source.revision } : {}) } }
  });
}

export interface PublishSigner {
  publisher: string;
  /** The publisher's name for the signing key, as declared in its document. */
  keyId: string;
  privateKey: unknown;
  /** The publisher's document lineage, oldest first. The release is bound to the head. */
  lineage: PublisherEnvelope[];
}

export interface PublishResult {
  status: "published" | "unchanged";
  release: SignedRelease;
  /** `<product>@<version>` */
  releaseId: string;
  artifact: { id: string; digest: string; size: number; path: string };
  /** What a consumer must be told out of band to pin this package: the package digest. Never read from the release. */
  package: { recipe: string; digest: string };
}

export function publishRecipePackage(input: {
  channel: FileChannel;
  package: RecipePackage;
  product: { id: string; name: string; version: string };
  signer: PublishSigner;
  interfaces: ReleaseInterface[];
}): PublishResult {
  const head = input.signer.lineage.at(-1);
  if (!head) throw new ChannelError("NOT_A_CHANNEL", "a publisher document is required: a release is signed under a publisher identity, not a bare key");
  const { manifest, bytes } = recipeReleaseManifest(input.package, { product: input.product, publisher: { id: input.signer.publisher }, interfaces: input.interfaces });
  const digest = digestOfBytes(bytes);
  // Where the bytes live is not signed (Distribution Protocol 1.0.0's manifest has no `sources`): identity is the signed digest, and
  // the channel derives the location from it. A mirror may serve the same bytes from anywhere and cannot change what they are.
  const path = FileChannel.artifactPath(digest);
  const release: SignedRelease = signRelease(manifest, input.signer.privateKey, { keyId: input.signer.keyId, publisherDocument: head });

  // Order matters: bytes and the publisher's document first, the release last, so a release never names what is not there.
  input.channel.writeArtifact(digest, bytes);
  input.channel.writeLineage(input.signer.publisher, input.signer.lineage);
  const status = input.channel.writeRelease(release) === "written" ? "published" : "unchanged";
  return {
    status,
    release,
    releaseId: `${input.product.id}@${input.product.version}`,
    artifact: { id: (manifest["artifacts"] as Array<{ id: string }>)[0]!.id, digest, size: bytes.byteLength, path },
    package: { recipe: input.package.recipe.id, digest: input.package.digest }
  };
}
