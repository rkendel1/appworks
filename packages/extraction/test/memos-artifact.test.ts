/**
 * The committed extraction of Memos MemoService.ListMemoReactions (extractions/memos-reactions/extraction.json), checked
 * offline against the files it binds: the contract, the plan's mapping, the adapter sources and the schema. Its
 * behavioral results are produced against a real Memos by extractions/memos-reactions (CI job memos-extraction, which
 * also regenerates this file and requires the same digest).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, type JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { REQUIRED_BEHAVIORS, verifyExtractionAt, type CapabilityExtraction } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../extractions/memos-reactions/", import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(dir + name, "utf8"));
const x = read("extraction.json") as CapabilityExtraction;
const plan = read("extraction-plan.json");

describe("the committed Memos extraction", () => {
  it("verifies, including the adapter sources next to its plan", () => {
    expect(verifyExtractionAt(x, { planDirectory: dir })).toEqual({ ok: true, findings: [] });
    const schema = fromJSONSchema(JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/capability-extraction.schema.json", import.meta.url)), "utf8")) as JSONSchema);
    expect(schema.validate(x).ok).toBe(true);
  });

  it("is tied to the pinned Memos revision and the selected candidate", () => {
    expect(x.source).toMatchObject({ name: "memos", repository: "https://github.com/rkendel1/memos", revision: "c0eeec7a260ee58e2ed1514a61bfff1fa013f42e", operation: { fullMethod: "/memos.api.MemoService/ListMemoReactions", http: "GET /api/{parent=memos/*}/reactions" } });
    expect(x.source.implementation).toMatchObject({ symbol: "server/api:APIService.ListMemoReactions", location: { path: "server/api/reaction_service.go" } });
    expect(x.assessment.candidate.id).toBe("cand-memos.api.MemoService.ListMemoReactions");
    expect(x.identity).toEqual({ name: "memos.reactions.list", revision: 1 });
  });

  it("binds exactly the reviewed contract and mapping", () => {
    expect(canonicalize(x.contract.canonical)).toBe(canonicalize(read("contract.json")));
    expect(x.contract.proposal.name).toBe("memo.reactions.list");
    expect(x.contract.mapping.changes.length).toBe(plan.mapping.changes.length);
    expect(x.authorization.requirements).toEqual(plan.authorization.requirements);
    expect(x.sideEffects.persistence.every((p) => p.operation === "read")).toBe(true);
  });

  it("records each behavior separately, with the known gap failed rather than hidden", () => {
    expect(x.verification.records.map((r) => r.behavior)).toEqual(REQUIRED_BEHAVIORS);
    const failed = x.verification.records.filter((r) => r.status !== "passed");
    expect(failed.map((r) => [r.behavior, r.status])).toEqual([["integration.fulfillment-claim", "failed"]]);
    expect(failed[0]!.limitations.join(" ")).toMatch(/claim\.undeclared/);
    for (const r of x.verification.records) {
      expect(r.subject).toEqual({ sourceRevision: x.source.revision, capabilityDigest: x.contract.capabilityDigest, adapterDigest: x.adapter!.digest });
      expect(r.procedure!.reference).toBe("extractions/memos-reactions/test/behavior.test.mjs");
    }
    expect(x.verification.records.find((r) => r.behavior === "errors.failure-not-success")!.procedure!.kind).toBe("unit-test");
    expect(x.scope).toEqual({ grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false });
  });
});
