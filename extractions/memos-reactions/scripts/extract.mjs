#!/usr/bin/env node
// The end-to-end extraction of memos.reactions.list@1, reproducibly, in a fixed order:
//
//    1. validate the source revision and assess it           the checkout's HEAD is the plan's pinned revision; appworks assess
//    2. validate the extraction inputs and history           revision 1 verifies as recorded; the plan, contract and declaration
//    3. build Memos outside the checkout                     (by the suite, as the plan's runtime declares)
//    4. start Memos with synthetic data                      (by the suite, through the Memos bridge's own harness)
//    5. start the existing bridge with the extracted host    (by the suite)
//    6. verify the declaration and discovery                 (by the suite)
//    7. run the behavioral and authority tests               node --test test/behavior.test.mjs
//    8. write the verification record and digest             appworks extract --plan --verification --previous; verify-extraction
//    9. confirm the checkout is unchanged                    a tree hash before step 1 and after step 8
//   10. report passed, failed and not-run separately         exit 0 only if every required behavior passed
//
//   MEMOS_REPO=<checkout at the pinned revision> node scripts/extract.mjs [--write | --check] [--mutations]
//   node scripts/extract.mjs --repo <checkout> --output <file>          (the AppWorks workspace's runner contract)
//
// --repo names the checkout instead of MEMOS_REPO. --output also writes the produced artifact to <file> (outside the
// checkout), whether or not every behavior passed, before the exit status is decided.
// --write replaces revisions/<n>/extraction.json for the plan's revision; --check (CI) fails unless the regenerated
// artifact has the committed digest. --mutations also runs scripts/mutations.mjs. Nothing depends on a previously
// running server or on MEMOS_BIN (ignored here: the declared build is always made). Intermediate files go to a temporary
// directory; nothing is written to the checkout.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitIdentity } from "@appport/assessment";
import { main, readPlan, verifyExtractionAt } from "@appport/extraction";
import { PINNED_REVISION, treeHash } from "../test/support/verification.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${flag} needs a value`);
    process.exit(2);
  }
  return resolve(value);
};
const repoArg = valueOf("--repo");
const outputArg = valueOf("--output");
const repo = repoArg ?? (process.env.MEMOS_REPO ? resolve(process.env.MEMOS_REPO) : undefined);
if (!repo) {
  console.error("neither --repo nor MEMOS_REPO is set: it names the Memos checkout at the source revision");
  process.exit(2);
}
const mode = args.find((a) => a === "--write" || a === "--check") ?? "--dry-run";
const work = mkdtempSync(join(tmpdir(), "appworks-extraction-"));
const fail = (message) => {
  console.error(`FAILED: ${message}`);
  process.exit(1);
};
const step = (title, status) => {
  if (status !== 0) fail(`${title} (exit ${status})`);
};
const plan = JSON.parse(readFileSync(join(here, "extraction-plan.json"), "utf8"));
const revision = plan.identity.revision;
const files = { assessment: join(work, "assessment.json"), results: join(work, "verification.json"), extraction: join(work, "extraction.json") };
const committed = join(here, "revisions", String(revision), "extraction.json");
const previous = revision > 1 ? join(here, "revisions", String(revision - 1), "extraction.json") : undefined;

const before = treeHash(repo);
console.log("1. source revision and assessment");
const head = gitIdentity(repo).revision;
if (head !== PINNED_REVISION) fail(`the checkout is at ${head ?? "an unknown revision"}; the plan pins ${PINNED_REVISION}`);
step("assessment", main(["assess", repo, "--output", files.assessment]));
step("assessment verification", main(["verify", files.assessment, "--repo", repo]));

