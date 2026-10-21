/**
 * Phase 4 exit, end to end (spec/distribution-1.md): environment 1 publishes the supplier-invoice package; a separate environment
 * (fresh state, a different provider of the same canonical contract) acquires it, verifies it, installs it and executes it. What
 * runs is the acquired package, never a source checkout, and tampering anywhere is refused at the stage that owns it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublisherDocument, createTrustPolicy, documentIdOf, exportPublicKey, generatePublisherKeypair, signPublisherDocument } from "@distribution-protocol/protocol";
import { createRecipeLock, createRecipePackage, serializeRecipePackage } from "@appport/recipe";
import { FileChannel, InstallStore, acquireRecipePackage, installRecipePackage, publishRecipePackage, type InstallEnvironment } from "@appport/recipe-distribution";
import { RecipeRuntime, loadInstalledRecipe, type CapabilityGateway } from "../../recipe-runtime/src/index.js";
import { main, type CliEnvironment } from "../../recipe-runtime/src/cli.js";
import { BOOKS_NAMES, accountingEnvironment } from "../../recipe-runtime/test/accounting/environment.js";
import { supplierInvoice } from "../../recipe-runtime/test/accounting/contract.js";
import { AUTO, full, onCleanup, tempDir, useCleanup } from "../../recipe-runtime/test/support.js";

useCleanup();
const PUBLISHER = "publisher://example";
const PRODUCT = { id: "product://example/supplier-invoice", name: "Supplier invoice recipe", version: "1.0.0" };
const asInstallEnvironment = (gateway: CapabilityGateway): InstallEnvironment => ({ snapshot: (requires) => gateway.snapshot(requires), resolve: (requires) => gateway.resolve!(requires) });

async function publishFrom(dir: string) {
  const recipe = supplierInvoice();
  const env1 = await accountingEnvironment(join(dir, "env1"), recipe); // provider: com.example.ledger
  onCleanup(() => env1.close());
  const { contracts } = await env1.gateway.snapshot(recipe.requires);
  const pkg = createRecipePackage(recipe, createRecipeLock(recipe, { contracts: contracts as never }), { provenance: { tool: "appworks test", source: { path: "examples/supplier-invoice/recipe.json", revision: "0123abc" } } });
  const { publicKey, privateKey } = generatePublisherKeypair();
  const envelope = signPublisherDocument(createPublisherDocument({ publisher: PUBLISHER, name: "Example", keys: [{ id: "key-1", algorithm: "ed25519", publicKey: exportPublicKey(publicKey), notBefore: "2026-01-01T00:00:00Z", notAfter: "2030-01-01T00:00:00Z" }] }), privateKey, { keyId: "key-1" });
  const channel = new FileChannel(join(dir, "channel"));
  const published = publishRecipePackage({ channel, package: pkg, product: PRODUCT, signer: { publisher: PUBLISHER, keyId: "key-1", privateKey, lineage: [envelope] }, interfaces: [{ id: "recipe", type: "library" }] });
  const policy = createTrustPolicy({ publishers: [PUBLISHER], documents: { [PUBLISHER]: [{ documentId: documentIdOf(envelope.document), sequence: 1 }] } });
  return { recipe, pkg, channel, published, policy, env1 };
}

/** The consumer: fresh state, a different provider of the same contract. */
async function consume(dir: string, published: Awaited<ReturnType<typeof publishFrom>>) {
  const env2 = await accountingEnvironment(join(dir, "env2"), published.recipe, [{ id: "com.globex.books", names: BOOKS_NAMES }]);
  onCleanup(() => env2.close());
  const acquired = await acquireRecipePackage({ channel: published.channel, product: PRODUCT.id, version: PRODUCT.version, expect: { digest: published.pkg.digest, recipe: published.recipe.id }, trust: { policy: published.policy } });
  return { env2, acquired, store: new InstallStore(join(dir, "installed")) };
}

