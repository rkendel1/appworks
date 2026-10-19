/**
 * Format /2: the fulfillment declaration and runtime are bound into the artifact and into every result's subject;
 * format /1 artifacts are still read with the /1 rules, and never reinterpreted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FULFILLMENT_EXTENSION } from "@appport/protocol";
import {
  ExtractionRefused,
  EXTRACTION_FORMAT,
  EXTRACTION_FORMAT_V1,
  REQUIRED_BEHAVIORS,
  REQUIRED_BEHAVIORS_V1,
  compareExtractions,
  createExtraction,
  declarationDigest,
  extractionDigest,
  readPlan,
  runtimeDigest,
  verifyExtraction,
  type CapabilityExtraction
} from "../src/index.js";
import { CANDIDATE, REVISION, declarationFor, extraction, planDirectory } from "./fixtures.js";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const reseal = (x: CapabilityExtraction): CapabilityExtraction => ({ ...x, digest: extractionDigest(x) });
const codes = (x: unknown) => verifyExtraction(x).findings.map((f) => f.code);
const refusal = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExtractionRefused) return error.reasons.map((r) => r.code);
    throw error;
  }
  throw new Error("not refused");
};

describe("the fulfillment declaration", () => {
  const base = extraction({ status: "passed" });
  const x = base.extraction;
  const withDeclaration = (declaration: (contract: unknown) => unknown, edit: Parameters<typeof planDirectory>[1] = () => {}) => {
    const dir = planDirectory(base.assessment, edit, declaration);
    return () => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(dir, "extraction-plan.json"), base.root) });
  };
  const claimOf = (contract: unknown) => (declarationFor(contract).attributes[FULFILLMENT_EXTENSION] as { capabilities: Record<string, Array<Record<string, unknown>>> }).capabilities["note.get@1"]![0]!;
  const declaring = (claims: (contract: unknown) => unknown[]) => (contract: unknown) => ({ extensions: [FULFILLMENT_EXTENSION], attributes: { [FULFILLMENT_EXTENSION]: { capabilities: { "note.get@1": claims(contract) } } } });

  it("is bound into the artifact and into every result's subject", () => {
    expect(x.format).toBe(EXTRACTION_FORMAT);
    expect(x.fulfillment).toMatchObject({ provider: { application: "com.example.notes", capability: "note.get", version: 1 }, extensions: [FULFILLMENT_EXTENSION] });
    expect(x.fulfillment!.digest).toBe(declarationDigest(x.fulfillment!));
    for (const r of x.verification.records) expect(r.subject).toEqual({ sourceRevision: REVISION, capabilityDigest: x.contract.capabilityDigest, adapterDigest: x.adapter!.digest, declarationDigest: x.fulfillment!.digest, runtimeDigest: runtimeDigest(x.runtime!) });
    expect(x.verification.required).toEqual(REQUIRED_BEHAVIORS);
    expect(REQUIRED_BEHAVIORS).toEqual(expect.arrayContaining(["integration.declaration-fails-closed", "authorization.claim-not-authority", "contract.no-sensitive-data"]));
    expect(verifyExtraction(x)).toEqual({ ok: true, findings: [] });
  });

  it("refuses missing, malformed, mismatched and stale declarations with reason codes", () => {
    expect(refusal(withDeclaration((c) => ({ ...declarationFor(c), extensions: [] })))).toEqual(["FULFILLMENT_MALFORMED"]);
    expect(refusal(withDeclaration(declaring(() => [])))).toEqual(["FULFILLMENT_MISSING"]);
    expect(refusal(withDeclaration(declaring((c) => [{ ...claimOf(c), contract: "org.example.other" }])))).toEqual(["FULFILLMENT_MISMATCH"]);
    expect(refusal(withDeclaration(declaring((c) => [{ ...claimOf(c), digest: `sha256:${"0".repeat(64)}` }])))).toEqual(["FULFILLMENT_STALE"]);
    expect(refusal(withDeclaration(declaring((c) => [claimOf(c), claimOf(c)])))).toEqual(["FULFILLMENT_MISMATCH"]);
    expect(refusal(withDeclaration((c) => ({ ...declarationFor(c), attributes: { ...declarationFor(c).attributes, "example.extra/1": {} } })))).toEqual(["FULFILLMENT_MISMATCH"]);
    // A declaration made for the contract as it was before an edit is stale for the edited one.
    let unedited: unknown;
    const edit: Parameters<typeof planDirectory>[1] = (_, k) => {
      unedited = clone(k);
      k.capabilities[0].description = k.capabilities[0].definitions[0].description = "edited";
    };
    expect(refusal(withDeclaration(() => declarationFor(unedited), edit))).toEqual(["FULFILLMENT_STALE"]);
    expect(refusal(withDeclaration(declarationFor, (p) => (p.adapter.files = ["adapter.mjs"])))).toEqual(["FULFILLMENT_NOT_ADAPTER_FILE"]);
    expect(refusal(withDeclaration(declarationFor, (p) => (p.fulfillment!.declaration = "missing.json")))).toEqual(expect.arrayContaining(["FULFILLMENT_MISSING"]));
    const dir = planDirectory(base.assessment);
    writeFileSync(join(dir, "fulfillment.json"), "{ not json");
    expect(refusal(() => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(dir, "extraction-plan.json"), base.root) }))).toEqual(["FULFILLMENT_MALFORMED"]);
  });

  it("rejects an artifact whose declaration was edited, whose declaration digest is wrong, or that declares before it has an adapter", () => {
    const stale = clone(x);
    ((stale.fulfillment!.attributes[FULFILLMENT_EXTENSION] as { capabilities: Record<string, Array<{ digest: string }>> }).capabilities["note.get@1"]![0]!).digest = `sha256:${"1".repeat(64)}`;
    expect(codes(reseal(stale))).toEqual(["FULFILLMENT_STALE", "FULFILLMENT_DIGEST"]);
    const redigested = clone(stale);
    redigested.fulfillment!.digest = declarationDigest(redigested.fulfillment!);
    expect(codes(reseal(redigested))).toEqual(expect.arrayContaining(["FULFILLMENT_STALE", "VERIFICATION_STALE"]));
    const premature = clone(x);
    premature.stage = "proposed";
    premature.adapter = null;
    expect(codes(reseal(premature))).toEqual(expect.arrayContaining(["FULFILLMENT_STAGE"]));
  });

  it("never carries results across a changed declaration or runtime", () => {
    const declared = clone(x);
    declared.fulfillment!.provider.application = "com.example.other";
    declared.fulfillment!.digest = declarationDigest(declared.fulfillment!);
    expect(codes(reseal(declared))).toEqual(REQUIRED_BEHAVIORS.map(() => "VERIFICATION_STALE"));
    const ran = clone(x);
    ran.runtime!.application.storage = "postgres";
    expect(codes(reseal(ran))).toEqual(REQUIRED_BEHAVIORS.map(() => "VERIFICATION_STALE"));
    const other = base.results("passed");
    other.subject = { ...other.subject, runtimeDigest: runtimeDigest({ ...x.runtime!, node: "18" }) };
    expect(refusal(() => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: base.plan, verification: other }))).toEqual(["VERIFICATION_SUBJECT_MISMATCH"]);
    const v1Results = { ...base.results("passed"), format: "appport.capability-verification-results/1" } as never;
    expect(refusal(() => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: base.plan, verification: v1Results }))).toEqual(["VERIFICATION_FORMAT"]);
  });

  it("requires each result to say what it ran against", () => {
    const untargeted = clone(x);
    delete untargeted.verification.records[0]!.against;
    expect(codes(reseal(untargeted))).toEqual(["VERIFICATION_TARGET"]);
    const results = base.results("passed");
    delete (results.behaviors as Record<string, { against?: string }>)[REQUIRED_BEHAVIORS[0]!]!.against;
    expect(refusal(() => createExtraction({ assessment: base.assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: base.plan, verification: results }))).toEqual(["VERIFICATION_TARGET"]);
  });

  it("needs a new revision when only the declaration or the runtime changes", () => {
    const next = { identity: x.identity, contract: x.contract, adapter: x.adapter, source: x.source, fulfillment: x.fulfillment, runtime: x.runtime };
    expect(compareExtractions(x, next)).toEqual([]);
    const declared = { ...next, fulfillment: { ...x.fulfillment!, digest: `sha256:${"2".repeat(64)}` } };
    expect(compareExtractions(x, declared).map((f) => f.code)).toEqual(["DECLARATION_CHANGED", "REVISION_NOT_INCREMENTED"]);
    const ran = { ...next, runtime: { ...x.runtime!, node: ">=24" } };
    expect(compareExtractions(x, ran).map((f) => f.code)).toEqual(["RUNTIME_CHANGED", "REVISION_NOT_INCREMENTED"]);
  });
});

describe("format compatibility", () => {
  const { extraction: x, assessment, root, dir } = extraction({ status: "passed" });

  it("reads /1 with the /1 rules and never accepts /2 members in it", () => {
    const r1 = JSON.parse(readFileSync(new URL("../../../extractions/memos-reactions/revisions/1/extraction.json", import.meta.url), "utf8")) as CapabilityExtraction;
    expect(r1.format).toBe(EXTRACTION_FORMAT_V1);
    expect(verifyExtraction(r1)).toEqual({ ok: true, findings: [] });
    expect(r1.verification.required).toEqual(REQUIRED_BEHAVIORS_V1);
    expect(codes(reseal({ ...clone(r1), fulfillment: null } as CapabilityExtraction))).toEqual(["EXTRACTION_MEMBER"]);
  });

  it("does not read a /2 artifact as /1, a /1 artifact as /2, or an unknown version", () => {
    const { fulfillment: _f, runtime: _r, ...asV1 } = clone(x);
    expect(codes(reseal({ ...asV1, format: EXTRACTION_FORMAT } as CapabilityExtraction))).toEqual(["EXTRACTION_MEMBER", "EXTRACTION_MEMBER"]);
    expect(codes(reseal({ ...clone(x), format: EXTRACTION_FORMAT_V1 }))).toEqual(["EXTRACTION_MEMBER", "EXTRACTION_MEMBER"]);
    expect(codes({ ...clone(x), format: "appport.capability-extraction/3" })).toEqual(["EXTRACTION_FORMAT"]);
  });

  it("still accepts a /1 plan, which declares nothing", () => {
    const planDir = planDirectory(assessment, (p) => {
      p.format = "appport.capability-extraction-plan/1";
      delete p.fulfillment;
      delete p.runtime;
    });
    const made = createExtraction({ assessment, candidate: CANDIDATE, checkout: { revision: REVISION }, plan: readPlan(join(planDir, "extraction-plan.json"), root) });
    expect(made).toMatchObject({ format: EXTRACTION_FORMAT, fulfillment: null });
    expect(verifyExtraction(made).ok).toBe(true);
    expect(dir).toBeTruthy();
  });
});
