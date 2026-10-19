/**
 * The committed extractions of Memos MemoService.ListMemoReactions (extractions/memos-reactions/revisions/), checked
 * offline against the files they bind. Revision 1 is history: it is kept exactly as recorded, failed claim included.
 * Revision 2 is current. Their behavioral results come from runs against a real Memos (CI job memos, which also
 * regenerates the current revision and requires the same digest).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FULFILLMENT_EXTENSION, canonicalize, type JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { REQUIRED_BEHAVIORS, REQUIRED_BEHAVIORS_V1, compareExtractions, runtimeDigest, verifyExtractionAt, type CapabilityExtraction } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../extractions/memos-reactions/", import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(dir + name, "utf8"));
const schema = (v: number) => fromJSONSchema(JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/capability-extraction-${v}.schema.json`, import.meta.url)), "utf8")) as JSONSchema);
const r1 = read("revisions/1/extraction.json") as CapabilityExtraction;
const r2 = read("revisions/2/extraction.json") as CapabilityExtraction;
const plan = read("extraction-plan.json");

describe("revision 1 (history)", () => {
  it("is the recorded artifact, unchanged: /1, at c0eeec7, with the fulfillment claim failed", () => {
    expect(r1.digest).toBe("sha256:81011ddc62b9f3dddf1b8ac54b5d499be2c58bbb8aae0bd65968afd58f550e41");
    expect(verifyExtractionAt(r1, {})).toEqual({ ok: true, findings: [] });
    expect(schema(1).validate(r1).ok).toBe(true);
    expect(r1.source.revision).toBe("c0eeec7a260ee58e2ed1514a61bfff1fa013f42e");
    expect(r1.verification.records.map((r) => r.behavior)).toEqual(REQUIRED_BEHAVIORS_V1);
    expect(r1.verification.records.filter((r) => r.status !== "passed").map((r) => [r.behavior, r.status])).toEqual([["integration.fulfillment-claim", "failed"]]);
  });

  it("is superseded: its adapter is not today's, so its results are evidence for nothing current", () => {
    const against = verifyExtractionAt(r1, { planDirectory: dir }).findings;
    expect(against.length).toBeGreaterThan(0);
    expect(new Set(against.map((f) => f.code))).toEqual(new Set(["ADAPTER_MISMATCH"]));
  });
});

describe("revision 2 (current)", () => {
  it("verifies, including the adapter and declaration sources next to its plan", () => {
    expect(verifyExtractionAt(r2, { planDirectory: dir })).toEqual({ ok: true, findings: [] });
    expect(schema(2).validate(r2).ok).toBe(true);
    expect(schema(1).validate(r2).ok).toBe(false);
  });

  it("replaces revision 1, at the bridge fix's source revision, by the revision rules", () => {
    expect(r2.identity).toEqual({ name: "memos.reactions.list", revision: 2, previous: r1.digest });
    expect(r2.source).toMatchObject({ repository: "https://github.com/rkendel1/memos", revision: "e0ce8569589b2eccafd13e262ea3e320251858f2" });
    expect(compareExtractions(r1, r2).map((f) => f.code).sort()).toEqual(["ADAPTER_CHANGED", "DECLARATION_CHANGED", "RUNTIME_CHANGED", "SOURCE_CHANGED"]);
    expect(r2.contract.capabilityDigest).toBe(r1.contract.capabilityDigest);
    expect(canonicalize(r2.contract.canonical)).toBe(canonicalize(read("contract.json")));
  });

  it("binds exactly the declaration the host publishes, a valid claim on the contract", () => {
    const declared = read("runtime/fulfillment.json");
    expect(canonicalize({ extensions: r2.fulfillment!.extensions, attributes: r2.fulfillment!.attributes })).toBe(canonicalize(declared));
    expect(r2.fulfillment!.provider).toEqual(plan.fulfillment.provider);
    expect(declared.attributes[FULFILLMENT_EXTENSION].capabilities["memos.reactions.list@1"]).toEqual([{ contract: "org.appworks.contracts.memos", capability: "memos.reactions.list", version: 1, digest: r2.contract.capabilityDigest }]);
    expect(r2.adapter!.files.map((f) => f.path)).toContain("runtime/fulfillment.json");
    expect(r2.runtime).toEqual({ packages: plan.runtime.packages, application: Object.fromEntries(Object.entries(plan.runtime.application).sort()), node: plan.runtime.node });
  });

  it("records every behavior passed, for exactly its inputs, with what each ran against", () => {
    expect(r2.verification.records.map((r) => r.behavior)).toEqual(REQUIRED_BEHAVIORS);
    expect(r2.verification.summary).toEqual({ "not-run": 0, passed: REQUIRED_BEHAVIORS.length, failed: 0, inconclusive: 0 });
    for (const r of r2.verification.records) {
      expect(r.subject).toEqual({ sourceRevision: r2.source.revision, capabilityDigest: r2.contract.capabilityDigest, adapterDigest: r2.adapter!.digest, declarationDigest: r2.fulfillment!.digest, runtimeDigest: runtimeDigest(r2.runtime!) });
      expect(r.procedure!.reference).toBe("extractions/memos-reactions/test/behavior.test.mjs");
      for (const result of r.results) expect(result).toMatch(/^passed \[(real-application|stub-application|none)\]: /);
    }
    const claim = r2.verification.records.find((r) => r.behavior === "integration.fulfillment-claim")!;
    expect(claim.against).toBe("real-application");
    // Stub-backed evidence stays visible inside a behavior the real application also exercised.
    expect(r2.verification.records.find((r) => r.behavior === "errors.failure-not-success")!.results.some((t) => t.startsWith("passed [stub-application]"))).toBe(true);
  });

  it("carries no credential, secret or personal data, and claims nothing beyond its records", () => {
    const text = JSON.stringify(r2);
    expect(text).not.toMatch(/memos_pat_[A-Za-z0-9]|Bearer [A-Za-z0-9]{20,}|"password"|[\w.+-]+@[\w-]+\.(com|org|net|io)\b/);
    expect(r2.scope).toEqual({ grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false });
  });
});
