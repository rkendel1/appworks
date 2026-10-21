/** An HTTP route (assessment /2, scanner 2) is not extractable by this version, and says why; an RPC is judged as before. */
import { describe, expect, it } from "vitest";
import { assessRepository } from "@appport/assessment";
import { syntheticApp, tempDir, writeTree } from "../../assessment/test/helpers.js";
import { candidateRefusals } from "../src/index.js";

const express = () =>
  writeTree(tempDir("extraction-http-"), {
    "package.json": JSON.stringify({ name: "shop", dependencies: { express: "^4" } }),
    "app.js": "const express = require('express');\nconst app = express();\napp.get('/health', (req, res) => res.json({ ok: true }));\n"
  });

describe("candidateRefusals for an HTTP route", () => {
  const assessment = assessRepository(express(), { scanner: 2 });
  const route = assessment.candidates.find((c) => c.operation.kind === "http")!;

  it("is refused as not an RPC, with every other unmet criterion still named", () => {
    expect(route).toBeDefined();
    const codes = candidateRefusals(route, route.id).map((r) => r.code);
    expect(codes).toContain("CANDIDATE_NOT_RPC");
    expect(codes).toEqual(expect.arrayContaining(["CANDIDATE_NOT_READY", "CANDIDATE_SCHEMA_UNRESOLVED", "CANDIDATE_NO_PROPOSAL"]));
    expect(candidateRefusals(route, route.id).find((r) => r.code === "CANDIDATE_NOT_RPC")!.message).toMatch(/no way to derive a contract, an adapter or a behavioral suite for an HTTP route/);
  });

  it("is never made eligible by its other properties: a read-only, linked route is still refused as not an RPC", () => {
    const forced = structuredClone(route);
    forced.readiness.class = "exposure-candidate";
    for (const c of forced.readiness.criteria) c.satisfied = true;
    forced.exposure.effectBasis.effect = "observation";
    forced.exposure.capability = { name: "shop.health", version: 1, kind: "request", inputSchema: { type: "object" }, outputSchema: { type: "object" }, effect: "observation" };
    expect(candidateRefusals(forced, forced.id).map((r) => r.code)).toEqual(["CANDIDATE_NOT_RPC"]);
  });
});

describe("RPC candidates are judged as before", () => {
  it("never carry CANDIDATE_NOT_RPC", () => {
    const rpc = assessRepository(writeTree(tempDir("extraction-rpc-"), syntheticApp()), { scanner: 2 });
    const candidates = rpc.candidates.filter((c) => c.operation.kind === "rpc");
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(candidateRefusals(c, c.id).map((r) => r.code)).not.toContain("CANDIDATE_NOT_RPC");
  });
});
