// A TEST DOUBLE of an extraction runner, for the workspace's orchestration tests only. It honours the runner contract
// (`--repo <checkout> --output <file>`) and produces a real appport.capability-extraction/2 artifact with the
// extraction library, but its behavior results are stipulated, not observed: every result says it ran against a STUB
// application. Real behavioral verification is the Memos extraction's suite (test/memos-e2e.test.ts).
//
// `mode.json` in the extraction directory selects: pass | fail (every behavior failed) | crash (exit without an
// artifact) | hang (never exits) | hang-once | write-checkout (modifies the checkout, which the workspace must catch).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assessRepository } from "@appport/assessment";
import { createExtraction, observeCheckout, readPlan } from "@appport/extraction";

export async function run(scriptUrl) {
  const dir = join(dirname(fileURLToPath(scriptUrl)), "..");
  const args = process.argv.slice(2);
  const repo = args[args.indexOf("--repo") + 1];
  const output = args[args.indexOf("--output") + 1];
  const { mode: configured, marker } = JSON.parse(readFileSync(join(dir, "mode.json"), "utf8"));
  // hang-once: hangs the first time (leaving `marker`), passes afterwards; the mode file, and so the approval's subject,
  // stays the same.
  let mode = configured;
  if (configured === "hang-once") {
    if (existsSync(marker)) mode = "pass";
    else {
      writeFileSync(marker, String(process.pid));
      mode = "hang";
    }
  }
  console.log(`stub runner: mode ${mode}; env keys ${Object.keys(process.env).sort().join(",")}`);
  if (mode === "crash") {
    console.error("stub runner: crashing on purpose");
    process.exit(3);
  }
  if (mode === "hang") {
    await new Promise((resolve) => setTimeout(resolve, 600_000));
    return;
  }
  if (mode === "write-checkout") appendFileSync(join(repo, "go.mod"), "\n// touched\n");
  const assessment = assessRepository(repo);
  const plan = readPlan(join(dir, "extraction-plan.json"), repo);
  const checkout = observeCheckout(assessment, repo);
  const draft = createExtraction({ assessment, candidate: plan.plan.candidate, checkout, plan });
  const status = mode === "fail" ? "failed" : "passed";
  const results = {
    format: "appport.capability-verification-results/2",
    subject: draft.verification.records[0].subject,
    run: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), runner: "stub-runner (test double)" },
    behaviors: Object.fromEntries(draft.verification.required.map((b) => [b, { status, against: "stub-application", procedure: { kind: "integration-test", reference: "test/fixtures/stub-runner.mjs" }, results: [`stipulated ${status}: ${b}`] }]))
  };
  const extraction = createExtraction({ assessment, candidate: plan.plan.candidate, checkout, plan, verification: results });
  writeFileSync(output, JSON.stringify(extraction, null, 2));
  console.log(`stub runner: wrote ${extraction.digest}`);
}
