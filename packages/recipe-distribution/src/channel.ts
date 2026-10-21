/**
 * A file release channel: a directory holding signed releases, their artifact bytes and publishers' documents, laid out so a
 * consumer needs nothing but the directory and Distribution Protocol's `file://` transport. It is storage only. It decides
 * nothing: what it holds is untrusted until `acquireRecipePackage` has verified it, and a channel that lies fails there.
 * (An HTTPS registry is the same data behind another transport; none is implemented here.)
 *
 *   <dir>/releases/<namespace>/<slug>/<version>.json   one signed release envelope per published version (immutable)
 *   <dir>/artifacts/sha256-<hex>.json                  artifact bytes, named by their digest
 *   <dir>/publishers/<namespace>.json                  the publisher's document lineage (an array of signed envelopes)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** A signed publisher document, as Distribution Protocol defines it. Structural, so no declaration of this package names that package's types. */
export interface PublisherEnvelope {
  type: string;
  document: any;
  signature: Record<string, string>;
}

/** A signed release envelope, as Distribution Protocol defines it. */
export interface SignedRelease {
  type: string;
  manifest: any;
  signature: Record<string, string>;
}

export class ChannelError extends Error {
  constructor(
    readonly code: "RELEASE_CONFLICT" | "NOT_A_CHANNEL" | "INVALID_ID",
    message: string
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

const PRODUCT = /^product:\/\/([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
const PUBLISHER = /^publisher:\/\/([a-z0-9][a-z0-9-]*)$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseProduct(id: string): { namespace: string; slug: string } {
  const m = PRODUCT.exec(id);
  if (!m) throw new ChannelError("INVALID_ID", `not a product identifier: ${JSON.stringify(id)}`);
  return { namespace: m[1]!, slug: m[2]! };
}

/** Writes `bytes` to `path` atomically (a temporary name, then a rename), creating directories. */
export function writeAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

export class FileChannel {
  constructor(readonly dir: string) {}

  /** The relative `file` source a release names for an artifact: relative to the channel, so a channel can be moved or mirrored. */
  static artifactPath(digest: string): string {
    return `artifacts/${digest.replace(":", "-")}.json`;
  }

  private releasePath(product: string, version: string): string {
    const { namespace, slug } = parseProduct(product);
    if (!VERSION.test(version)) throw new ChannelError("INVALID_ID", `not a semantic version: ${JSON.stringify(version)}`);
    return join(this.dir, "releases", namespace, slug, `${version}.json`);
  }

  private publisherPath(publisher: string): string {
    const m = PUBLISHER.exec(publisher);
    if (!m) throw new ChannelError("INVALID_ID", `not a publisher identifier: ${JSON.stringify(publisher)}`);
    return join(this.dir, "publishers", `${m[1]}.json`);
  }

  /** Every release envelope published for a product, as stored and unverified. */
  readReleases(product: string): unknown[] {
    const { namespace, slug } = parseProduct(product);
    const dir = join(this.dir, "releases", namespace, slug);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown);
  }

  readRelease(product: string, version: string): unknown | undefined {
    const path = this.releasePath(product, version);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined;
  }

  /** Stores a release. A published version never changes: the same bytes again are a no-op, anything else is `RELEASE_CONFLICT`. */
  writeRelease(release: { manifest: { product: { id: string; version: string } } }): "written" | "unchanged" {
    const path = this.releasePath(release.manifest.product.id, release.manifest.product.version);
    const bytes = `${JSON.stringify(release, null, 2)}\n`;
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") === bytes) return "unchanged";
      throw new ChannelError("RELEASE_CONFLICT", `${release.manifest.product.id}@${release.manifest.product.version} is already published with different content; a version is immutable, publish a new one`);
    }
    writeAtomic(path, bytes);
    return "written";
  }

  /** Stores artifact bytes under their digest. Returns the relative path. */
  writeArtifact(digest: string, bytes: Uint8Array): string {
    const relative = FileChannel.artifactPath(digest);
    const path = join(this.dir, relative);
    if (!existsSync(path)) writeAtomic(path, bytes);
    return relative;
  }

  readLineage(publisher: string): unknown[] {
    const path = this.publisherPath(publisher);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
  }

  writeLineage(publisher: string, lineage: unknown[]): void {
    writeAtomic(this.publisherPath(publisher), `${JSON.stringify(lineage, null, 2)}\n`);
  }
}
