/** Creation, refusal, integrity and revision rules of appport.capability-extraction/1, on a synthetic repository. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessmentDigest, evidenceId, type ApplicationAssessment, type Evidence } from "@appport/assessment";
import { reseal as resealAssessment } from "../../assessment/test/helpers.js";
import {
  ExtractionRefused,
  REQUIRED_BEHAVIORS,
  compareExtractions,
  contractProblems,
  createExtraction,
  extractionDigest,
  readPlan,
  schemaProblems,
  verifyExtraction,
  verifyExtractionAt,
  type CapabilityExtraction,
  type ExtractionPlan
} from "../src/index.js";
import { CANDIDATE, REVISION, assess, extraction, planDirectory, repository, treeHash } from "./fixtures.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const refusal = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExtractionRefused) return error.reasons.map((r) => r.code);
    throw error;
  }
  throw new Error("not refused");
};
const codes = (x: unknown, options?: Parameters<typeof verifyExtraction>[1]) => verifyExtraction(x, options).findings.map((f) => f.code);
const reseal = (x: CapabilityExtraction): CapabilityExtraction => ({ ...x, digest: extractionDigest(x) });

describe("creating an extraction", () => {
  it("binds the candidate, contract, adapter and evidence, deterministically, and changes nothing in the repository", () => {
    const root = repository();
    const before = treeHash(root);
    const a = assess(root);
    const dir = planDirectory(a);
    const make = (id: string) => createExtraction({ assessment: a, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(dir, "extraction-plan.json"), root), id: () => id });
    const one = make("one");
    const two = make("two");
    expect(two.digest).toBe(one.digest);
    expect(two.extraction.id).not.toBe(one.extraction.id);
    expect(treeHash(root)).toBe(before);
    expect(one).toMatchObject({ stage: "implemented", identity: { name: "note.get", revision: 1 }, source: { revision: REVISION, operation: { fullMethod: "/notes.v1.NoteService/GetNote", http: "GET /v1/{name=notes/*}" } } });
    expect(one.assessment).toMatchObject({ digest: a.digest, candidate: { id: CANDIDATE } });
    expect(one.adapter!.files.map((f) => f.path)).toEqual(["adapter.mjs"]);
    expect(one.adapter!.boundary.files.map((f) => f.path)).toEqual(["bridge/kit.mjs"]);
    expect(one.verification.records.map((r) => r.status)).toEqual(REQUIRED_BEHAVIORS.map(() => "not-run"));
    expect(one.findings.map((f) => f.code)).toEqual(["VERIFICATION_INCOMPLETE"]);
    expect(one.scope).toEqual({ grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false });
    // Every evidence reference resolves to a verbatim copy of the assessment's record.
    const original = new Map(a.evidence.map((e) => [e.id, e]));
    for (const e of one.evidence) expect(e).toEqual(original.get(e.id));
    expect(verifyExtractionAt(one, { assessment: a, repository: root, planDirectory: dir })).toEqual({ ok: true, findings: [] });
  });

  it("proposes an extraction without a plan: the assessment's proposal, no adapter, nothing verified", () => {
    const root = repository();
    const a = assess(root);
    const x = createExtraction({ assessment: a, candidate: CANDIDATE, checkout: { revision: REVISION } });
    expect(x).toMatchObject({ stage: "proposed", adapter: null, identity: { name: "note.get" } });
    expect(x.findings.map((f) => f.code)).toEqual(["ADAPTER_MISSING", "VERIFICATION_INCOMPLETE"]);
    expect(verifyExtraction(x, { assessment: a }).ok).toBe(true);
  });

  it("records results only for the subject they were produced for", () => {
    const { extraction: x, assessment, root, dir, results } = extraction({ status: "passed" });
    expect(x.verification.summary).toEqual({ "not-run": 0, passed: REQUIRED_BEHAVIORS.length, failed: 0, inconclusive: 0 });
    expect(verifyExtractionAt(x, { assessment, repository: root, planDirectory: dir }).ok).toBe(true);
    const other = results("passed");
    other.subject = { ...other.subject, adapterDigest: `sha256:${"0".repeat(64)}` };
    expect(refusal(() => createExtraction({ assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(dir, "extraction-plan.json"), root), verification: other }))).toEqual(["VERIFICATION_SUBJECT_MISMATCH"]);
  });
});

describe("refusals", () => {
  const root = repository();
  const a = assess(root);
  const make = (assessment: unknown, extra: Partial<Parameters<typeof createExtraction>[0]> = {}) => () => createExtraction({ assessment: assessment as ApplicationAssessment, candidate: CANDIDATE, checkout: { revision: REVISION }, ...extra });

  it("refuses a modified assessment, broken evidence references and an assessment without a revision", () => {
    const edited = clone(a);
    edited.candidates[0]!.name = "renamed";
    expect(refusal(make(edited))).toEqual(["ASSESSMENT_INVALID"]);
    const dangling = clone(a);
    dangling.candidates.find((c) => c.id === CANDIDATE)!.evidence.push("ev-0000000000000000");
    expect(refusal(make(resealAssessment(dangling)))).toEqual(["ASSESSMENT_INVALID"]);
    const unpinned = assess(writeTreeWithoutGit());
    expect(refusal(() => createExtraction({ assessment: unpinned, candidate: CANDIDATE, checkout: {} }))).toEqual(["ASSESSMENT_REVISION_MISSING"]);
  });

  it("refuses a checkout at another revision, or one the evidence does not match", () => {
    expect(refusal(make(a, { checkout: { revision: "b".repeat(40) } }))).toEqual(["REPOSITORY_REVISION_MISMATCH"]);
    expect(refusal(make(a, { checkout: { revision: REVISION, locationsVerified: { ok: false, codes: ["LOCATION_SUBJECT"] } } }))).toEqual(["ASSESSMENT_LOCATIONS_INVALID"]);
  });

  it("refuses candidates that are missing, not ready, or not read-only, with reason codes", () => {
    expect(refusal(make(a, { candidate: "cand-other.Service.Method" }))).toEqual(["CANDIDATE_NOT_FOUND"]);
    expect(refusal(make(a, { candidate: "cand-notes.v1.NoteService.DeleteNote" }))).toEqual(["CANDIDATE_NOT_READ_ONLY"]);
    const weak = clone(a);
    const c = weak.candidates.find((x) => x.id === CANDIDATE)!;
    c.readiness.class = "investigate";
    weak.recommendation = null;
    c.readiness.criteria.find((x) => x.criterion === "tests")!.satisfied = false;
    c.readiness.criteria.find((x) => x.criterion === "tests")!.reason = "no-related-tests";
    expect(refusal(make(resealAssessment(weak)))).toEqual(["CANDIDATE_NOT_READY", "CANDIDATE_NO_TESTS"]);
  });

  it("refuses an invalid contract, an unexplained or stale mapping, and a plan for another candidate", () => {
    const withPlan = (edit: Parameters<typeof planDirectory>[1]) => {
      const dir = planDirectory(a, edit);
      return refusal(make(a, { plan: readPlan(join(dir, "extraction-plan.json"), root) }));
    };
    expect(withPlan((_, k) => (k.capabilities[0].inputSchema.properties.name.pattern = "^notes/[a-z]+$"))).toEqual(["MAPPING_UNEXPLAINED"]);
    expect(withPlan((p) => p.mapping.changes.push({ direction: "output", kind: "output.type-changed", target: "body", reason: "x" }))).toEqual(["MAPPING_STALE"]);
    expect(withPlan((_, k) => (k.extensions = []))).toContain("CONTRACT_INVALID");
    expect(withPlan((_, k) => (k.capabilities[0].effect = k.capabilities[0].definitions[0].effect = "consequential"))).toContain("CONTRACT_INVALID");
    expect(withPlan((p) => (p.candidate = "cand-notes.v1.NoteService.DeleteNote"))).toEqual(["PLAN_CANDIDATE"]);
    expect(withPlan((p) => p.adapter.files.push("missing.mjs"))).toEqual(["ADAPTER_FILE_MISSING"]);
    expect(withPlan((p) => p.adapter.boundary.files.push("../outside.mjs"))).toEqual(["BOUNDARY_FILE_MISSING"]);
  });
});

describe("unsupported and malformed contract schemas", () => {
  it("refuses keywords and types outside AppPort's subset, invalid patterns and unresolvable references", () => {
    expect(schemaProblems({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toEqual([]);
    expect(schemaProblems({ type: "object", if: { type: "string" } })).toEqual(["/if: unsupported keyword"]);
    expect(schemaProblems({ type: "strng" })).toEqual(['/type: unsupported type "strng"']);
    expect(schemaProblems({ type: "string", pattern: "(" })).toEqual(["/pattern: invalid pattern"]);
    expect(schemaProblems({ $ref: "#/$defs/missing" })).toEqual(['/$ref: unresolvable reference "#/$defs/missing"']);
    expect(schemaProblems({ properties: [] })).toEqual(["/properties: an object of schemas"]);
    expect(contractProblems(null, { name: "a.b", version: 1 })).toEqual(["the contract is not an AppPort manifest"]);
  });
});

describe("verifying an extraction", () => {
  const { extraction: x, assessment, root, dir } = extraction({ status: "passed" });

  it("rejects a modified artifact through its digest, and a forged evidence record", () => {
    expect(codes(x)).toEqual([]);
    expect(codes({ ...x, identity: { ...x.identity, name: "note.list" } })).toContain("DIGEST_MISMATCH");
    const forged = clone(x);
    forged.evidence[0]!.observation = "something else";
    expect(codes(reseal(forged))).toContain("EVIDENCE_ID");
    const dangling = clone(x);
    dangling.source.implementation.evidence.push("ev-ffffffffffffffff");
    expect(codes(reseal(dangling))).toContain("EVIDENCE_REFERENCE");
  });

  it("rejects an extraction checked against another assessment, a changed candidate, or foreign evidence", () => {
    const other = assess(repository());
    const changed = clone(other);
    changed.candidates.find((c) => c.id === CANDIDATE)!.description = "changed";
    expect(codes(x, { assessment: { ...assessment, digest: `sha256:${"1".repeat(64)}` } })).toEqual(["ASSESSMENT_MISMATCH"]);
    const resealed = resealAssessment(changed);
    const pointed = reseal({ ...clone(x), assessment: { ...x.assessment, digest: resealed.digest } });
    expect(codes(pointed, { assessment: resealed })).toEqual(["CANDIDATE_MISMATCH"]);
    const foreign = clone(x);
    const extra: Omit<Evidence, "id"> = { class: "observed", kind: "go.function", location: { path: "x.go", startLine: 1, endLine: 1 }, observation: "invented", method: "go-static" };
    foreign.evidence.push({ id: evidenceId(extra), ...extra });
    expect(codes(reseal(foreign), { assessment })).toEqual(["EVIDENCE_FOREIGN"]);
  });

  it("rejects a repository at another revision, a changed boundary and a mismatched adapter", () => {
    expect(verifyExtractionAt(x, { repository: root, planDirectory: dir }).ok).toBe(true);
    expect(codes(x, { repositoryRevision: "b".repeat(40) })).toEqual(["SOURCE_REVISION"]);
    expect(codes(x, { boundaryFiles: { "bridge/kit.mjs": "changed" } })).toEqual(["BOUNDARY_MISMATCH"]);
    expect(codes(x, { adapterFiles: { "adapter.mjs": "export const adapter = 2;\n" } })).toEqual(["ADAPTER_MISMATCH"]);
    expect(codes(x, { adapterFiles: {} })).toEqual(["ADAPTER_MISMATCH"]);
    const renamed = clone(x);
    renamed.adapter!.version = "2.0.0";
    expect(codes(reseal(renamed))).toEqual(["ADAPTER_DIGEST"]);
    writeFileSync(join(root, "bridge/kit.mjs"), "changed");
    expect(verifyExtractionAt(x, { repository: root, planDirectory: dir }).findings.map((f) => f.code)).toEqual(["BOUNDARY_MISMATCH"]);
  });

  it("rejects verification claims without evidence, for another subject, or before an adapter exists", () => {
    const empty = clone(x);
    empty.verification.records[0]!.results = [];
    expect(codes(reseal(empty))).toEqual(["VERIFICATION_EVIDENCE"]);
    const noProcedure = clone(x);
    delete noProcedure.verification.records[0]!.procedure;
    expect(codes(reseal(noProcedure))).toEqual(["VERIFICATION_EVIDENCE"]);
    const stale = clone(x);
    stale.verification.records[0]!.subject.sourceRevision = "c".repeat(40);
    expect(codes(reseal(stale))).toEqual(["VERIFICATION_STALE"]);
    const premature = clone(x);
    premature.stage = "proposed";
    premature.adapter = null;
    expect(codes(reseal(premature))).toEqual(expect.arrayContaining(["VERIFICATION_STAGE", "VERIFICATION_STALE"]));
    const miscounted = clone(x);
    miscounted.verification.summary.passed += 1;
    expect(codes(reseal(miscounted))).toEqual(["VERIFICATION_SUMMARY"]);
    const missing = clone(x);
    missing.verification.records.pop();
    missing.verification.summary.passed -= 1;
    expect(codes(reseal(missing))).toEqual(["VERIFICATION_MISSING"]);
    const invented = clone(x);
    (invented.verification.records[0] as { status: string }).status = "verified";
    expect(codes(reseal(invented))).toEqual(expect.arrayContaining(["VERIFICATION_STATUS"]));
    const blanket = clone(x) as unknown as Record<string, any>;
    blanket.verification.verified = true;
    expect(codes(reseal(blanket as unknown as CapabilityExtraction))).toContain("FORBIDDEN_CLAIM");
  });

  it("rejects authority grants and widened scope", () => {
    const granted = clone(x) as unknown as Record<string, any>;
    granted.authorization.grants = [{ capability: "note.get", principal: "*" }];
    expect(codes(reseal(granted as unknown as CapabilityExtraction))).toContain("FORBIDDEN_CLAIM");
    const top = { ...clone(x), grant: {} } as unknown as CapabilityExtraction;
    expect(codes(reseal(top))).toContain("EXTRACTION_MEMBER");
    for (const key of ["grantsAuthority", "executable", "establishesEquivalence", "deploys", "modifiesTarget"] as const) {
      const widened = clone(x);
      (widened.scope as Record<string, boolean>)[key] = true;
      expect(codes(reseal(widened))).toEqual(["SCOPE_CLAIM"]);
    }
  });

  it("rejects a contract whose digests or mapping no longer match it", () => {
    const changed = clone(x);
    changed.contract.canonical.capabilities[0]!.description = "edited";
    expect(codes(reseal(changed))).toEqual(expect.arrayContaining(["CONTRACT_DIGEST"]));
    const unexplained = clone(x);
    (unexplained.contract.canonical.capabilities[0]!.definitions[0]!.inputSchema.properties as Record<string, unknown>).name = { type: "string", maxLength: 3 };
    expect(codes(reseal(unexplained))).toEqual(expect.arrayContaining(["MAPPING_UNEXPLAINED"]));
  });
});

describe("revisions", () => {
  const base = extraction({ status: "passed" });
  type Edit = (plan: ExtractionPlan, contract: Record<string, any>) => void;
  const next = (edit: Edit, identity?: { revision: number; previous?: string }) => {
    const dir = planDirectory(base.assessment, (p, k) => {
      edit(p, k);
      if (identity) p.identity = { ...p.identity, ...identity };
    });
    return () => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(dir, "extraction-plan.json"), base.root), previous: base.extraction });
  };

  it("refuses a changed contract or adapter without a new revision naming the previous one", () => {
    const describe_: Edit = (_, k) => {
      k.capabilities[0].description = k.capabilities[0].definitions[0].description = "changed";
    };
    expect(refusal(next(describe_))).toEqual(["REVISION_NOT_INCREMENTED"]);
    expect(refusal(next(describe_, { revision: 2 }))).toEqual(["PREVIOUS_MISMATCH"]);
    expect(next(describe_, { revision: 2, previous: base.extraction.digest })().identity).toEqual({ name: "note.get", revision: 2, previous: base.extraction.digest });
    expect(refusal(next((p) => (p.adapter.version = "1.1.0")))).toEqual(["REVISION_NOT_INCREMENTED"]);
  });

  it("refuses a breaking contract change in the same capability version, and reports changes as versioned differences", () => {
    const breaking = (_: unknown, k: Record<string, any>) => {
      k.capabilities[0].definitions[0].inputSchema.required = ["name", "body"];
      k.capabilities[0].definitions[0].inputSchema.properties.body = { type: "string" };
      k.capabilities[0].inputSchema = k.capabilities[0].definitions[0].inputSchema;
    };
    const dir = planDirectory(base.assessment, breaking);
    const plan = readPlan(join(dir, "extraction-plan.json"), base.root);
    expect(refusal(() => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan }))).toEqual(["MAPPING_UNEXPLAINED"]);
    const contract = plan.contract as CapabilityExtraction["contract"]["canonical"];
    const findings = compareExtractions(base.extraction, {
      identity: { name: "note.get", revision: 2, previous: base.extraction.digest },
      contract: { canonical: contract, capabilityDigest: "x", contractDigest: "changed", capability: { contract: contract.application.id, name: "note.get", version: 1 } },
      adapter: base.extraction.adapter,
      source: { revision: REVISION }
    });
    expect(findings.filter((f) => f.blocking).map((f) => f.code)).toEqual(["CONTRACT_BREAKING_SAME_VERSION"]);
    expect(findings.some((f) => f.code === "CONTRACT_BREAKING_CHANGE")).toBe(true);
  });

  it("never carries results forward: a new source revision makes earlier results stale", () => {
    const moved = clone(base.extraction);
    moved.source.revision = "d".repeat(40);
    expect(codes(reseal(moved))).toContain("VERIFICATION_STALE");
  });
});

function writeTreeWithoutGit(): string {
  const root = repository();
  writeFileSync(join(root, ".git/HEAD"), "not a revision\n");
  return root;
}

// Keep the digest helper honest: the assessment's own digest rule is what extraction pins.
it("pins the assessment by its own digest rule", () => {
  const a = assess(repository());
  expect(assessmentDigest(a)).toBe(a.digest);
});
