import { describe, expect, it } from "vitest";
import { assessRepository, type ApplicationAssessment } from "@appport/assessment";
import { syntheticApp, tempDir, writeTree } from "../../assessment/test/helpers.js";
import { reconcile, type DiscoveryRecord, type ExtractionBinding } from "../src/index.js";

const GET = "cand-notes.v1.NoteService.GetNote";
const DELETE = "cand-notes.v1.NoteService.DeleteNote";
const assessment: ApplicationAssessment = assessRepository(writeTree(tempDir("rec-"), syntheticApp()));
const nothing = { publisherTrust: false, authorization: false, approval: false, invoked: false } as const;
const discovery = (capabilities: DiscoveryRecord["capabilities"], outcome: DiscoveryRecord["outcome"] = "discovered"): DiscoveryRecord => ({ format: "appworks.discovery/1", outcome, at: "2026-10-19T00:00:00.000Z", reasons: [], capabilities, established: nothing, note: "" });
const cap = (name: string, input: string[], required: string[], effect = "observation", output: string[] = []) => ({ name, version: 1, status: "verified" as const, reasons: [], effect, input: { properties: input, required }, output: { properties: output }, claims: [] });
const binding = (candidate: string, verified: boolean): ExtractionBinding => ({ candidate, capability: { name: "note.get", version: 1 }, extraction: "note.get revision 1", extractionDigest: "sha256:" + "1".repeat(64), verified, detail: verified ? "verified" : "not verified" });

describe("reconciliation", () => {
  it("never equates names: a capability whose interface fits no candidate is unresolved, with name hints only", () => {
    const inv = reconcile({ assessment, discovery: discovery([cap("notes.get", ["id"], ["id"])]), bindings: [], decisions: [] });
    const c = inv.capabilities[0]!;
    expect(c.status).toBe("unresolved");
    expect(c.candidates).toEqual([]);
    expect(c.hints.map((h) => h.candidate)).toContain(GET);
    expect(c.hints[0]!.detail).toMatch(/not evidence/);
  });

  it("calls a single interface fit probable, and several ambiguous without forcing a choice", () => {
    const one = reconcile({ assessment, discovery: discovery([cap("whatever.read", ["name"], ["name"], "observation", ["name", "body"])]), bindings: [], decisions: [] });
    expect(one.capabilities[0]!.status).toBe("probable");
    expect(one.capabilities[0]!.candidates.map((x) => x.id)).toEqual([GET]);
    expect(one.capabilities[0]!.candidates[0]!.evidence[0]!.kind).toBe("interface-shape");
    // GetNote and DeleteNote both take {name}; without an effect or output to separate them, both fit
    const two = reconcile({ assessment, discovery: discovery([{ ...cap("x.y", ["name"], ["name"]), effect: undefined, output: undefined }]), bindings: [], decisions: [] });
    expect(two.capabilities[0]!.status).toBe("ambiguous");
    expect(two.capabilities[0]!.candidates.map((x) => x.id).sort()).toEqual([DELETE, GET]);
    expect(two.candidates.find((c) => c.id === GET)!.exposure).toBe("possibly-exposed");
  });

  it("confirms only on a verified extraction, and keeps unverified evidence probable", () => {
    const d = discovery([cap("note.get", ["name"], ["name"])]);
    expect(reconcile({ assessment, discovery: d, bindings: [binding(GET, false)], decisions: [] }).capabilities[0]!.status).toBe("probable");
    const confirmed = reconcile({ assessment, discovery: d, bindings: [binding(GET, true)], decisions: [] });
    expect(confirmed.capabilities[0]!.status).toBe("confirmed");
    expect(confirmed.capabilities[0]!.sources).toEqual(["discovery", "extraction"]);
    expect(confirmed.candidates.find((c) => c.id === GET)!.exposure).toBe("exposed");
    expect(reconcile({ assessment, discovery: d, bindings: [binding(GET, true), binding(DELETE, true)], decisions: [] }).capabilities[0]!.status).toBe("ambiguous");
  });

  it("records an operator's assertion as evidence, never as confirmation", () => {
    const decision = { id: "d", capability: { name: "x.y", version: 1 }, candidate: GET, rationale: "same handler", by: "local:operator", at: "t" };
    const inv = reconcile({ assessment, discovery: discovery([cap("x.y", ["q"], [])]), bindings: [], decisions: [decision] });
    expect(inv.capabilities[0]!.status).toBe("probable");
    expect(inv.capabilities[0]!.candidates[0]!.evidence[0]!.kind).toBe("operator-assertion");
  });

  it("keeps every candidate, exposed or not, and says when exposure is unknown", () => {
    const known = reconcile({ assessment, discovery: discovery([]), bindings: [], decisions: [] });
    expect(known.candidates).toHaveLength(assessment.candidates.length);
    expect(new Set(known.candidates.map((c) => c.exposure))).toEqual(new Set(["not-exposed"]));
    const unknown = reconcile({ assessment, discovery: discovery([], "unavailable"), bindings: [], decisions: [] });
    expect(new Set(unknown.candidates.map((c) => c.exposure))).toEqual(new Set(["unknown"]));
    expect(unknown.partial.map((p) => p.code)).toContain("DISCOVERY_UNAVAILABLE");
    // a capability provided only by an extraction is inventoried too
    const extracted = reconcile({ assessment, discovery: discovery([], "no-integration"), bindings: [binding(GET, true)], decisions: [] });
    expect(extracted.capabilities.map((c) => [c.name, c.sources, c.status])).toEqual([["note.get", ["extraction"], "confirmed"]]);
  });

  it("does not match through a capability discovery could not verify", () => {
    const inv = reconcile({ assessment, discovery: discovery([{ ...cap("note.get", ["name"], ["name"]), status: "unresolved", reasons: ["capability.digest-mismatch"] }]), bindings: [], decisions: [] });
    expect(inv.capabilities[0]!.status).toBe("unresolved");
    expect(inv.capabilities[0]!.basis).toMatch(/digest-mismatch/);
  });
});
