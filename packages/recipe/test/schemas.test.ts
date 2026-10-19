/**
 * The published JSON Schemas (shipped in the package, `schemas/`) stay aligned with what the implementation produces,
 * and the recipe rule checks are AppPort's mapping lint, unchanged.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AppPortManifest, JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { lintMapping, schemaIdentity, type MappingArtifact, type Rule } from "@appport/integration";
import { createRecipeLock, createRecipePackage, lintRecipeRules } from "../src/index.js";
import { CONTRACT, accountingContract, example } from "./fixtures.js";

const schema = (name: string) => fromJSONSchema(JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${name}`, import.meta.url)), "utf8")) as JSONSchema);

describe("schema alignment", () => {
  it("the example validates against recipe.schema.json; undocumented members, unknown step kinds and application targets do not", () => {
    const recipe = schema("recipe.schema.json");
    expect(recipe.validate(example()).ok).toBe(true);
    expect(recipe.validate({ ...example(), retries: 3 }).ok).toBe(false);
    expect(recipe.validate({ ...example(), format: "appport.recipe/2" }).ok).toBe(false);
    const unknownKind = example();
    unknownKind.steps.push({ id: "shell", kind: "script", command: "rm -rf /" } as never);
    expect(recipe.validate(unknownKind).ok).toBe(false);
    const appTarget = example();
    appTarget.requires[1]!.target = { application: "com.acme.erp", capability: "ap.release@1" };
    expect(recipe.validate(appTarget).ok).toBe(false);
  });

  it("locks and packages validate against recipe-lock.schema.json and recipe-package.schema.json", () => {
    const recipe = example();
    const lock = createRecipeLock(recipe, { contracts: { [CONTRACT]: accountingContract() } });
    expect(schema("recipe-lock.schema.json").validate(lock).ok).toBe(true);
    const pkg = createRecipePackage(recipe, lock, { provenance: { tool: "schema-test" } });
    expect(schema("recipe-package.schema.json").validate(pkg).ok).toBe(true);
    // The validator resolves only local $defs; the embedded parts are checked by their own schemas.
    expect(schema("recipe.schema.json").validate(pkg.recipe).ok).toBe(true);
    expect(schema("recipe-lock.schema.json").validate(pkg.lock).ok).toBe(true);
    expect(schema("recipe-package.schema.json").validate({ ...pkg, kind: "compiled" }).ok).toBe(false);
    expect(schema("recipe-package.schema.json").validate({ ...pkg, format: "appport.recipe-package/2" }).ok).toBe(false);
  });
});

describe("recipe rules are checked by AppPort's mapping lint, unchanged", () => {
  const source: JSONSchema = {
    type: "object",
    required: ["minutes", "status"],
    properties: { minutes: { type: "number", "x-appport-unit": "min" }, status: { type: "string", enum: ["open", "closed"] }, note: { type: "string" } }
  };
  const target: JSONSchema = {
    type: "object",
    required: ["hours", "state", "note", "count"],
    properties: { hours: { type: "number", "x-appport-unit": "h" }, state: { type: "string", enum: ["OPEN", "DONE"] }, note: { type: "string" }, count: { type: "integer" }, extra: { type: "boolean" } }
  };
  const rules: Rule[] = [
    { op: "copy", from: "/minutes", to: "/hours" },
    { op: "enum", from: "/status", to: "/state", table: { open: "OPEN", closed: "CLOSED" }, relation: "exact", unmapped: "reject" },
    { op: "copy", from: "/note", to: "/note" },
    { op: "const", to: "/extra", value: "yes" }
  ];

  it("reports, per rule, exactly what lintMapping reports for the same rules between the same schemas", () => {
    const manifest = (id: string, side: "input" | "output", record: JSONSchema): AppPortManifest => {
      const d = { version: 1, kind: "request", inputSchema: side === "input" ? record : { type: "object" }, outputSchema: side === "output" ? record : { type: "object" }, authorization: [] };
      return { protocol: "appport/1", application: { id, name: id, version: "1.0.0" }, capabilities: [{ name: "x.y", versions: [1], latestVersion: 1, ...d, definitions: [d] }], events: [], transports: [] } as never;
    };
    const mapping = {
      format: "appport.mapping/1", kind: "declarative", id: "urn:test", version: 1, origin: "provider",
      from: { application: "com.example.a", capability: "x.y@1", side: "output", schemaDigest: schemaIdentity(source) },
      to: { application: "com.example.b", capability: "x.y@1", side: "input", schemaDigest: schemaIdentity(target) },
      rules, lossy: [], vectors: []
    } as unknown as MappingArtifact;
    const direct = lintMapping(mapping, { from: manifest("com.example.a", "output", source), to: manifest("com.example.b", "input", target) }, { requireConcepts: false })
      .filter((i) => i.path.startsWith("rules"))
      .map((i) => [i.level, i.message]);
    const sources = rules.map((r) => (r.op === "const" ? undefined : { schema: source.properties![r.from.slice(1)]!, required: source.required!.includes(r.from.slice(1)) }));
    const adapted = lintRecipeRules(rules, sources, target).map((i) => [i.level, i.message]);
    expect(adapted).toEqual(direct);
    // And the findings are the substantive ones: a unit copy, an enum value, an optional source, a constant, a missing field.
    expect(adapted.map(([, m]) => m)).toEqual(expect.arrayContaining([
      expect.stringMatching(/copy between different units \(min → h\)/),
      expect.stringMatching(/"CLOSED" is not a declared value of \/state/),
      expect.stringMatching(/\/note is optional but \/note is required/),
      "the constant is not allowed by the target schema",
      "required target field /count is not produced by any rule"
    ]));
  });
});
