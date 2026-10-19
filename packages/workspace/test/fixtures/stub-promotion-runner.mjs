// A TEST DOUBLE of a promotion verification runner (promotion/verify.mjs), for the workspace's orchestration tests only.
// It honours the runner contract (`--repo <worktree> --host <dir> --output <file> [--mutations]`) and computes the
// verification subject from the PROMOTED copy's own bytes with the extraction library, so a modified copy yields
// another subject. Its behavior results are stipulated (against a stub application), never observed. Real promotion
// verification is the Memos extraction's own suite (test/memos-e2e.test.ts).
//
// `promotion/mode.json` selects: pass | fail | write-worktree | no-results | survive (a mutant survives).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gitIdentity } from "@appport/assessment";
import { adapterIdentity, declarationDigest, readPlan, runtimeDigest, REQUIRED_BEHAVIORS } from "@appport/extraction";
import { capabilityDigest } from "@appport/protocol";

export async function run(scriptUrl) {
  const dir = join(dirname(fileURLToPath(scriptUrl)), "..");
  const args = process.argv.slice(2);
  const at = (flag) => args[args.indexOf(flag) + 1];
  const repo = at("--repo");
  const host = at("--host");
  const output = at("--output");
  const { mode } = JSON.parse(readFileSync(join(dir, "promotion", "mode.json"), "utf8"));
  console.log(`stub promotion runner: mode ${mode}`);
  const read = readPlan(join(dir, "extraction-plan.json"), repo);
  // The adapter files as promoted: each read from the host directory, where the promotion plan put it.
  const promoted = Object.fromEntries(read.plan.adapter.files.map((f) => [f, readFileSync(join(host, f))
    .toString("utf8")]));
  const { adapter } = adapterIdentity(read.plan.adapter, promoted, read.boundaryFiles);
  const declaration = JSON.parse(promoted[read.plan.fulfillment.declaration]);
  const runtime = read.plan.runtime;
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const contract = JSON.parse(readFileSync(join(host, "contract.json"), "utf8"));
  const subject = {
    sourceRevision: gitIdentity(repo).revision ?? "",
    capabilityDigest: capabilityDigest(contract, read.plan.identity.name, 1),
    adapterDigest: adapter.digest,
    declarationDigest: declarationDigest({ provider: read.plan.fulfillment.provider, extensions: declaration.extensions, attributes: declaration.attributes }),
    runtimeDigest: runtimeDigest({ packages: sort(runtime.packages), application: sort(runtime.application), node: runtime.node })
  };
  if (mode === "write-worktree") writeFileSync(join(repo, "UNAPPROVED.txt"), "written by the runner\n");
  const status = mode === "fail" ? "failed" : "passed";
  const results = mode === "no-results" ? null : { format: "appport.capability-verification-results/2", subject, run: { startedAt: "t0", finishedAt: "t1", runner: "stub promotion runner (test double)" }, behaviors: Object.fromEntries(REQUIRED_BEHAVIORS.map((b) => [b, { status, against: "stub-application", procedure: { kind: "integration-test", reference: "test/fixtures/stub-promotion-runner.mjs" }, results: [`stipulated ${status}: ${b}`] }])) };
  const mutations = args.includes("--mutations") ? { caught: mode === "survive" ? 5 : 6, total: 6 } : null;
  writeFileSync(output, JSON.stringify({ format: "appworks.promotion-verification-run/1", results, testsExit: status === "passed" ? 0 : 1, mutations, worktreeUnchanged: mode !== "write-worktree" }, null, 2));
}
