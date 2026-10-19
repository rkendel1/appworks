import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessRepository, type ApplicationAssessment } from "@appport/assessment";
import { syntheticApp, tempDir, writeTree } from "../../assessment/test/helpers.js";
import { createExtraction, proposedContract, readPlan, type ExtractionPlan, type VerificationResults } from "../src/index.js";

export const REVISION = "a".repeat(40);
export const CANDIDATE = "cand-notes.v1.NoteService.GetNote";
export { tempDir, treeHash } from "../../assessment/test/helpers.js";

/** The assessment tests' synthetic Go service, as a git checkout at REVISION, with a boundary file. */
export function repository(revision = REVISION): string {
  const root = writeTree(tempDir("extraction-repo-"), { ...syntheticApp(), "bridge/kit.mjs": "export const kit = 1;\n" });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git/HEAD"), `${revision}\n`);
  return root;
}

export const assess = (root: string): ApplicationAssessment => assessRepository(root, { now: () => new Date("2026-01-01T00:00:00Z"), id: () => "fixed" });

/** A plan directory: the proposal as contract (renamed note.get), one adapter file, the boundary file in the repo. */
export function planDirectory(assessment: ApplicationAssessment, edit: (p: ExtractionPlan, contract: Record<string, any>) => void = () => {}): string {
  const dir = tempDir("extraction-plan-");
  const candidate = assessment.candidates.find((c) => c.id === CANDIDATE)!;
  const contract = proposedContract(assessment, candidate) as unknown as Record<string, any>;
  contract.capabilities[0].authorization = ["notes.read"];
  contract.capabilities[0].definitions[0].authorization = ["notes.read"];
  const plan: ExtractionPlan = {
    format: "appport.capability-extraction-plan/1",
    candidate: CANDIDATE,
    identity: { name: "note.get", revision: 1 },
    contract: "contract.json",
    mapping: { changes: [], decisions: [{ subject: "permissions", decision: "notes.read", reason: "the service's own read permission" }], fields: [{ direction: "input", contract: "/name", source: "GetNoteRequest.name", rule: "identity" }] },
    adapter: { name: "notes-adapter", version: "1.0.0", files: ["adapter.mjs"], packages: { "@appport/sdk": "1.2.2" }, boundary: { name: "notes-bridge", description: "the service's bridge", files: ["bridge/kit.mjs"], invocation: { method: "GET", path: "/v1/{name}" } } },
    authorization: { requirements: ["notes.read"], restrictions: ["none known"] },
    environment: ["a notes server"],
    limitations: [{ code: "synthetic", description: "test fixture" }],
    questions: [{ id: "q-x", question: "?" }]
  };
  edit(plan, contract);
  writeFileSync(join(dir, "contract.json"), JSON.stringify(contract, null, 2));
  writeFileSync(join(dir, "extraction-plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(join(dir, "adapter.mjs"), "export const adapter = 1;\n");
  return dir;
}

/** A complete extraction of the fixture, optionally with results for every behavior. */
export function extraction(options: { status?: "passed" | "failed" } = {}) {
  const root = repository();
  const assessment = assess(root);
  const dir = planDirectory(assessment);
  const plan = readPlan(join(dir, "extraction-plan.json"), root);
  const draft = createExtraction({ assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan, now: () => new Date(0), id: () => "x" });
  const results = (status: "passed" | "failed"): VerificationResults => ({
    format: "appport.capability-verification-results/1",
    subject: draft.verification.records[0]!.subject,
    run: { startedAt: "t0", finishedAt: "t1", runner: "test" },
    behaviors: Object.fromEntries(draft.verification.required.map((b) => [b, { status, procedure: { kind: "integration-test" as const, reference: "test.mjs" }, results: [`${status}: ${b}`] }]))
  });
  const verified = options.status ? createExtraction({ assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan, verification: results(options.status), now: () => new Date(0), id: () => "x" }) : draft;
  return { root, assessment, dir, plan, extraction: verified, results };
}
