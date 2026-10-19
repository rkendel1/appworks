// Behavioral verification of memos.reactions.list@1 against the real Memos operation (extraction revision 2).
//
// A real Memos server built from the source revision (MEMOS_REPO) into a temporary directory, with the build the plan's
// runtime declares (-buildvcs=false, injected version; MEMOS_BIN reuses another build, which is then recorded as an
// undeclared runtime), and the real bridge, with the adapter and its fulfillment declaration added (runtime/host.mjs).
// The Memos bridge's own harness creates synthetic users and memos through Memos' API. Every AppPort answer is compared
// with the answer of the ORIGINAL operation (Memos' own HTTP API, same caller, same credential, same input) and, for
// results, with Memos' database read directly (read-only). Each test says what it ran against: the real application,
// a stub application (failure modes a real Memos cannot be made to produce), or nothing (static and protocol checks).
//
//   MEMOS_REPO=<checkout at e0ce856> node --import ./runtime/register.mjs --test test/behavior.test.mjs
//
// APPWORKS_HOST_DIR replaces runtime/ by another directory holding host.mjs and adapter.mjs (scripts/mutations.mjs
// runs this suite against deliberately broken adapters this way; such runs are never recorded). With
// APPWORKS_RECORD_PROMOTED_HOST=1 a run against another host directory is recorded only if that directory is a
// byte-for-byte copy of the verified host, adapter, declaration and contract (promotion/verify.mjs: the copy promoted
// into the application's repository); a mutant never is.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FULFILLMENT_EXTENSION, canonicalize, claimFor, claimsFor, compareSchemas, evaluateFulfillment, findCapabilityVersion } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { toCapabilityOutput } from "../runtime/adapter.mjs";
import { confirmPublished } from "../runtime/declaration.mjs";
import { BUILT, HERE, MEMOS_BUILD, PINNED_REVISION, behavior, contract, isVerifiedHostCopy, plan, subjectOf, treeHash, writeResults } from "./support/verification.mjs";

