/**
 * The published JSON Schemas (shipped in the package, `schemas/`) stay aligned with what the implementation produces,
 * and the recipe's rule checks are AppPort's published `lintRule`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRequiredAt, schemaAt, type JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { lintRule, type RuleEndpoint } from "@appport/integration";
import { createRecipeLock, createRecipePackage, validateRecipe, type CapabilityStep } from "../src/index.js";
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

describe("recipe rules are checked by AppPort's lintRule", () => {
  it("a recipe's mapping findings are exactly what the published lintRule reports for the same rule", () => {
    const recipe = example();
    const submit = recipe.steps.find((st) => st.id === "submit") as CapabilityStep;
    const rule = { op: "copy", from: "/input/supplierId", to: "/amount" } as const;
    submit.input[2] = rule;
    const fromRecipe = validateRecipe(recipe).findings.filter((f) => f.path.startsWith("/steps/5/input/2")).map((f) => f.message);

    const direct: string[] = [];
    const source: RuleEndpoint = (pointer) => (pointer === rule.from ? { schema: recipe.inputs.properties!["supplierId"]!, required: true } : undefined);
    const target: RuleEndpoint = (pointer) => {
      const node = schemaAt(submit.expects.input, pointer);
      return node ? { schema: node, required: isRequiredAt(submit.expects.input, pointer) } : undefined;
    };
    lintRule(rule, "rules[0]", { source, target }, { requireConcepts: false, lossFor: () => false }, (_p, m) => direct.push(m), (_p, m) => direct.push(m));
    expect(fromRecipe).toEqual(direct);
    expect(direct.join()).toMatch(/copy between incompatible types \(string → number\)/);
  });
});
