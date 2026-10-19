/** The shipped JSON Schema stays aligned with what the implementation produces and with the verifier. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { TOOL_VERSION, assessRepository } from "../src/index.js";
import { MEMOS_FIXTURE, clone, syntheticApp, tempDir, writeTree } from "./helpers.js";

const schema = fromJSONSchema(JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/application-assessment.schema.json", import.meta.url)), "utf8")) as JSONSchema);

describe("application-assessment.schema.json", () => {
  it("accepts what the implementation produces", () => {
    for (const root of [MEMOS_FIXTURE, writeTree(tempDir(), syntheticApp()), tempDir()]) expect(schema.validate(assessRepository(root)).ok).toBe(true);
  });

  it("refuses undocumented members, verified claims and granted authority", () => {
    const a = assessRepository(MEMOS_FIXTURE);
    const cases: Array<(x: Record<string, any>) => void> = [
      (x) => (x.grant = {}),
      (x) => (x.candidates[0].readiness.class = "verified"),
      (x) => (x.scope.grantsAuthority = true),
      (x) => (x.candidates[0].exposure.authoritative = true),
      (x) => (x.evidence[0].class = "assumed"),
      (x) => (x.evidence[0].score = 0.8),
      (x) => (x.format = "appport.application-assessment/2")
    ];
    for (const edit of cases) {
      const x = clone(a) as unknown as Record<string, any>;
      edit(x);
      expect(schema.validate(x).ok).toBe(false);
    }
  });

  it("the tool version matches the package version", () => {
    expect(JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version).toBe(TOOL_VERSION);
  });
});
