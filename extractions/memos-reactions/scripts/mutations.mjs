#!/usr/bin/env node
// Mutation check: the behavioral suite must catch known adapter and host defects. Each mutant is a copy of runtime/
// (in .mutations/<name>/, git-ignored, inside this package so it resolves the same packages) with one deliberate
// defect; the suite runs against it (APPWORKS_HOST_DIR) on a real Memos, and the named tests must fail. A mutant
// the suite does not catch fails this script. Mutant runs are never recorded as verification results.
//
//   MEMOS_REPO=<checkout at e0ce856> node scripts/mutations.mjs
//
// APPWORKS_MUTATION_SOURCE names another directory holding runtime/ and contract.json to mutate copies of (the host
// promoted into the application, promotion/verify.mjs); by default this package's own.
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MEMOS_BUILD } from "../test/support/verification.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.MEMOS_REPO ? resolve(process.env.MEMOS_REPO) : undefined;
if (!repo) {
  console.error("MEMOS_REPO is not set");
  process.exit(2);
}

const source = process.env.APPWORKS_MUTATION_SOURCE ? resolve(process.env.APPWORKS_MUTATION_SOURCE) : here;

const replace = (from, to) => (text) => {
  if (!text.includes(from)) throw new Error(`mutation does not apply: ${from}`);
  return text.replace(from, to);
};
const MUTANTS = [
  {
    name: "fabricate-field",
    file: "adapter.mjs",
    patch: replace("createTime: text(r.createTime, `reactions[${i}].createTime`)", 'createTime: "1970-01-01T00:00:00Z"'),
    caughtBy: ["for every caller and memo, the capability answers exactly as the original operation"]
  },
  {
    name: "fabricate-data",
    file: "adapter.mjs",
    patch: replace("return toCapabilityOutput(body);", 'return { reactions: [{ name: `${parent}/reactions/1`, creator: "users/bob", reactionType: "👍", createTime: "2026-01-01T00:00:00Z" }], nextPageToken: "" };'),
    caughtBy: ["for every caller and memo, the capability answers exactly as the original operation", "zero, one and several reactions, in Memos' order"]
  },
  {
    name: "swallow-errors",
    file: "adapter.mjs",
    patch: replace(
      "const body = await callApplication(ctx, upstream, { path: `/api/${parent}/reactions`, query: { pageSize, pageToken } });",
      "let body;\n      try { body = await callApplication(ctx, upstream, { path: `/api/${parent}/reactions`, query: { pageSize, pageToken } }); } catch { body = {}; }"
    ),
    caughtBy: ["carol is denied bob's private memo, which exists and has reactions; admins and PROTECTED readers are not", "a failing, unreachable or malformed application is an error, never a success (stub application)"]
  },
  {
    name: "reuse-first-credential",
    file: "host.mjs",
    patch: replace("const upstream = { baseUrl: config.upstream, headers: (credential) => ({ authorization: credential }) };", "let first;\n  const upstream = { baseUrl: config.upstream, headers: (credential) => ({ authorization: (first ??= credential) }) };"),
    caughtBy: ["the caller's own credential decides, call by call: bob, carol and bob again", "the adapter holds no credential, reads no database and calls only Memos' own API"]
  },
  {
    name: "publish-no-declaration",
    file: "host.mjs",
    patch: (text) => replace("    extensions: declaration.extensions,\n    attributes: declaration.attributes\n", "")(replace("    await confirmPublished(running.url, declaration, CAPABILITY);", "")(text)),
    caughtBy: ["AppPort client discovery returns the published declaration, and evaluateFulfillment finds the claim valid"]
  },
  {
    name: "publish-stale-claim",
    file: "host.mjs",
    patch: replace(
      "const declaration = loadDeclaration({",
      'const declaration = { ...JSON.parse((await import("node:fs")).readFileSync(join(here, "fulfillment.json"), "utf8")) };\nfor (const claims of Object.values(declaration.attributes["appport.fulfillment/1"].capabilities)) claims[0].digest = `sha256:${"0".repeat(64)}`;\nconst unchecked = ({'
    ),
    caughtBy: ["AppPort client discovery returns the published declaration, and evaluateFulfillment finds the claim valid"]
  }
];

// One Memos build for every mutant, as the plan's runtime declares, outside the checkout.
const build = join(mkdtempSync(join(tmpdir(), "memos-build-")), "memos");
execFileSync("go", ["build", "-buildvcs=false", "-ldflags", Object.entries(MEMOS_BUILD).map(([k, v]) => `-X github.com/usememos/memos/internal/version.${k}=${v}`).join(" "), "-o", build, "./cmd/memos"], { cwd: repo, stdio: "inherit" });

const root = join(here, ".mutations");
rmSync(root, { recursive: true, force: true });
let survived = 0;
for (const mutant of MUTANTS) {
  const dir = join(root, mutant.name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(source, "runtime"), join(dir, "runtime"), { recursive: true });
  cpSync(join(source, "contract.json"), join(dir, "contract.json"));
  const target = join(dir, "runtime", mutant.file);
  writeFileSync(target, mutant.patch(readFileSync(target, "utf8")));
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", join(here, "runtime", "register.mjs"), "--test", "--test-concurrency=1", join(here, "test", "behavior.test.mjs")], {
    cwd: here,
    env: { ...process.env, MEMOS_REPO: repo, MEMOS_BIN: build, APPWORKS_HOST_DIR: join(dir, "runtime"), APPWORKS_VERIFICATION_OUT: "" },
    encoding: "utf8"
  });
  const failed = [...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const missed = mutant.caughtBy.filter((name) => !failed.includes(name));
  const killed = run.status !== 0 && missed.length === 0;
  if (!killed) survived++;
  console.log(`${killed ? "caught  " : "SURVIVED"} ${mutant.name}: ${failed.length} tests failed${missed.length ? `; expected failures that did not happen: ${missed.join("; ")}` : ""}`);
}
rmSync(root, { recursive: true, force: true });
console.log(survived ? `${survived} of ${MUTANTS.length} mutants survived` : `all ${MUTANTS.length} mutants were caught`);
process.exit(survived ? 1 : 0);
