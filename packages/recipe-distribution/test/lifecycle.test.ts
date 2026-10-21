/**
 * Publish, acquire, install (spec/distribution-1.md): a real signed release in a real channel directory, acquired through
 * Distribution Protocol's own transport, trust anchored by a publisher document, and installed against a real AppPort environment.
 * Each attack is refused at the stage that owns it, and refused before any bytes are returned.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublisherDocument, createTrustPolicy, documentIdOf, exportPublicKey, generatePublisherKeypair, signPublisherDocument, validateReceipt, type PublisherEnvelope } from "@distribution-protocol/protocol";
import { createRecipeLock, createRecipePackage, type RecipePackage, type RecipeSource } from "@appport/recipe";
import { ChannelError, FileChannel, InstallStore, acquireRecipePackage, installRecipePackage, publishRecipePackage, readInstalledPackage, type InstallEnvironment } from "../src/index.js";
import { CONTRACT, accountingContract, canonicalEnvironment, example } from "../../recipe/test/fixtures.js";

const PUBLISHER = "publisher://example";
const PRODUCT = { id: "product://example/supplier-invoice", name: "Supplier invoice recipe", version: "1.0.0" };
const interfaces = [{ id: "recipe", type: "library" as const }];

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "recipe-dist-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function publisher(id = PUBLISHER) {
  const { publicKey, privateKey } = generatePublisherKeypair();
  const document = createPublisherDocument({ publisher: id, name: "Example", keys: [{ id: "key-1", algorithm: "ed25519", publicKey: exportPublicKey(publicKey), notBefore: "2026-01-01T00:00:00Z", notAfter: "2030-01-01T00:00:00Z" }] });
  const envelope = signPublisherDocument(document, privateKey, { keyId: "key-1" });
  return { privateKey, lineage: [envelope] as PublisherEnvelope[], policy: createTrustPolicy({ publishers: [id], documents: { [id]: [{ documentId: documentIdOf(envelope.document), sequence: 1 }] } }) };
}
const build = (mutate: (r: RecipeSource) => void = () => {}): RecipePackage => {
  const recipe = example();
  mutate(recipe);
  return createRecipePackage(recipe, createRecipeLock(recipe, { contracts: { [CONTRACT]: accountingContract() } }), { provenance: { tool: "test", source: { revision: "abc123" } } });
};
const publishTo = (channel: FileChannel, pub: ReturnType<typeof publisher>, pkg = build(), version = "1.0.0") =>
  publishRecipePackage({ channel, package: pkg, product: { ...PRODUCT, version }, signer: { publisher: PUBLISHER, keyId: "key-1", privateKey: pub.privateKey, lineage: pub.lineage }, interfaces });
const acquire = (channel: FileChannel, pkg: RecipePackage, policy: unknown, version = "1.0.0") =>
  acquireRecipePackage({ channel, product: PRODUCT.id, version, expect: { digest: pkg.digest, recipe: pkg.recipe.id }, ...(policy ? { trust: { policy } } : {}) });

/** The receiving environment, from real AppPort registries and resolution. */
async function environment(options: { providers?: string[] } = {}): Promise<InstallEnvironment> {
  const env = await canonicalEnvironment(options);
  const recipe = example();
  return {
    snapshot: async (requires) => ({
      contracts: (await env.snapshot()).contracts,
      providers: Object.fromEntries(await Promise.all(requires.map(async (d) => [d.id, { eligible: (await env.resolve(recipe, d.id)).kind === "resolved" ? 1 : 0 }])))
    }),
    resolve: async () => (await env.records(recipe)) as never
  };
}

describe("publishing (§3)", () => {
  it("writes the artifact, the publisher's document and a signed release bound to the package digest; the same again is a no-op, another content under that version is refused, a new version is fine", () => {
    const channel = new FileChannel(join(dir, "channel"));
    const pub = publisher();
    const pkg = build();
    const first = publishTo(channel, pub, pkg);
    expect(first).toMatchObject({ status: "published", releaseId: `${PRODUCT.id}@1.0.0`, package: { recipe: pkg.recipe.id, digest: pkg.digest } });
    expect(first.artifact.digest).not.toBe(pkg.digest); // the bytes' identity is not the package's
    expect(existsSync(join(channel.dir, first.artifact.path))).toBe(true);
    expect(first.release.manifest.artifacts[0].sources).toBeUndefined(); // locations are not signed; identity is the digest
    expect(first.artifact.path).toBe(`artifacts/${first.artifact.digest.replace(":", "-")}.json`);
    expect(first.release.manifest.artifacts[0].bindings).toEqual([{ scheme: "appport/recipe-package/1", value: pkg.digest }]);
    expect(readdirSync(join(channel.dir, "publishers"))).toEqual(["example.json"]);

    const before = readFileSync(join(channel.dir, "releases/example/supplier-invoice/1.0.0.json"), "utf8");
    expect(publishTo(channel, pub, pkg).status).toBe("unchanged");
    const other = build((r) => void (r.name = "Changed"));
    expect(() => publishTo(channel, pub, other)).toThrow(ChannelError);
    expect(() => publishTo(channel, pub, other)).toThrow(/already published with different content/);
    expect(readFileSync(join(channel.dir, "releases/example/supplier-invoice/1.0.0.json"), "utf8")).toBe(before); // untouched
    expect(publishTo(channel, pub, other, "1.1.0").status).toBe("published");
  });

  it("refuses to sign under a key the publisher's document does not declare, and publishes nothing", () => {
    const channel = new FileChannel(join(dir, "channel"));
    const pub = publisher();
    const stranger = generatePublisherKeypair();
    expect(() => publishRecipePackage({ channel, package: build(), product: PRODUCT, signer: { publisher: PUBLISHER, keyId: "key-1", privateKey: stranger.privateKey, lineage: pub.lineage }, interfaces })).toThrow(/not declared/);
    expect(channel.readReleases(PRODUCT.id)).toEqual([]);
  });
});

