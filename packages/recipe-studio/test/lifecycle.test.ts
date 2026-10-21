/**
 * The Studio's exit test: a recipe made in the Studio, saved, reopened, validated against a real AppPort environment, packaged,
 * and then carried through the existing `appworks package ...` and `appworks recipe run --package` commands into a second
 * environment with a different provider. Nothing here calls the Studio's code for publishing, trust, installation or running,
 * because it has none: the artifact it produced is what traverses the existing lifecycle.
 *
 * Which of the 15 supplier-invoice scenario steps this exercises is listed in the README; this test does not claim the rest.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRecipePackage } from "@appport/recipe";
import { recipeDigestOf, StudioStore } from "../src/index.js";
import { AUTO, BOOKS_NAMES, distribution, filesUnder, runtime, studioEnvironment, studioServer, supplierInvoice, supplierInvoiceFromEmpty, tempDir, useCleanup } from "./support.js";
import { LEDGER_NAMES } from "../../recipe-runtime/test/accounting/environment.js";

useCleanup();
const rawStatus = (origin: string, path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(origin);
    const req = request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
const PUBLISHER = "publisher://example";
const PRODUCT = "product://example/supplier-invoice";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Environment 1 and a Studio over it; the recipe is made through the Studio's API from an empty one. */
async function author(dir: string) {
  const e1 = await studioEnvironment(dir, "publisher-env");
  const studio = await studioServer(join(dir, "projects"), [e1.studio]);
  const built = supplierInvoiceFromEmpty(await e1.studio.gateway.catalog!());
  const created = await studio.call("POST", "/api/projects", { slug: "supplier-invoice", ...built.seed, release: { product: PRODUCT, version: "1.0.0" } });
  expect(created.status).toBe(201);
  const edited = await studio.call("POST", "/api/projects/supplier-invoice/edit", { revision: created.json.revision, edits: built.edits });
  expect(edited.status, edited.text).toBe(200);
  return { e1, studio, built, revision: edited.json.revision as number };
}

/** Keys, a channel and a consumer policy, all through the existing commands. */
async function keysAndPolicy(dir: string) {
  const keys = join(dir, "keys");
  const policy = join(dir, "policy.json");
  expect((await distribution(["package", "keygen", "--publisher", PUBLISHER, "--out", keys], undefined)).code).toBe(0);
  expect((await distribution(["package", "trust", "--publisher-document", join(keys, "publisher.json"), "--policy", policy], undefined)).code).toBe(0);
  return { keys, policy, channel: join(dir, "channel") };
}