console.log("2. extraction inputs and history");
if (previous) {
  const prior = JSON.parse(readFileSync(previous, "utf8"));
  const checked = verifyExtractionAt(prior, {});
  if (!checked.ok) fail(`revision ${revision - 1} no longer verifies: ${checked.findings.map((f) => f.code).join(", ")}`);
  if (plan.identity.previous !== prior.digest) fail(`the plan names ${plan.identity.previous} as revision ${revision - 1}; it is ${prior.digest}`);
  console.log(`   revision ${revision - 1} (${prior.format}) verifies as recorded: ${prior.digest}`);
}
readPlan(join(here, "extraction-plan.json"), repo); // contained reads of the contract, adapter, declaration and boundary files

console.log("3-7. build Memos, start it with synthetic data, start the bridge with the host, verify declaration, discovery and behavior");
const env = { ...process.env, MEMOS_REPO: repo, APPWORKS_VERIFICATION_OUT: files.results };
delete env.MEMOS_BIN;
delete env.APPWORKS_HOST_DIR;
delete env.APPWORKS_FULFILLMENT_DECLARATION;
const tests = spawnSync(process.execPath, ["--no-warnings", "--import", join(here, "runtime", "register.mjs"), "--test", "--test-concurrency=1", "--test-reporter=spec", join(here, "test", "behavior.test.mjs")], { cwd: here, env, stdio: "inherit" });
// A failing test is a result, not an error of this script: it is recorded as a failed behavior and reported below.
console.log(`   tests exited ${tests.status}`);

console.log("8. verification record and digest");
step("extraction", main(["extract", files.assessment, "--candidate", plan.candidate, "--repo", repo, "--plan", join(here, "extraction-plan.json"), "--verification", files.results, ...(previous ? ["--previous", previous] : []), "--output", files.extraction]));
step("extraction verification", main(["verify-extraction", files.extraction, "--assessment", files.assessment, "--repo", repo, "--plan-dir", here]));
const produced = JSON.parse(readFileSync(files.extraction, "utf8"));
if (outputArg) {
  copyFileSync(files.extraction, outputArg);
  console.log(`   wrote ${outputArg}`);
}

console.log("9. checkout");
const unchanged = treeHash(repo) === before;
console.log(`   the checkout is ${unchanged ? "unchanged" : "CHANGED"} (tree hash over every file, .git included)`);

let mutations = 0;
if (args.includes("--mutations")) {
  console.log("   mutation check");
  mutations = spawnSync(process.execPath, [join(here, "scripts", "mutations.mjs")], { cwd: here, env: { ...env, APPWORKS_VERIFICATION_OUT: "" }, stdio: "inherit" }).status ?? 1;
}

console.log("10. result");
const s = produced.verification.summary;
const by = (status) => produced.verification.records.filter((r) => r.status === status).map((r) => `${r.behavior} (${r.against})`);
console.log(`   passed (${s.passed}): ${by("passed").join(", ") || "none"}`);
console.log(`   failed (${s.failed}): ${by("failed").join(", ") || "none"}`);
console.log(`   inconclusive (${s.inconclusive}): ${by("inconclusive").join(", ") || "none"}`);
console.log(`   not run or unsupported (${s["not-run"]}): ${by("not-run").join(", ") || "none"}`);
console.log(`   extraction ${produced.identity.name} revision ${produced.identity.revision}: ${produced.digest}`);

if (mode === "--write") {
  mkdirSync(dirname(committed), { recursive: true });
  copyFileSync(files.extraction, committed);
  console.log(`   wrote ${committed}`);
} else if (mode === "--check") {
  const recorded = JSON.parse(readFileSync(committed, "utf8"));
  if (recorded.digest !== produced.digest) fail(`the committed ${committed} (${recorded.digest}) is not what this run produces (${produced.digest}); see ${files.extraction}`);
  console.log(`   ${committed} reproduces: ${produced.digest}`);
}
const allPassed = s.passed === produced.verification.records.length;
if (!unchanged) fail("the checkout changed during the run");
if (mutations !== 0) fail("a mutant survived the behavioral suite");
if (tests.status !== 0 || !allPassed) fail(`not every required behavior passed (${s.passed} of ${produced.verification.records.length})`);
console.log("   every required behavior passed for exactly this source revision, contract, adapter, declaration and runtime");