const repo = process.env.MEMOS_REPO ? resolve(process.env.MEMOS_REPO) : undefined;
if (!repo) {
  test("behavioral verification needs a Memos checkout (MEMOS_REPO)", { skip: "MEMOS_REPO is not set" }, () => {});
} else {
  const load = (path) => import(pathToFileURL(join(repo, "appport-bridge", path)).href);
  const { startMemos } = await load("test/support/memos-app.mjs");
  const { startProcess, freePort, http, openOracle, removeDir } = await load("lib/harness.mjs");
  const { discover, connect, invoke } = await load("lib/consumer.mjs");

  const NAME = "memos.reactions.list";
  const PROVIDER = plan.fulfillment.provider;
  const HOST_DIR = process.env.APPWORKS_HOST_DIR ? resolve(process.env.APPWORKS_HOST_DIR) : join(HERE, "runtime");
  const DECLARATION = JSON.parse(readFileSync(join(HERE, "runtime", "fulfillment.json"), "utf8"));
  const CLAIM = DECLARATION.attributes[FULFILLMENT_EXTENSION].capabilities[`${PROVIDER.capability}@${PROVIDER.version}`][0];
  const entry = findCapabilityVersion(contract, NAME, 1);
  const outputSchema = fromJSONSchema(entry.outputSchema);
  const STATUS_CODE = { 400: "INVALID_INPUT", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND" };
  const node = (script, env) => startProcess(process.execPath, ["--import", join(HERE, "runtime", "register.mjs"), script], { env: { MEMOS_REPO: repo, ...env }, readyLine: true, name: script, timeoutMs: 20_000 });
  const startHost = async (env = {}) => node(join(HOST_DIR, "host.mjs"), { APPPORT_BRIDGE_PORT: String(await freePort()), ...env });

  let app, host, bridge, origin, oracle, before_, stub, stubHost, startedAt;
  let memosStopped = false;
  const memos = {};
  const clients = [];
  const outputs = [];
  const as = async (who) => {
    const c = await connect(origin, who ? app.users[who].credential : undefined);
    clients.push(c);
    return c;
  };
  /** The original operation: Memos' own HTTP API with the caller's own credential. */
  const original = (who, memo, query = "") => http(app.base, "GET", `/api/${memo}/reactions${query}`, { headers: who ? { authorization: typeof who === "string" && who.startsWith("Bearer") ? who : app.users[who].credential } : {} });
  /** Memos' own reaction table, read directly. */
  const stored = (memo) =>
    oracle.all(`SELECT r.id, u.username, r.reaction_type FROM reaction r JOIN memo m ON m.id = r.memo_id JOIN user u ON u.id = r.creator_id WHERE m.uid = ? ORDER BY r.id`, memo.replace(/^memos\//, "")).map((r) => ({ name: `${memo}/reactions/${r.id}`, creator: `users/${r.username}`, reactionType: r.reaction_type }));
  const keys = (v, at = "") => (Array.isArray(v) ? v.flatMap((x) => keys(x, `${at}[]`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${at}/${k}`, ...keys(x, `${at}/${k}`)]) : []);
  const hasNull = (v) => v === null || (typeof v === "object" && Object.values(v).some(hasNull));
  const withoutDeclaration = (manifest) => ({
    extensions: (manifest.extensions ?? []).filter((e) => e !== FULFILLMENT_EXTENSION),
    attributes: Object.fromEntries(Object.entries(manifest.attributes ?? {}).filter(([k]) => k !== FULFILLMENT_EXTENSION))
  });
  const declarationFile = (content) => {
    const path = join(mkdtempSync(join(tmpdir(), "declaration-")), "fulfillment.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };

  before(async () => {
    startedAt = new Date().toISOString();
    before_ = treeHash(repo);
    // Build Memos outside the checkout, as the plan's runtime declares, unless a build is given. VCS stamping would run
    // git in the checkout (touching .git), so the version Memos derives for this revision is injected instead.
    if (!process.env.MEMOS_BIN) {
      const out = join(mkdtempSync(join(tmpdir(), "memos-build-")), "memos");
      const flags = Object.entries(MEMOS_BUILD).map(([k, v]) => `-X github.com/usememos/memos/internal/version.${k}=${v}`).join(" ");
      execFileSync("go", ["build", "-buildvcs=false", "-ldflags", flags, "-o", out, "./cmd/memos"], { cwd: repo, stdio: "inherit" });
      process.env.MEMOS_BIN = out;
      BUILT.declared = true;
    }
    app = await startMemos();
    oracle = await openOracle(join(app.work, "data", "memos_prod.db"));
    Object.assign(memos, app.notes);
    const created = await http(app.base, "POST", "/api/memos", { headers: { authorization: app.users.bob.credential }, body: { content: "Synthetic note #gamma: protected turnips", visibility: "PROTECTED" } });
    assert.equal(created.status, 200);
    memos.bobProtected = created.json.name;
    const react = async (who, memo, reactionType) => {
      const r = await http(app.base, "POST", `/api/${memo}/reactions`, { headers: { authorization: app.users[who].credential }, body: { parent: memo, reaction: { contentId: memo, reactionType } } });
      assert.equal(r.status, 200, r.text);
    };
    await react("bob", memos.bobPublic, "👍");
    await react("carol", memos.bobPublic, "🎉");
    await react("admin0", memos.bobPublic, "❤️");
    await react("bob", memos.bobPrivate, "👀");
    await react("carol", memos.bobProtected, "✅");
    host = await startHost({ APPPORT_BRIDGE_UPSTREAM: app.base, APPPORT_BRIDGE_PUBLIC: "1" });
    origin = host.ready.url;
  });

  after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await stubHost?.stop();
    await bridge?.stop();
    await host?.stop();
    stub?.close();
    oracle?.close();
    if (!memosStopped) await app?.stop();
    if (app) removeDir(app.work);
    const recordable = !process.env.APPWORKS_HOST_DIR || (process.env.APPWORKS_RECORD_PROMOTED_HOST === "1" && isVerifiedHostCopy(HOST_DIR));
    if (recordable) writeResults(subjectOf(repo), { startedAt, finishedAt: new Date().toISOString(), runner: `node ${process.version}` });
  });

  behavior(["integration.source-revision"], "integration-test", "real-application", "the checkout is the pinned source revision", () => {
    assert.equal(subjectOf(repo).sourceRevision, PINNED_REVISION);
  });

  // ---- declaration and discovery ----

  behavior(["integration.discoverable"], "integration-test", "real-application", "the capability is discoverable through the bridge, beside the bridge's own", async () => {
    const found = await discover(origin);
    assert.equal(found.state, "reference-verified", found.reasons.join());
    const listed = found.capabilities.find((c) => c.name === NAME);
    assert.equal(listed?.status, "verified");
    assert.equal(listed.declared.effect, "observation");
    assert.deepEqual(listed.declared.authorization, { scopes: ["memos.read"] });
    assert.deepEqual(found.capabilities.map((c) => c.name).sort(), ["memos.get", "memos.reactions.list", "memos.search"]);
  });

  behavior(["integration.fulfillment-claim"], "integration-test", "real-application", "AppPort client discovery returns the published declaration, and evaluateFulfillment finds the claim valid", async () => {
    const manifest = (await as(undefined)).manifest; // the normal discovery path: appport.manifest, no credential needed to read it
    assert.ok(manifest.extensions.includes(FULFILLMENT_EXTENSION));
    assert.equal(canonicalize(manifest.attributes[FULFILLMENT_EXTENSION]), canonicalize(DECLARATION.attributes[FULFILLMENT_EXTENSION]));
    const found = claimsFor(manifest, { contract: contract.application.id, capability: NAME, version: 1 });
    assert.equal(canonicalize(found), canonicalize([{ capability: { name: PROVIDER.capability, version: PROVIDER.version }, claim: claimFor(contract, NAME, 1) }]));
    assert.equal(manifest.application.id, PROVIDER.application);
    const evaluation = evaluateFulfillment({ canonical: contract, provider: manifest, capability: { name: PROVIDER.capability, version: PROVIDER.version }, claim: found[0].claim });
    assert.equal(evaluation.status, "valid", JSON.stringify(evaluation.findings));
    assert.deepEqual(evaluation.findings, []);
    assert.deepEqual(evaluation.compatibility, { compatible: true, breaking: [], nonBreaking: [] });
  });

  behavior(["integration.discoverable", "authorization.no-bypass"], "integration-test", "real-application", "the host adds exactly one capability and its declaration to the unmodified bridge", async () => {
    bridge = await node(join(repo, "appport-bridge", "bridge.mjs"), { APPPORT_BRIDGE_UPSTREAM: app.base, APPPORT_BRIDGE_PORT: String(await freePort()), APPPORT_BRIDGE_PUBLIC: "1" });
    const original_ = await connect(bridge.ready.url, app.users.bob.credential);
    clients.push(original_);
    const o = original_.manifest;
    const h = (await as("bob")).manifest;
    assert.equal(canonicalize(h.application), canonicalize(o.application));
    assert.equal(canonicalize(h.resources ?? null), canonicalize(o.resources ?? null));
    const ho = withoutDeclaration(h);
    assert.deepEqual(ho.extensions.sort(), [...(o.extensions ?? [])].sort());
    assert.equal(canonicalize(ho.attributes), canonicalize({ ...(o.attributes ?? {}), "appport.integration/1": { ...o.attributes["appport.integration/1"], capabilities: { ...o.attributes["appport.integration/1"].capabilities, [`${NAME}@1`]: h.attributes["appport.integration/1"].capabilities[`${NAME}@1`] } } }));
    for (const name of ["memos.search", "memos.get"]) assert.equal(canonicalize(h.capabilities.find((c) => c.name === name)), canonicalize(o.capabilities.find((c) => c.name === name)));
    assert.deepEqual(h.capabilities.map((c) => c.name).sort(), [...o.capabilities.map((c) => c.name), NAME].sort());
  });

  behavior(["integration.declaration-fails-closed"], "integration-test", "real-application", "a bridge that does not publish the declaration is refused (FULFILLMENT_UNPUBLISHED), and its manifest is claim.undeclared", async () => {
    // The unmodified bridge publishes no declaration: what the host refuses to serve, and what AppPort calls undeclared.
    await assert.rejects(confirmPublished(bridge.ready.url, DECLARATION, PROVIDER), (e) => e.code === "FULFILLMENT_UNPUBLISHED");
    const undeclared = (await as("bob")).manifest;
    const stripped = { ...undeclared, ...withoutDeclaration(undeclared) };
    const evaluation = evaluateFulfillment({ canonical: contract, provider: stripped, capability: { name: NAME, version: 1 }, claim: CLAIM });
    assert.deepEqual([evaluation.status, evaluation.findings.map((f) => f.kind)], ["invalid", ["claim.undeclared"]]);
    await bridge.stop();
    bridge = null;
  });

  behavior(["integration.declaration-fails-closed"], "integration-test", "real-application", "missing, malformed, mismatched and stale declarations stop the host with a reason code", async () => {
    const otherContract = { ...CLAIM, contract: "org.example.other" };
    const staleClaim = { ...CLAIM, digest: `sha256:${"0".repeat(64)}` };
    const withClaims = (claims) => ({ ...DECLARATION, attributes: { [FULFILLMENT_EXTENSION]: { capabilities: { [`${NAME}@1`]: claims } } } });
    const cases = [
      ["FULFILLMENT_MISSING", join(tmpdir(), "does-not-exist", "fulfillment.json")],
      ["FULFILLMENT_MALFORMED", declarationFile("{ not json")],
      ["FULFILLMENT_MALFORMED", declarationFile({ extensions: [], attributes: {} })],
      ["FULFILLMENT_MISSING", declarationFile(withClaims([]))],
      ["FULFILLMENT_MISMATCH", declarationFile(withClaims([otherContract]))],
      ["FULFILLMENT_MISMATCH", declarationFile(withClaims([CLAIM, CLAIM]))],
      ["FULFILLMENT_STALE", declarationFile(withClaims([staleClaim]))]
    ];
    for (const [code, path] of cases) {
      const started = await startHost({ APPPORT_BRIDGE_UPSTREAM: app.base, APPWORKS_FULFILLMENT_DECLARATION: path }).catch((error) => error);
      if (!(started instanceof Error)) {
        await started.stop();
        assert.fail(`the host started with a declaration that should be refused (${code})`);
      }
      assert.ok(started.message.includes(code), `${code} for ${path}: ${started.message.slice(0, 300)}`);
    }
  });

  behavior(["integration.declaration-fails-closed"], "protocol-check", "none", "a changed contract makes the published claim stale: declaration evidence is not reused for another contract", async () => {
    const live = (await as("bob")).manifest;
    const changed = structuredClone(contract);
    changed.capabilities[0].description = changed.capabilities[0].definitions[0].description = "a changed contract";
    const evaluation = evaluateFulfillment({ canonical: changed, provider: live, capability: { name: NAME, version: 1 }, claim: CLAIM });
    assert.equal(evaluation.status, "stale");
    assert.ok(evaluation.findings.some((f) => f.kind === "claim.stale"));
  });

  behavior(["contract.interface-conformance"], "protocol-check", "real-application", "the advertised capability is exactly the contract (compareSchemas both directions)", async () => {
    const live = (await as("bob")).manifest.capabilities.find((c) => c.name === NAME);
    for (const [a, b] of [[entry, live], [live, entry]]) {
      assert.deepEqual(compareSchemas(a.inputSchema, b.inputSchema, "input", "input"), []);
      assert.deepEqual(compareSchemas(a.outputSchema, b.outputSchema, "output", "output"), []);
    }
    for (const k of ["inputSchema", "outputSchema", "kind", "effect", "authorization", "authorizationContract", "idempotency"]) assert.equal(canonicalize(live[k]), canonicalize(entry[k]), k);
  });

  // ---- behavior against the original operation ----

  const users = ["bob", "carol", "admin0"];
  const memoKeys = ["bobPublic", "bobPrivate", "bobProtected", "carolPrivate"];

  behavior(["contract.output-shape", "authorization.permitted-results", "integration.real-operation", "errors.denial-distinguishable"], "integration-test", "real-application", "for every caller and memo, the capability answers exactly as the original operation", async () => {
    let compared = 0;
    for (const who of users) {
      const client = await as(who);
      for (const key of memoKeys) {
        const direct = await original(who, memos[key]);
        const out = await invoke(client, NAME, { parent: memos[key] });
        if (direct.status === 200) {
          assert.equal(out.kind, "response", `${who} ${key}: ${out.code}`);
          assert.deepEqual(out.output, direct.json, `${who} ${key}`);
          assert.ok(outputSchema.validate(out.output).ok, `${who} ${key}: output matches the contract`);
          // Independent of both answers: what Memos stored.
          assert.deepEqual(out.output.reactions.map(({ name, creator, reactionType }) => ({ name, creator, reactionType })), stored(memos[key]));
          outputs.push(out.output);
        } else {
          assert.equal(out.kind, direct.status === 404 ? "application-error" : "denied", `${who} ${key}`);
          assert.equal(out.code, STATUS_CODE[direct.status], `${who} ${key}: Memos ${direct.status}`);
        }
        compared++;
      }
    }
    assert.equal(compared, 12);
  });

  behavior(["authorization.resource-restriction", "errors.denial-distinguishable"], "integration-test", "real-application", "carol is denied bob's private memo, which exists and has reactions; admins and PROTECTED readers are not", async () => {
    assert.equal((await original("carol", memos.bobPrivate)).status, 403);
    const out = await invoke(await as("carol"), NAME, { parent: memos.bobPrivate });
    assert.deepEqual([out.kind, out.code], ["denied", "FORBIDDEN"]);
    assert.equal(stored(memos.bobPrivate).length, 1, "a real denial: the memo exists and has a reaction");
    const admin = await invoke(await as("admin0"), NAME, { parent: memos.bobPrivate });
    assert.equal(admin.output.reactions.length, 1, "Memos lets instance administrators read any memo");
    const protectedRead = await invoke(await as("carol"), NAME, { parent: memos.bobProtected });
    assert.deepEqual(protectedRead.output.reactions.map((r) => r.creator), ["users/carol"]);
  });

  behavior(["authorization.unauthenticated-denied", "errors.denial-distinguishable"], "integration-test", "real-application", "no credential and an invalid credential are denied, as by the original operation", async () => {
    assert.equal((await original(undefined, memos.bobPublic)).status, 401);
    const anonymous = await invoke(await as(undefined), NAME, { parent: memos.bobPublic });
    assert.deepEqual([anonymous.kind, anonymous.code], ["denied", "UNAUTHORIZED"]);
    const forged = "Bearer memos_pat_not-a-real-token";
    assert.equal((await original(forged, memos.bobPublic)).status, 401);
    const c = await connect(origin, forged);
    clients.push(c);
    const out = await invoke(c, NAME, { parent: memos.bobPublic });
    assert.deepEqual([out.kind, out.code], ["denied", "UNAUTHORIZED"]);
  });

  behavior(["authorization.discovery-not-authority"], "integration-test", "real-application", "discovering the capability grants nothing: invoking it still needs the caller's credential", async () => {
    const found = await discover(origin);
    assert.ok(found.capabilities.some((c) => c.name === NAME));
    assert.deepEqual(found.established, { publisherTrust: false, authorization: false, approval: false, invoked: false });
    const out = await invoke(await as(undefined), NAME, { parent: memos.bobPublic });
    assert.equal(out.code, "UNAUTHORIZED");
  });

  behavior(["authorization.claim-not-authority"], "integration-test", "real-application", "with the claim published and valid, callers without authority stay denied", async () => {
    const manifest = (await as(undefined)).manifest;
    assert.equal(evaluateFulfillment({ canonical: contract, provider: manifest, capability: { name: NAME, version: 1 }, claim: CLAIM }).status, "valid");
    assert.equal((await invoke(await as(undefined), NAME, { parent: memos.bobPublic })).code, "UNAUTHORIZED");
    const forged = await connect(origin, "Bearer memos_pat_not-a-real-token");
    clients.push(forged);
    assert.equal((await invoke(forged, NAME, { parent: memos.bobPublic })).code, "UNAUTHORIZED");
    assert.equal((await invoke(await as("carol"), NAME, { parent: memos.bobPrivate })).code, "FORBIDDEN", "Memos' access check still decides");
  });

  behavior(["contract.empty-and-multiple"], "integration-test", "real-application", "zero, one and several reactions, in Memos' order", async () => {
    const carol = await as("carol");
    const bob = await as("bob");
    const none = await invoke(carol, NAME, { parent: memos.carolPrivate });
    assert.deepEqual(none.output, { reactions: [], nextPageToken: "" });
    assert.deepEqual((await original("carol", memos.carolPrivate)).json, none.output);
    assert.equal((await invoke(bob, NAME, { parent: memos.bobPrivate })).output.reactions.length, 1);
    const several = await invoke(bob, NAME, { parent: memos.bobPublic });
    assert.deepEqual(several.output.reactions.map((r) => r.reactionType), ["👍", "🎉", "❤️"]);
    assert.deepEqual(several.output.reactions.map((r) => r.name), stored(memos.bobPublic).map((r) => r.name));
  });

  behavior(["contract.no-field-omitted"], "integration-test", "real-application", "every field of the original answer appears in the capability output", async () => {
    for (const who of users) {
      const client = await as(who);
      for (const key of memoKeys) {
        const direct = await original(who, memos[key]);
        if (direct.status !== 200) continue;
        const out = await invoke(client, NAME, { parent: memos[key] });
        assert.deepEqual(keys(out.output).sort(), keys(direct.json).sort());
      }
    }
  });

  behavior(["contract.no-sensitive-data"], "integration-test", "real-application", "outputs carry only contracted fields: no credential, secret or unrelated personal data", async () => {
    assert.ok(outputs.length >= 6, "the comparison above recorded the outputs");
    const allowed = ["/nextPageToken", "/reactions", "/reactions[]/createTime", "/reactions[]/creator", "/reactions[]/name", "/reactions[]/reactionType"];
    const credentials = Object.values(app.users).map((u) => u.credential.replace(/^Bearer /, ""));
    for (const out of outputs) {
      for (const k of keys(out)) assert.ok(allowed.includes(k), `uncontracted field ${k}`);
      const text = JSON.stringify(out);
      for (const c of credentials) assert.ok(!text.includes(c), "a caller's credential appears in an output");
      assert.doesNotMatch(text, /memos_pat_|password|secret|[\w.+-]+@[\w-]+\.[\w.]+/i);
    }
  });

  behavior(["contract.optional-fields"], "integration-test", "real-application", "optional page fields pass through with Memos' semantics, and nothing is null", async () => {
    const bob = await as("bob");
    const plain = await invoke(bob, NAME, { parent: memos.bobPublic });
    const paged = await invoke(bob, NAME, { parent: memos.bobPublic, pageSize: 1, pageToken: "next" });
    assert.deepEqual(paged.output, (await original("bob", memos.bobPublic, "?pageSize=1&pageToken=next")).json);
    assert.deepEqual(paged.output, plain.output, "Memos ignores page_size and page_token for this operation");
    assert.equal(hasNull(plain.output), false);
    assert.equal((await invoke(bob, NAME, { parent: memos.bobPublic, pageSize: null })).code, "INVALID_INPUT", "null is not absent: the contract refuses it");
  });

  behavior(["contract.optional-fields", "errors.failure-not-success"], "unit-test", "none", "the output mapping applies proto3 defaults and refuses every other deviation", () => {
    assert.deepEqual(toCapabilityOutput({}), { reactions: [], nextPageToken: "" });
    assert.deepEqual(toCapabilityOutput({ reactions: null, nextPageToken: null }), { reactions: [], nextPageToken: "" });
    for (const bad of [null, [], "x", { reactions: "x" }, { reactions: [null] }, { reactions: [{ name: "n", creator: "c", reactionType: 1, createTime: "t" }] }, { reactions: [], nextPageToken: 3 }])
      assert.throws(() => toCapabilityOutput(bad), (e) => e.code === "INTERNAL_ERROR");
  });

  behavior(["contract.invalid-input", "errors.deliberate-mapping"], "integration-test", "real-application", "invalid input is refused by the contract; names Memos cannot resolve are NOT_FOUND, as in the original", async () => {
    const bob = await as("bob");
    for (const input of [{}, { parent: "../users/bob" }, { parent: "memos/a/b" }, { parent: 'memos/x"y' }, { parent: "memos/ok", extra: 1 }, { parent: "memos/ok", pageSize: 2 ** 31 }, { parent: "memos/ok", pageSize: 1.5 }, { parent: 7 }])
      assert.equal((await invoke(bob, NAME, input)).code, "INVALID_INPUT", JSON.stringify(input));
    assert.equal((await original("bob", "memos/doesnotexist000")).status, 404);
    const missing = await invoke(bob, NAME, { parent: "memos/doesnotexist000" });
    assert.deepEqual([missing.kind, missing.code], ["application-error", "NOT_FOUND"]);
    assert.equal(oracle.get("SELECT 1 AS x FROM memo WHERE uid = ?", "doesnotexist000"), undefined);
  });

  behavior(["authorization.no-bypass", "integration.real-operation"], "static-check", "none", "the adapter holds no credential, reads no database and calls only Memos' own API", () => {
    const source = (file) => readFileSync(join(HOST_DIR, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const adapter = source("adapter.mjs");
    const hostSource = source("host.mjs");
    const declaration = readFileSync(join(HERE, "runtime", "declaration.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.deepEqual([...adapter.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["@appport/sdk"]);
    for (const [name, text] of [["adapter", adapter], ["host", hostSource], ["declaration", declaration]]) {
      for (const forbidden of [/sqlite|database|\.db\b/i, /memos_pat_|Bearer\s+\w/, /child_process|node:http\b|node:net\b/, /authorization:\s*["'`]/])
        assert.doesNotMatch(text, forbidden, `${name}: ${forbidden}`);
    }
    for (const [name, text] of [["adapter", adapter], ["host", hostSource]]) assert.doesNotMatch(text, /\bfetch\s*\(/, `${name} calls fetch`);
    // The declaration module reads only the bridge's own manifest.
    assert.deepEqual([...declaration.matchAll(/fetch\(new URL\("([^"]+)"/g)].map((m) => m[1]), ["appport/manifest"]);
    assert.deepEqual([...adapter.matchAll(/path: `([^`]+)`/g)].map((m) => m[1]), ["/api/${parent}/reactions"]);
    assert.match(hostSource, /callApplication: kit\.callApplication/);
    assert.match(hostSource, /headers: \(credential\) => \(\{ authorization: credential \}\)/, "the upstream credential is the caller's, unchanged");
  });

  behavior(["authorization.no-bypass", "authorization.permitted-results"], "integration-test", "real-application", "the caller's own credential decides, call by call: bob, carol and bob again", async () => {
    const forBob = await invoke(await as("bob"), NAME, { parent: memos.bobPrivate });
    const forCarol = await invoke(await as("carol"), NAME, { parent: memos.bobPrivate });
    const again = await invoke(await as("bob"), NAME, { parent: memos.bobPrivate });
    assert.equal(forBob.kind, "response");
    assert.equal(forCarol.code, "FORBIDDEN", "carol does not inherit the credential of an earlier caller");
    assert.deepEqual(again.output, forBob.output);
  });

  behavior(["errors.failure-not-success", "errors.deliberate-mapping"], "unit-test", "stub-application", "a failing, unreachable or malformed application is an error, never a success (stub application)", async () => {
    const answers = {
      "/api/memos/fail/reactions": [500, '{"code":13,"message":"internal"}'],
      "/api/memos/unavailable/reactions": [503, "{}"],
      "/api/memos/notjson/reactions": [200, "<html>"],
      "/api/memos/badshape/reactions": [200, '{"reactions":[{"name":1}]}'],
      "/api/memos/notalist/reactions": [200, '{"reactions":"x"}'],
      "/api/memos/redirect/reactions": [302, ""],
      "/api/memos/empty/reactions": [200, "{}"]
    };
    let requests = 0;
    stub = createServer((req, res) => {
      requests++;
      const [status, body] = answers[new URL(req.url, "http://x").pathname] ?? [404, "{}"];
      res.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "http://example.invalid/" } : {}) });
      res.end(body);
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    stubHost = await startHost({ APPPORT_BRIDGE_UPSTREAM: `http://127.0.0.1:${stub.address().port}` });
    const c = await connect(stubHost.ready.url, "Bearer stub-credential");
    clients.push(c);
    for (const uid of ["fail", "unavailable", "notjson", "badshape", "notalist", "redirect"]) {
      const out = await invoke(c, NAME, { parent: `memos/${uid}` });
      assert.notEqual(out.kind, "response", uid);
      assert.equal(out.code, "INTERNAL_ERROR", uid);
    }
    assert.deepEqual((await invoke(c, NAME, { parent: "memos/empty" })).output, { reactions: [], nextPageToken: "" });
    const seen = requests;
    assert.equal((await invoke(c, NAME, { parent: "../etc" })).code, "INVALID_INPUT");
    assert.equal(requests, seen, "invalid input never reaches the application");
    stub.close();
    const gone = await invoke(c, NAME, { parent: "memos/fail" });
    assert.equal(gone.code, "INTERNAL_ERROR", "an unreachable application is an error");
  });

  behavior(["errors.failure-not-success"], "integration-test", "real-application", "a failed invocation is not reported as a fulfilled result: Memos stopped, the claim still published", async () => {
    // Last before the immutability check: the real Memos is stopped under the running host.
    const bob = await as("bob");
    assert.equal((await invoke(bob, NAME, { parent: memos.bobPublic })).kind, "response");
    await app.stop();
    memosStopped = true;
    const out = await invoke(bob, NAME, { parent: memos.bobPublic });
    assert.notEqual(out.kind, "response");
    assert.equal(out.code, "INTERNAL_ERROR");
    assert.equal(evaluateFulfillment({ canonical: contract, provider: (await as(undefined)).manifest, capability: { name: NAME, version: 1 }, claim: CLAIM }).status, "valid", "a valid declaration says nothing about whether a call succeeded");
  });

  behavior(["integration.source-revision"], "integration-test", "real-application", "the checkout is unchanged by the run", async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {});
    await stubHost?.stop();
    stubHost = null;
    await host.stop();
    host = null;
    assert.equal(treeHash(repo), before_);
  });
}