describe("acquisition (§4)", () => {
  it("returns verified bytes, the package and a valid Distribution Protocol receipt; installable only because trust was evaluated; executable never", async () => {
    const channel = new FileChannel(join(dir, "channel"));
    const pub = publisher();
    const pkg = build();
    const published = publishTo(channel, pub, pkg);
    const got = await acquire(channel, pkg, pub.policy);
    expect(got).toMatchObject({ ok: true, stage: "accepted", publisherTrust: "verified", installable: true, executable: false });
    expect(got.package!.digest).toBe(pkg.digest);
    expect(got.receipt).toMatchObject({ type: "distribution/receipt", product: PRODUCT.id, release: `${PRODUCT.id}@1.0.0`, artifact: published.artifact.digest, publisher: PUBLISHER, verification: { digest: "verified", signature: "verified", publisherTrust: "verified", trustAnchor: "document" } });
    expect(validateReceipt(got.receipt, { release: got.release })).toEqual({ valid: true, errors: [] });

    const inspected = await acquire(channel, pkg, undefined); // no policy: inspect, never install
    expect(inspected).toMatchObject({ ok: true, publisherTrust: "not-evaluated", installable: false });
  });

  describe("every attack is refused at the stage that owns it, and no bytes are returned", () => {
    async function setup() {
      const channel = new FileChannel(join(dir, "channel"));
      const pub = publisher();
      const pkg = build();
      const published = publishTo(channel, pub, pkg);
      return { channel, pub, pkg, published, releasePath: join(channel.dir, "releases/example/supplier-invoice/1.0.0.json") };
    }
    const edit = (path: string, change: (release: any) => void) => {
      const release = JSON.parse(readFileSync(path, "utf8"));
      change(release);
      writeFileSync(path, JSON.stringify(release));
    };

    it("a flipped byte in the artifact: `artifact`", async () => {
      const s = await setup();
      const path = join(s.channel.dir, s.published.artifact.path);
      const bytes = readFileSync(path);
      bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 1;
      writeFileSync(path, bytes);
      const got = await acquire(s.channel, s.pkg, s.pub.policy);
      expect(got).toMatchObject({ ok: false, stage: "artifact", executable: false });
      expect(got.bytes).toBeUndefined();
    });
    it("a missing artifact: `artifact`", async () => {
      const s = await setup();
      rmSync(join(s.channel.dir, s.published.artifact.path));
      expect(await acquire(s.channel, s.pkg, s.pub.policy)).toMatchObject({ ok: false, stage: "artifact" });
    });
    it("an altered signature: `release`", async () => {
      const s = await setup();
      // A character in the middle: the last base64url character of a 64-byte signature has spare bits, so changing it can leave the bytes unchanged.
      edit(s.releasePath, (r) => void (r.signature.value = `${r.signature.value.slice(0, 20)}${r.signature.value[20] === "A" ? "B" : "A"}${r.signature.value.slice(21)}`));
      expect(await acquire(s.channel, s.pkg, s.pub.policy)).toMatchObject({ ok: false, stage: "release" });
    });
    it("an altered signed binding (the package digest it asserts): `release`, because the manifest is what was signed", async () => {
      const s = await setup();
      edit(s.releasePath, (r) => void (r.manifest.artifacts[0].bindings[0].value = `sha256:${"0".repeat(64)}`));
      expect(await acquire(s.channel, s.pkg, s.pub.policy)).toMatchObject({ ok: false, stage: "release" });
    });
    it("a release redirected to other bytes (artifact digest edited): `release`", async () => {
      const s = await setup();
      edit(s.releasePath, (r) => void (r.manifest.artifacts[0].digest = `sha256:${"1".repeat(64)}`));
      expect(await acquire(s.channel, s.pkg, s.pub.policy)).toMatchObject({ ok: false, stage: "release" });
    });
    it("a genuine release of a different package than the consumer expects: `binding`", async () => {
      const s = await setup();
      const expectedElsewhere = build((r) => void (r.name = "Not this one"));
      expect(await acquire(s.channel, expectedElsewhere, s.pub.policy)).toMatchObject({ ok: false, stage: "binding" });
    });
    it("a publisher the consumer does not trust, or trusts only by name: `trust`", async () => {
      const s = await setup();
      expect(await acquire(s.channel, s.pkg, createTrustPolicy({ publishers: ["publisher://someone-else"] }))).toMatchObject({ ok: false, stage: "trust" });
      const byNameOnly = await acquire(s.channel, s.pkg, createTrustPolicy({ publishers: [PUBLISHER] }));
      expect(byNameOnly).toMatchObject({ ok: false, stage: "trust" });
      expect(byNameOnly.reason).toContain("UNANCHORED");
    });
    it("an attacker's own document for the same publisher identity, with a release signed by the attacker's key: `trust` (identity is not an anchor)", async () => {
      const s = await setup();
      const attacker = publisher(); // same id, different key, self-consistent
      const forged = new FileChannel(join(dir, "forged"));
      publishTo(forged, attacker, s.pkg);
      const got = await acquire(forged, s.pkg, s.pub.policy); // the consumer's policy anchors the REAL document
      expect(got).toMatchObject({ ok: false, stage: "trust" });
    });
    it("a release that is not in the channel: `resolve`", async () => {
      const s = await setup();
      expect(await acquire(s.channel, s.pkg, s.pub.policy, "9.9.9")).toMatchObject({ ok: false, stage: "resolve" });
    });
  });
});