describe("supplier-invoice: Studio -> package -> publish -> acquire -> install -> run", () => {
  it("makes, saves, reopens, validates, packages; the existing commands publish, verify and install exactly that package; the runtime executes it in another environment", async () => {
    const dir = tempDir();
    const { e1, studio, built, revision } = await author(dir);

    // 1-2. Created from empty through the Studio, saved. Close it and reopen it from disk, in a new server.
    const recipePath = studio.store.recipePath("supplier-invoice");
    const savedBytes = readFileSync(recipePath, "utf8");
    await studio.close();
    const reopened = await studioServer(join(dir, "projects"), [e1.studio]);
    const project = (await reopened.call("GET", "/api/projects/supplier-invoice")).json;
    expect(project).toMatchObject({ revision, release: { product: PRODUCT, version: "1.0.0" } });
    expect(project.recipe).toEqual(built.example); // nothing lost: member for member the checked-in supplier-invoice recipe
    expect(recipeDigestOf(project.recipe)).toBe(recipeDigestOf(supplierInvoice()));
    expect(readFileSync(recipePath, "utf8")).toBe(savedBytes);

    // 3. Validated against a real environment: sound, resolved, authorized; the role it asks of cannot be checked, and says so.
    const readiness = (await reopened.call("GET", "/api/projects/supplier-invoice/assessment")).json;
    expect(readiness).toMatchObject({ verdict: "ready-with-unresolved", environment: "publisher-env", sourceOk: true, executable: false });
    expect(readiness.findings.filter((f: any) => f.severity === "error")).toEqual([]);
    expect(readiness.dependencies.map((d: any) => d.binding.provider)).toEqual(["com.example.ledger", "com.example.ledger", "com.example.ledger"]);
    expect(readiness.unresolved).toEqual([{ subject: "role role:ap-manager", why: expect.stringContaining("not checkable") }]);
    const card = (await reopened.call("GET", "/api/projects/supplier-invoice/card")).json.card;
    expect(card.columns.length).toBe(built.example.steps.filter((x) => x.kind !== "end").length); // the ends are summarised under the finish

    // 4. The canonical package, from the Studio.
    const made = (await reopened.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    expect(made).toMatchObject({ ok: true, executable: false, recipe: built.example.id });
    expect((await reopened.call("GET", "/api/projects/supplier-invoice/package/check")).json).toMatchObject({ ok: true, digest: made.digest, stale: false });
    expect(loadRecipePackage(new Uint8Array(readFileSync(made.file)), { digest: made.digest }).ok).toBe(true); // a consumer's own loader agrees

    // 5-6. The existing commands: the recipe file the Studio saved is the file `package publish` reads, and it publishes the Studio's digest.
    const { keys, policy, channel } = await keysAndPolicy(dir);
    const published = await distribution(["package", "publish", recipePath, "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "env1.mjs", "--json"], e1.studio.gateway);
    expect(published.code, published.err).toBe(0);
    expect(JSON.parse(published.out).package.digest).toBe(made.digest); // the digest the Studio announced is the one published
    // and it is also the digest the CLI gives the checked-in example file: what was made in the Studio from empty *is* that package
    const example = await distribution(["package", "publish", fileURLToPath(new URL("../../../examples/supplier-invoice/recipe.json", import.meta.url)), "--channel", join(dir, "channel-example"), "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "env1.mjs", "--json"], e1.studio.gateway);
    expect(example.code, example.err).toBe(0);
    expect(JSON.parse(example.out).package.digest).toBe(made.digest);
    const args = ["--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", policy];
    const verified = await distribution(["package", "verify", ...args, "--recipe", built.example.id, "--json"], undefined);
    expect(verified.code, verified.err).toBe(0);
    expect(JSON.parse(verified.out)).toMatchObject({ ok: true, stage: "accepted", installable: true });

    // 7. Installed in a separate environment: fresh state, a different provider of the same contract.
    const e2 = await studioEnvironment(dir, "consumer-env", { providers: [{ id: "com.globex.books", names: BOOKS_NAMES }] });
    const grantsBefore = JSON.stringify(await Promise.all(["books.lookup", "books.fetch", "books.record", "books.resolve"].map((n) => e2.env.grants.find({ consumerId: e2.env.consumer.id, providerId: "com.globex.books", capabilityName: n, capabilityVersion: 1 }))));
    const installed = await distribution(["package", "install", ...args, "--store", join(dir, "installed"), "--environment", "env2.mjs", "--json"], e2.studio.gateway);
    expect(installed.code, installed.err).toBe(0);
    const record = JSON.parse(installed.out);
    expect(record.record).toMatchObject({ authorizes: "nothing", package: { recipe: built.example.id, digest: made.digest }, release: { publisher: PUBLISHER } });
    const lock = JSON.parse(readFileSync(join(record.dir, "lock.json"), "utf8"));
    expect(lock.dependencies.map((d: any) => d.resolution.provider.application)).toEqual(["com.globex.books", "com.globex.books", "com.globex.books"]);
    const grantsAfter = JSON.stringify(await Promise.all(["books.lookup", "books.fetch", "books.record", "books.resolve"].map((n) => e2.env.grants.find({ consumerId: e2.env.consumer.id, providerId: "com.globex.books", capabilityName: n, capabilityVersion: 1 }))));
    expect(grantsAfter).toBe(grantsBefore); // installing authorized nothing new

    // 8. Executed by the existing runtime, from the installed package, after the channel and the publisher's environment are gone.
    const home = join(dir, "runtime");
    const run = await runtime(["recipe", "run", "--package", record.dir, "--input", JSON.stringify(AUTO), "--environment", "env2.mjs", "--home", home, "--principal", "alice", "--json"], e2.studio.gateway);
    expect(run.code, run.err).toBe(0);
    const view = JSON.parse(run.out);
    expect(view).toMatchObject({ status: "finished", outcome: "completed", output: { invoiceId: "inv-1", status: "submitted" }, assessment: { state: "verified" } });

    // 9. Evidence and origin: the run names the package the Studio made, its release and its lock; the effect is in the consumer's own ledger.
    expect(view.origin).toMatchObject({ kind: "installed-package", package: made.digest, recipe: built.example.id, release: `${PRODUCT}@1.0.0`, publisher: PUBLISHER, lock: record.record.lock.digest });
    expect(view.invocations.filter((i: any) => i.purpose === "step").map((i: any) => i.stepId)).toEqual(["check-duplicate", "submit"]);
    expect(view.verifications.length).toBeGreaterThan(0);
    expect(await e2.env.ledgers["com.globex.books"]!.invoices()).toHaveLength(1);
    expect(await e1.env.ledgers["com.example.ledger"]!.invoices()).toHaveLength(0); // the publisher's provider never saw it
    expect((await runtime(["recipe", "status", view.id, "--home", home], e2.studio.gateway)).out).toContain(`"package":"${made.digest}"`.replace(/"/g, '"'));

    // 10. Reopen the recipe against the consumer's environment: the portable definition is untouched; only what is read live differs.
    const there = await studioServer(join(dir, "projects"), [e2.studio]);
    const again = (await there.call("GET", "/api/projects/supplier-invoice")).json;
    expect(again.recipe).toEqual(project.recipe);
    expect(readFileSync(recipePath, "utf8")).toBe(savedBytes);
    const readiness2 = (await there.call("GET", "/api/projects/supplier-invoice/assessment")).json;
    expect(readiness2.verdict).toBe("ready-with-unresolved");
    expect(readiness2.dependencies.map((d: any) => d.binding.provider)).toEqual(["com.globex.books", "com.globex.books", "com.globex.books"]);
    expect((await there.call("GET", "/api/projects/supplier-invoice/card")).json.card).toEqual(card); // the card is the recipe's, identical in both
    // and nothing environment-specific was ever written into the project, however many environments looked at it
    const written = filesUnder(join(dir, "projects", "supplier-invoice"));
    for (const [file, text] of Object.entries(written)) expect(text, file).not.toMatch(/com\.globex\.books|com\.example\.ledger|registrationId|privateKey|resolution/);
    expect(Object.keys(written).map((f) => f.split("/").pop()).sort()).toEqual(["recipe.json", "recipe.package.json", "studio.json"]);
  });

  it("a different provider needs no change to the portable definition: the same package installs and runs against either", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    const made = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    const { keys, policy, channel } = await keysAndPolicy(dir);
    expect((await distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "e.mjs"], e1.studio.gateway)).code).toBe(0);
    const args = ["--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", policy];
    const digests: string[] = [];
    for (const [index, providers] of [[{ id: "com.globex.books", names: BOOKS_NAMES }], [{ id: "com.initech.gl", names: { duplicate: "gl.dup", get: "gl.get", submit: "gl.post", resolve: "gl.resolve" } }]].entries()) {
      const consumer = await studioEnvironment(dir, `consumer-${index}`, { providers });
      const installed = JSON.parse((await distribution(["package", "install", ...args, "--store", join(dir, `installed-${index}`), "--environment", "e.mjs", "--json"], consumer.studio.gateway)).out);
      digests.push(installed.record.package.digest);
      const run = await runtime(["recipe", "run", "--package", installed.dir, "--input", JSON.stringify(AUTO), "--environment", "e.mjs", "--home", join(dir, `run-${index}`), "--json"], consumer.studio.gateway);
      expect(JSON.parse(run.out)).toMatchObject({ outcome: "completed", assessment: { state: "verified" } });
      expect(await consumer.env.ledgers[providers[0]!.id]!.invoices()).toHaveLength(1);
    }
    expect(new Set(digests)).toEqual(new Set([made.digest]));
  });
});

describe("the Studio cannot be used to get around the lifecycle's checks", () => {
  it("tampering with the package file the Studio wrote is found by the Studio's own check and by any consumer's loader", async () => {
    const dir = tempDir();
    const { studio } = await author(dir);
    const made = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    const original = readFileSync(made.file, "utf8");
    writeFileSync(made.file, original.replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    const check = (await studio.call("GET", "/api/projects/supplier-invoice/package/check")).json;
    expect(check.ok).toBe(false);
    expect(check.findings.join(" ")).toContain("PACKAGE_DIGEST_MISMATCH");
    expect(loadRecipePackage(readFileSync(made.file), { digest: made.digest }).ok).toBe(false);
  });

  it("a published version is immutable: the same package republishes unchanged, a different one under the same version is refused, and the Studio has no way around that", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    const { keys, channel } = await keysAndPolicy(dir);
    const publish = () => distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "e.mjs", "--json"], e1.studio.gateway);
    const first = await publish();
    expect(first.code).toBe(0);
    expect(JSON.parse((await publish()).out).status).toBe("unchanged");

    const project = (await studio.call("GET", "/api/projects/supplier-invoice")).json;
    const edit = await studio.call("POST", "/api/projects/supplier-invoice/edit", { revision: project.revision, edits: [{ op: "meta", description: "Changed after publishing" }] });
    expect(edit.status).toBe(200);
    const second = await publish();
    expect(second.code).toBe(1);
    expect(second.err).toContain("already published with different content");
    // a new version is the way forward, and it is a new product release, not a rewrite
    const next = await distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.1.0", "--key", keys, "--environment", "e.mjs", "--json"], e1.studio.gateway);
    expect(next.code, next.err).toBe(0);
    const old = JSON.parse(readFileSync(join(channel, "releases", "example", "supplier-invoice", "1.0.0.json"), "utf8"));
    expect(old.manifest.product.version).toBe("1.0.0"); // 1.0.0 still is what it was
  });

  it("an installed package altered afterwards, or a self-consistent substitute, is refused at run time, before anything is invoked", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    const made = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    const { keys, policy, channel } = await keysAndPolicy(dir);
    await distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "e.mjs"], e1.studio.gateway);
    const e2 = await studioEnvironment(dir, "consumer", { providers: [{ id: "com.globex.books", names: BOOKS_NAMES }] });
    const installed = JSON.parse((await distribution(["package", "install", "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", policy, "--store", join(dir, "installed"), "--environment", "e.mjs", "--json"], e2.studio.gateway)).out);
    const bin = join(installed.dir, "package.bin");
    const original = readFileSync(bin);
    const run = () => runtime(["recipe", "run", "--package", installed.dir, "--input", JSON.stringify(AUTO), "--environment", "e.mjs", "--home", join(dir, "run")], e2.studio.gateway);

    writeFileSync(bin, original.toString("utf8").replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    expect((await run()).code).toBe(1);
    // The Studio can make a perfectly valid *different* package; it still is not the one that was installed.
    await studio.call("POST", "/api/projects/supplier-invoice/edit", { revision: (await studio.call("GET", "/api/projects/supplier-invoice")).json.revision, edits: [{ op: "meta", name: "A different, valid recipe" }] });
    const other = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    expect(other.digest).not.toBe(made.digest);
    writeFileSync(bin, readFileSync(other.file));
    const swapped = await run();
    expect(swapped.code).toBe(1);
    expect(swapped.err).toContain("no longer is the package it was installed as");
    expect(await e2.env.ledgers["com.globex.books"]!.invoices()).toEqual([]);
    writeFileSync(bin, original);
    expect((await run()).code).toBe(0);
  });

  it("tampering with the published artifact is refused at acquisition, by the stage that owns it, and a consumer that does not trust the publisher cannot install", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    const made = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    const { keys, policy, channel } = await keysAndPolicy(dir);
    const published = JSON.parse((await distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "e.mjs", "--json"], e1.studio.gateway)).out);
    const args = ["--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", policy];
    expect((await distribution(["package", "verify", ...args], undefined)).code).toBe(0);

    // a consumer that anchors no trust on this publisher
    const strangers = join(dir, "strangers.json");
    writeFileSync(strangers, JSON.stringify({ ...JSON.parse(readFileSync(policy, "utf8")), publishers: [], documents: {} }));
    const untrusted = await distribution(["package", "verify", "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", strangers], undefined);
    expect(untrusted.code).toBe(1);
    expect(untrusted.err).toMatch(/refused at/);

    // a consumer expecting a different package than the one published
    const wrong = await distribution(["package", "verify", ...args.slice(0, 6), "--digest", "sha256:" + "ab".repeat(32), "--policy", policy], undefined);
    expect(wrong.code).toBe(1);

    // altered artifact bytes
    const artifact = join(channel, published.artifact.path);
    const original = readFileSync(artifact);
    writeFileSync(artifact, original.toString("utf8").replace("Supplier invoice processing", "Supplier invoice PROCESSING"));
    const altered = await distribution(["package", "verify", ...args], undefined);
    expect(altered.code).toBe(1);
    expect(altered.err).toMatch(/refused at \w+/);
    writeFileSync(artifact, original);
    expect((await distribution(["package", "verify", ...args], undefined)).code).toBe(0);
  });

  it("installation is refused where the providers are incompatible: none, or more than one; and authority is the environment's, never the package's", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    const made = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    const { keys, policy, channel } = await keysAndPolicy(dir);
    await distribution(["package", "publish", studio.store.recipePath("supplier-invoice"), "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--key", keys, "--environment", "e.mjs"], e1.studio.gateway);
    const install = (gateway: any, store: string) => distribution(["package", "install", "--channel", channel, "--product", PRODUCT, "--version", "1.0.0", "--digest", made.digest, "--policy", policy, "--store", join(dir, store), "--environment", "e.mjs", "--json"], gateway);

    const none = await studioEnvironment(dir, "none", { providers: [] });
    const a = await install(none.studio.gateway, "i-none");
    expect(a.code).toBe(1);
    expect(a.err).toContain('"stage":"environment"');
    const two = await studioEnvironment(dir, "two", { providers: [{ id: "com.example.ledger", names: LEDGER_NAMES }, { id: "com.globex.books", names: BOOKS_NAMES }] });
    const b = await install(two.studio.gateway, "i-two");
    expect(b.code).toBe(1);
    expect(b.err).toContain('"stage":"environment"');
    expect(existsSync(join(dir, "i-none")) || existsSync(join(dir, "i-two"))).toBe(false); // nothing half-installed

    // An environment where nothing was delegated: the package installs (it authorizes nothing), the Studio says so beforehand, and the run is refused by AppPort at the first call.
    const bare = await studioEnvironment(dir, "ungranted", { providers: [{ id: "com.globex.books", names: BOOKS_NAMES }], grant: false });
    const readiness = await (await studioServer(join(dir, "projects"), [bare.studio])).call("GET", "/api/projects/supplier-invoice/assessment");
    expect(readiness.json.verdict).toBe("blocked");
    expect(readiness.json.findings.filter((f: any) => f.code === "ACCESS_DENIED")).toHaveLength(3);
    const c = await install(bare.studio.gateway, "i-bare");
    expect(c.code, c.err).toBe(0);
    expect(JSON.parse(c.out).record.authorizes).toBe("nothing");
    const run = await runtime(["recipe", "run", "--package", JSON.parse(c.out).dir, "--input", JSON.stringify(AUTO), "--environment", "e.mjs", "--home", join(dir, "run"), "--json"], bare.studio.gateway);
    expect(run.code).not.toBe(0);
    expect(JSON.parse(run.out).outcome).not.toBe("completed");
    expect(await bare.env.ledgers["com.globex.books"]!.invoices()).toEqual([]);
  });

  it("will not package a recipe that is not sound, or one whose contracts the environment lacks, and says why", async () => {
    const dir = tempDir();
    const { e1, studio } = await author(dir);
    // not sound
    const project = (await studio.call("GET", "/api/projects/supplier-invoice")).json;
    await studio.call("POST", "/api/projects/supplier-invoice/edit", { revision: project.revision, edits: [{ op: "removeStep", id: "check-duplicate" }] });
    const broken = (await studio.call("POST", "/api/projects/supplier-invoice/package", {})).json;
    expect(broken).toMatchObject({ ok: false, stage: "source" });
    expect(broken.reasons.join(" ")).toContain("TARGET_MISSING");
    expect(existsSync(join(dir, "projects", "supplier-invoice", "recipe.package.json"))).toBe(false);

    // sound, but this environment holds no such contract to lock against
    const bare = await studioServer(join(dir, "projects"), [{ name: "empty", gateway: { async snapshot() { return { contracts: {}, providers: {} }; }, async invoke() { return { kind: "unresolved", reason: "none" }; } } }]);
    await bare.call("POST", "/api/projects", { slug: "again", recipe: supplierInvoice() });
    const locked = (await bare.call("POST", "/api/projects/again/package", {})).json;
    expect(locked).toMatchObject({ ok: false, stage: "lock" });
    expect(locked.reasons.join(" ")).toContain("org.example.accounting");
    // a draft that is not even a recipe yet is a source problem to fix, not an environment fault
    await bare.call("POST", "/api/projects", { slug: "blank", recipe: {} });
    expect((await bare.call("POST", "/api/projects/blank/package", {})).json).toMatchObject({ ok: false, stage: "source" });
    expect(e1.studio.name).toBe("publisher-env");
  });
});

