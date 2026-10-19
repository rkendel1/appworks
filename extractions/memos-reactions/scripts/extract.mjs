#!/usr/bin/env node
// The end-to-end extraction of memos.reactions.list@1, reproducibly:
//
//   1. assess the Memos checkout                      appworks assess
//   2. run the behavioral verification suite          node --test test/behavior.test.mjs (real Memos, real bridge)
//   3. bind assessment, plan, adapter and results     appworks extract --plan --verification
//   4. verify the artifact against all of them        appworks verify-extraction
//
//   MEMOS_REPO=<checkout at c0eeec7> [MEMOS_BIN=<memos build>] node scripts/extract.mjs [--write | --check]
//
// --write replaces extraction.json; --check (CI) fails unless the regenerated artifact has the committed digest.
// Intermediate files go to a temporary directory; nothing is written to the checkout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "@appport/extraction";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.MEMOS_REPO ? resolve(process.env.MEMOS_REPO) : undefined;
if (!repo) {
  console.error("MEMOS_REPO is not set: it names the Memos checkout at the source revision");
  process.exit(2);
}
const mode = process.argv[2] ?? "--dry-run";
const work = mkdtempSync(join(tmpdir(), "appworks-extraction-"));
const step = (title, status) => {
  if (status !== 0) {
    console.error(`${title} failed (${status})`);
    process.exit(1);
  }
};
const files = { assessment: join(work, "assessment.json"), results: join(work, "verification.json"), extraction: join(work, "extraction.json") };

console.log("1. assess");
step("assessment", main(["assess", repo, "--output", files.assessment]));
console.log("2. verify behaviors against the real operation");
const tests = spawnSync(process.execPath, ["--no-warnings", "--import", join(here, "runtime", "register.mjs"), "--test", "--test-concurrency=1", "--test-reporter=spec", join(here, "test", "behavior.test.mjs")], {
  cwd: here,
  env: { ...process.env, MEMOS_REPO: repo, APPWORKS_VERIFICATION_OUT: files.results },
  stdio: "inherit"
});
// A failing test is a result, not an error of this script: it is recorded as a failed behavior.
console.log(`   tests exited ${tests.status}`);
console.log("3. extract");
const candidate = JSON.parse(readFileSync(join(here, "extraction-plan.json"), "utf8")).candidate;
step("extraction", main(["extract", files.assessment, "--candidate", candidate, "--repo", repo, "--plan", join(here, "extraction-plan.json"), "--verification", files.results, "--output", files.extraction]));
console.log("4. verify the extraction");
step("verification", main(["verify-extraction", files.extraction, "--assessment", files.assessment, "--repo", repo, "--plan-dir", here]));

const produced = JSON.parse(readFileSync(files.extraction, "utf8"));
if (mode === "--write") {
  copyFileSync(files.extraction, join(here, "extraction.json"));
  console.log(`wrote extraction.json ${produced.digest}`);
} else if (mode === "--check") {
  const committed = JSON.parse(readFileSync(join(here, "extraction.json"), "utf8"));
  if (committed.digest !== produced.digest) {
    console.error(`the committed extraction.json (${committed.digest}) is not what this run produces (${produced.digest}); see ${files.extraction}`);
    process.exit(1);
  }
  console.log(`extraction.json reproduces: ${produced.digest}`);
}
process.exit(tests.status === 0 ? 0 : 1);