describe("installation (§5)", () => {
  async function acquired() {
    const channel = new FileChannel(join(dir, "channel"));
    const pub = publisher();
    const pkg = build();
    publishTo(channel, pub, pkg);
    return { channel, pub, pkg, got: await acquire(channel, pkg, pub.policy) };
  }

  it("locks the package to the providers this environment resolves, records what was verified, and authorizes nothing", async () => {
    const { got, pkg } = await acquired();
    const store = new InstallStore(join(dir, "installed"));
    const result = await installRecipePackage({ store, acquired: got, environment: await environment() });
    expect(result).toMatchObject({ ok: true, stage: "installed" });
    expect(result.record).toMatchObject({ format: "appworks.recipe-install/1", authorizes: "nothing", package: { recipe: pkg.recipe.id, digest: pkg.digest }, trust: { publisherTrust: "verified", anchor: "document" }, requirements: { roles: ["role:ap-manager"] } });
    expect(readdirSync(result.dir!).sort()).toEqual(["install.json", "lock.json", "package.bin", "receipt.json", "release.json"]);
    const lock = JSON.parse(readFileSync(join(result.dir!, "lock.json"), "utf8"));
    expect(lock.dependencies.every((d: any) => d.resolution?.provider.application === "com.example.ledger")).toBe(true); // the environment's lock, not the portable one
    expect(pkg.lock.dependencies.every((d) => d.resolution === undefined)).toBe(true);
    expect(readInstalledPackage(result.dir!)).toMatchObject({ ok: true, findings: [] });
    expect(store.list()).toHaveLength(1);
  });

  it("is idempotent for the same package and refuses a different package under an installed version", async () => {
    const { got } = await acquired();
    const store = new InstallStore(join(dir, "installed"));
    const env = await environment();
    expect(await installRecipePackage({ store, acquired: got, environment: env })).toMatchObject({ stage: "installed" });
    expect(await installRecipePackage({ store, acquired: got, environment: env })).toMatchObject({ ok: true, stage: "already-installed" });

    const channel2 = new FileChannel(join(dir, "channel2"));
    const pub2 = publisher();
    const other = build((r) => void (r.name = "A different package, same version"));
    publishTo(channel2, pub2, other);
    const got2 = await acquire(channel2, other, pub2.policy);
    expect(await installRecipePackage({ store, acquired: got2, environment: env })).toMatchObject({ ok: false, stage: "conflict" });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.package.digest).toBe(got.package!.digest);
  });

  it("refuses what was only inspected (no trust evaluated), and an environment that cannot run the recipe, writing nothing", async () => {
    const channel = new FileChannel(join(dir, "channel"));
    const pub = publisher();
    const pkg = build();
    publishTo(channel, pub, pkg);
    const store = new InstallStore(join(dir, "installed"));
    const untrusted = await acquire(channel, pkg, undefined);
    expect(await installRecipePackage({ store, acquired: untrusted, environment: await environment() })).toMatchObject({ ok: false, stage: "trust" });

    const trusted = await acquire(channel, pkg, pub.policy);
    const none = await installRecipePackage({ store, acquired: trusted, environment: await environment({ providers: [] }) });
    expect(none).toMatchObject({ ok: false, stage: "environment" });
    expect((none.findings as Array<{ code: string }>).some((f) => f.code === "ENV_NO_ELIGIBLE_PROVIDER")).toBe(true);
    expect(existsSync(join(dir, "installed"))).toBe(false);
  });

  it("detects an installed package altered after the fact", async () => {
    const { got } = await acquired();
    const store = new InstallStore(join(dir, "installed"));
    const result = await installRecipePackage({ store, acquired: got, environment: await environment() });
    const path = join(result.dir!, "package.bin");
    writeFileSync(path, readFileSync(path, "utf8").replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    const read = readInstalledPackage(result.dir!);
    expect(read.ok).toBe(false);
    expect(read.findings.join(" ")).toMatch(/PACKAGE_/);
  });
});

