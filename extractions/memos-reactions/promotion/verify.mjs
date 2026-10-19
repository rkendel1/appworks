#!/usr/bin/env node
// Verifies the promoted copy of this extraction in a promotion worktree: the AppWorks workspace's promotion runner
// contract (spec/workspace-1.md §12).
//
//   node promotion/verify.mjs --repo <worktree> --host <worktree>/appport-bridge/appworks/memos-reactions/runtime --output <file> [--mutations]
//
// It runs this extraction's own behavioral suite with the PROMOTED host (APPWORKS_HOST_DIR) on the worktree
// (MEMOS_REPO), building Memos as the plan's runtime declares. The suite records results only if the promoted host is
// a byte-for-byte copy of the verified one. With --mutations, the mutation check runs against copies of the promoted
// host. The worktree must not change. It writes one JSON summary to --output and exits 0 only if everything passed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { treeHash } from "../test/support/verification.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  const v = at === -1 ? undefined : args[at + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${flag} is required`);
    process.exit(2);
  }
  return resolve(v);
};
const repo = value("--repo");
const host = value("--host");
const output = value("--output");
const before = treeHash(repo);
const results = join(mkdtempSync(join(tmpdir(), "appworks-promotion-")), "results.json");
const env = { ...process.env, MEMOS_REPO: repo, APPWORKS_HOST_DIR: host, APPWORKS_RECORD_PROMOTED_HOST: "1", APPWORKS_VERIFICATION_OUT: results };
delete env.MEMOS_BIN;
delete env.APPWORKS_FULFILLMENT_DECLARATION;
console.log(`behavioral suite against the promoted host ${host}`);
const tests = spawnSync(process.execPath, ["--no-warnings", "--import", join(here, "runtime", "register.mjs"), "--test", "--test-concurrency=1", "--test-reporter=spec", join(here, "test", "behavior.test.mjs")], { cwd: here, env, stdio: "inherit" });
let recorded = null;
try {
  recorded = JSON.parse(readFileSync(results, "utf8"));
} catch {
  console.log("no results were recorded (the promoted host is not a verified copy, or the suite did not run)");
}
let mutations = null;
if (args.includes("--mutations")) {
  console.log("mutation check against copies of the promoted host");
  const run = spawnSync(process.execPath, [join(here, "scripts", "mutations.mjs")], { cwd: here, env: { ...env, APPWORKS_VERIFICATION_OUT: "", APPWORKS_RECORD_PROMOTED_HOST: "", APPWORKS_MUTATION_SOURCE: dirname(host) }, encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  const all = /all (\d+) mutants were caught/.exec(run.stdout);
  const some = /(\d+) of (\d+) mutants survived/.exec(run.stdout);
  mutations = all ? { caught: Number(all[1]), total: Number(all[1]) } : some ? { caught: Number(some[2]) - Number(some[1]), total: Number(some[2]) } : { caught: 0, total: 0 };
}
const worktreeUnchanged = treeHash(repo) === before;
console.log(`the worktree is ${worktreeUnchanged ? "unchanged" : "CHANGED"}`);
writeFileSync(output, `${JSON.stringify({ format: "appworks.promotion-verification-run/1", results: recorded, testsExit: tests.status, mutations, worktreeUnchanged }, null, 2)}\n`);
const passed = recorded && Object.values(recorded.behaviors).every((b) => b.status === "passed");
process.exit(tests.status === 0 && passed && worktreeUnchanged && (!mutations || (mutations.total > 0 && mutations.caught === mutations.total)) ? 0 : 1);