describe("what the Studio's server will and will not do", () => {
  it("offers no route that grants, signs, trusts, publishes, installs or runs", async () => {
    const dir = tempDir();
    const { studio } = await author(dir);
    for (const action of ["grant", "revoke", "sign", "trust", "publish", "install", "run", "authorize"]) {
      for (const method of ["POST", "PUT", "GET"]) {
        const body = method === "GET" ? undefined : {};
        expect((await studio.call(method, `/api/projects/supplier-invoice/${action}`, body)).status, `${method} ${action}`).toBe(404);
        expect((await studio.call(method, `/api/${action}`, body)).status).toBe(404);
      }
    }
    const grantsBefore = await (await studioEnvironment(dir, "x")).env.grants.find({ consumerId: "none", providerId: "none", capabilityName: "none", capabilityVersion: 1 });
    expect(grantsBefore).toBeUndefined();
  });

  it("saving a hand-edited recipe, or an imported one, is a save like any other and cannot carry authority in", async () => {
    const dir = tempDir();
    const e = await studioEnvironment(dir, "ungranted", { grant: false });
    const studio = await studioServer(join(dir, "projects"), [e.studio]);
    const imported = await studio.call("POST", "/api/projects", { slug: "imp", recipe: { ...supplierInvoice(), grants: [{ capability: "invoice.submit" }], authority: "everything" } });
    expect(imported.status).toBe(201); // saved as given, like any draft...
    const r = (await studio.call("GET", "/api/projects/imp/assessment")).json;
    expect(r.verdict).toBe("invalid"); // ...and the recipe format has no place for it: the unknown members are source errors, not grants
    expect(r.findings.some((f: any) => f.code === "RECIPE_STRUCTURE")).toBe(true);
    expect(r.dependencies).toEqual([]);
    const fixed = await studio.call("PUT", "/api/projects/imp", { revision: imported.json.revision, recipe: supplierInvoice() });
    expect(fixed.status).toBe(200);
    const clean = (await studio.call("GET", "/api/projects/imp/assessment")).json;
    expect(clean.verdict).toBe("blocked"); // sound, and still not authorized: nothing about creating, importing or editing it changed that
    expect(clean.findings.filter((f: any) => f.code === "ACCESS_DENIED")).toHaveLength(3);
  });

  it("serves only to its own host and origin, requires the page's header and JSON for any change, and sends a locked-down page", async () => {
    const dir = tempDir();
    const { studio } = await author(dir);
    expect(await rawStatus(studio.origin, "/api/projects", "evil.example")).toBe(421); // fetch will not forge a Host header; a raw request does
    expect(await rawStatus(studio.origin, "/api/projects", new URL(studio.origin).host)).toBe(200);
    expect((await studio.call("POST", "/api/projects", { slug: "x" }, { "x-appworks-request": "" })).status).toBe(403);
    expect((await studio.call("POST", "/api/projects", { slug: "x" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await studio.call("PUT", "/api/projects/supplier-invoice", { revision: 1 }, { "content-type": "text/plain" })).status).toBe(422);
    const page = await fetch(`${studio.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await (await fetch(`${studio.origin}/ui/studio.js`)).text()).not.toMatch(/innerHTML|eval\(|new Function/);
    expect((await fetch(`${studio.origin}/ui/../src/server.ts`)).status).toBe(404);
  });

  it("refuses to save over a newer revision, over HTTP, and loses nothing", async () => {
    const dir = tempDir();
    const { studio, revision } = await author(dir);
    const stale = await studio.call("POST", "/api/projects/supplier-invoice/edit", { revision: revision - 1, edits: [{ op: "meta", name: "stale" }] });
    expect(stale.status).toBe(409);
    expect(new StudioStore(join(dir, "projects")).open("supplier-invoice").meta.revision).toBe(revision);
  });
});