const cli = async (args: string[], env: CliEnvironment) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("publish in one environment; acquire, install and run in another", () => {
  it("runs the acquired package against a different provider, with the recipe unchanged, after the channel and the source are gone", async () => {
    const dir = tempDir();
    const p = await publishFrom(dir);
    const { env2, acquired, store } = await consume(dir, p);
    expect(acquired).toMatchObject({ ok: true, installable: true, executable: false });

    const installed = await installRecipePackage({ store, acquired, environment: asInstallEnvironment(env2.gateway) });
    expect(installed).toMatchObject({ ok: true, stage: "installed" });
    const lock = JSON.parse(readFileSync(join(installed.dir!, "lock.json"), "utf8"));
    expect(lock.dependencies.map((d: any) => d.resolution.provider.application)).toEqual(["com.globex.books", "com.globex.books", "com.globex.books"]); // this environment's providers, not the publisher's
    expect(installed.record).toMatchObject({ authorizes: "nothing", release: { id: `${PRODUCT.id}@1.0.0`, publisher: PUBLISHER } });

    // The source is gone: nothing but the installed package can be what runs.
    rmSync(join(dir, "channel"), { recursive: true });
    rmSync(join(dir, "env1"), { recursive: true });

    const home = join(dir, "runtime");
    const run = await cli(["recipe", "run", "--package", installed.dir!, "--input", JSON.stringify(AUTO), "--environment", "env2.mjs", "--home", home, "--principal", "alice", "--json"], { load: async () => ({ gateway: env2.gateway, authority: full }) });
    expect(run.code).toBe(0);
    const view = JSON.parse(run.out);
    expect(view).toMatchObject({ status: "finished", outcome: "completed", output: { invoiceId: "inv-1", status: "submitted" }, assessment: { state: "verified" } });
    expect(view.origin).toMatchObject({ kind: "installed-package", package: p.pkg.digest, recipe: p.recipe.id, release: `${PRODUCT.id}@1.0.0`, publisher: PUBLISHER, lock: installed.record!.lock.digest });
    expect(loadInstalledRecipe(installed.dir!).recipe).toEqual(p.recipe); // the recipe that runs is, member for member, the one that was published

    // The effect is in the consumer's provider's ledger, read from its own database; the publisher's provider never saw it.
    expect((await env2.ledgers["com.globex.books"]!.invoices())).toHaveLength(1);
    expect(existsSync(join(dir, "env1"))).toBe(false);
    expect((await cli(["recipe", "status", view.id, "--home", home], {})).out).toContain("origin:");
  });

  it("refuses to run a package that was altered after it was installed, before anything is written or invoked", async () => {
    const dir = tempDir();
    const p = await publishFrom(dir);
    const { env2, acquired, store } = await consume(dir, p);
    const installed = await installRecipePackage({ store, acquired, environment: asInstallEnvironment(env2.gateway) });
    const environment: CliEnvironment = { load: async () => ({ gateway: env2.gateway, authority: full }) };
    const home = join(dir, "runtime");
    const args = ["recipe", "run", "--package", installed.dir!, "--input", JSON.stringify(AUTO), "--environment", "env2.mjs", "--home", home];

    // 1. the recipe inside the package is edited
    const bin = join(installed.dir!, "package.bin");
    const original = readFileSync(bin);
    writeFileSync(bin, original.toString("utf8").replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    const a = await cli(args, environment);
    expect(a.code).toBe(1);
    expect(a.err).toContain("RECIPE_INVALID");
    writeFileSync(bin, original);

    // 2. the environment's lock is edited
    const lockPath = join(installed.dir!, "lock.json");
    const lock = readFileSync(lockPath, "utf8");
    writeFileSync(lockPath, lock.replace("com.globex.books", "com.attacker.books"));
    const b = await cli(args, environment);
    expect(b.code).toBe(1);
    expect(b.err).toContain("lock");
    writeFileSync(lockPath, lock);

    // 2b. a different package, perfectly self-consistent (its own digest checks out), swapped in for the installed one: only the digest
    //     recorded when it was installed can tell, so this is what makes "the package that was accepted" the package that runs
    const swapped = supplierInvoice();
    swapped.name = "A different, valid package";
    writeFileSync(bin, serializeRecipePackage(createRecipePackage(swapped, createRecipeLock(swapped, { contracts: (await env2.gateway.snapshot(swapped.requires)).contracts as never }))));
    const c = await cli(args, environment);
    expect(c.code).toBe(1);
    expect(c.err).toContain("no longer is the package it was installed as");
    writeFileSync(bin, original);

    // 3. restored, it runs, and there was never a run record or a ledger write from the refused attempts
    expect((await env2.ledgers["com.globex.books"]!.invoices())).toEqual([]);
    expect((await cli(args, environment)).code).toBe(0);
    expect((await env2.ledgers["com.globex.books"]!.invoices())).toHaveLength(1);
  });

  it("an environment without a provider of the contract cannot install, and so cannot run, the package", async () => {
    const dir = tempDir();
    const p = await publishFrom(dir);
    const bare = await accountingEnvironment(join(dir, "env3"), p.recipe, []);
    onCleanup(() => bare.close());
    const acquired = await acquireRecipePackage({ channel: p.channel, product: PRODUCT.id, version: PRODUCT.version, expect: { digest: p.pkg.digest }, trust: { policy: p.policy } });
    const store = new InstallStore(join(dir, "installed"));
    const result = await installRecipePackage({ store, acquired, environment: asInstallEnvironment(bare.gateway) });
    expect(result).toMatchObject({ ok: false, stage: "environment" });
    expect(store.list()).toEqual([]);
  });

  it("the acquired package and the run it produces are bound end to end: release id, package digest and lock digest are all in the run's origin", async () => {
    const dir = tempDir();
    const p = await publishFrom(dir);
    const { env2, acquired, store } = await consume(dir, p);
    const installed = await installRecipePackage({ store, acquired, environment: asInstallEnvironment(env2.gateway) });
    const rt = await RecipeRuntime.open({ home: join(dir, "runtime"), gateway: env2.gateway, authority: full });
    onCleanup(() => rt.close());
    const { recipe, origin } = loadInstalledRecipe(installed.dir!);
    const run = await rt.start(recipe, AUTO, "alice", { origin });
    expect(run.origin).toEqual(origin);
    expect(run.recipeDigest).toMatch(/^sha256:/);
  });
});
