/**
 * Edit operations on the canonical recipe. The Studio's only way to change a recipe: each operation takes the `appport.recipe/1`
 * document and returns the next one, so what is saved is always the canonical source and never a model of the Studio's own. An
 * edit can leave the recipe invalid (a route not yet written, a field not yet mapped); validation says so. No edit acquires,
 * requests or records authority: a recipe has no place to hold any.
 */
import { findCapabilityVersion, type Dependency, type JSONSchema } from "@appport/protocol";
import { schemaTypes, type RecipeOutcome, type RecipeProvenance, type RecipeStep } from "@appport/recipe";
import { verifyMethodsOf, type CatalogEntry } from "./catalog.js";
import { StudioError } from "./project.js";

type Draft = Record<string, any>;

export type RecipeEdit =
  | { op: "meta"; id?: string; name?: string; description?: string; objective?: string }
  /** Adds or replaces a field of the recipe's input or output contract. */
  | { op: "field"; where: "inputs" | "outputs"; name: string; schema: JSONSchema; required?: boolean }
  | { op: "removeField"; where: "inputs" | "outputs"; name: string }
  /** Adds a step that invokes a capability from the environment's catalog, deriving the dependency, the expected shapes, the declared verification and suggested input wiring from its contract. */
  | { op: "addCapability"; step: string; contract: string; capability: string; version?: number; dependency?: string; purpose?: string; wire?: boolean; approval?: string; on: { success: string; failure: string; uncertain?: string } }
  | { op: "dependency"; dependency: Dependency }
  /** Adds or replaces a step by id. The first step added becomes the start unless one is set. */
  | { op: "step"; step: RecipeStep }
  | { op: "removeStep"; id: string }
  | { op: "start"; id: string }
  | { op: "outcome"; outcome: RecipeOutcome }
  /** Who wrote it and where it is maintained: descriptive, never an identity or a trust claim. */
  | { op: "provenance"; provenance: RecipeProvenance };

export const emptySchema = (): JSONSchema => ({ type: "object", additionalProperties: false, properties: {} });

/** A new, empty recipe: well-formed enough to save and reopen, not yet valid (it has no steps). */
export function newRecipe(seed: { id: string; name: string; objective: string; description?: string }): Draft {
  return {
    format: "appport.recipe/1",
    id: seed.id,
    name: seed.name,
    ...(seed.description ? { description: seed.description } : {}),
    objective: seed.objective,
    inputs: emptySchema(),
    outputs: emptySchema(),
    outcome: { description: "", verify: [] },
    requires: [],
    start: "",
    steps: []
  };
}

const isObject = (v: unknown): v is Draft => v !== null && typeof v === "object" && !Array.isArray(v);
const slug = (text: string) => text.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function schemaOf(recipe: Draft, where: "inputs" | "outputs"): Draft {
  if (!isObject(recipe[where])) recipe[where] = emptySchema();
  const schema = recipe[where] as Draft;
  if (!isObject(schema["properties"])) schema["properties"] = {};
  return schema;
}

function upsert<T extends { id: string }>(list: unknown, item: T): T[] {
  const items = Array.isArray(list) ? ([...list] as T[]) : [];
  const at = items.findIndex((x) => x?.id === item.id);
  if (at >= 0) items[at] = item;
  else items.push(item);
  return items;
}

/** @throws StudioError for an edit that cannot be applied at all (an unknown capability, a missing target). */
export function applyEdits(recipe: unknown, edits: readonly RecipeEdit[], context: { catalog?: readonly CatalogEntry[] } = {}): Draft {
  if (!isObject(recipe)) throw new StudioError("INVALID", "the recipe is not a JSON object; only a recipe document can be edited");
  const next = structuredClone(recipe) as Draft;
  for (const edit of edits) apply(next, edit, context.catalog ?? []);
  return next;
}

function apply(recipe: Draft, edit: RecipeEdit, catalog: readonly CatalogEntry[]): void {
  switch (edit.op) {
    case "meta":
      for (const key of ["id", "name", "objective", "description"] as const) {
        const value = edit[key];
        if (value === undefined) continue;
        if (key === "description" && value === "") delete recipe[key];
        else recipe[key] = value;
      }
      return;
    case "field": {
      const schema = schemaOf(recipe, edit.where);
      schema["properties"][edit.name] = structuredClone(edit.schema);
      const required = new Set<string>(Array.isArray(schema["required"]) ? schema["required"] : []);
      if (edit.required) required.add(edit.name);
      else if (edit.required === false) required.delete(edit.name);
      if (required.size) schema["required"] = [...required];
      else delete schema["required"];
      return;
    }
    case "removeField": {
      const schema = schemaOf(recipe, edit.where);
      delete schema["properties"][edit.name];
      if (Array.isArray(schema["required"])) {
        schema["required"] = schema["required"].filter((n: string) => n !== edit.name);
        if (!schema["required"].length) delete schema["required"];
      }
      return;
    }
    case "dependency":
      recipe["requires"] = upsert(recipe["requires"], structuredClone(edit.dependency));
      return;
    case "step":
      recipe["steps"] = upsert(recipe["steps"], structuredClone(edit.step));
      if (!recipe["start"]) recipe["start"] = edit.step.id;
      return;
    case "removeStep":
      recipe["steps"] = (Array.isArray(recipe["steps"]) ? recipe["steps"] : []).filter((s: Draft) => s?.id !== edit.id);
      if (recipe["start"] === edit.id) recipe["start"] = "";
      return;
    case "start":
      recipe["start"] = edit.id;
      return;
    case "outcome":
      recipe["outcome"] = structuredClone(edit.outcome);
      return;
    case "provenance":
      recipe["provenance"] = structuredClone(edit.provenance);
      return;
    case "addCapability":
      return addCapability(recipe, edit, catalog);
  }
}

function addCapability(recipe: Draft, edit: Extract<RecipeEdit, { op: "addCapability" }>, catalog: readonly CatalogEntry[]): void {
  const entry = catalog.find((c) => c.contract === edit.contract);
  if (!entry) throw new StudioError("INVALID", `this environment holds no active contract ${edit.contract}: nothing to compose from it`);
  const known = entry.manifest.capabilities.find((c) => c.name === edit.capability);
  if (!known) throw new StudioError("INVALID", `contract ${edit.contract} has no capability ${edit.capability}`);
  const version = edit.version ?? Math.max(...(known.versions ?? []));
  const definition = findCapabilityVersion(entry.manifest, edit.capability, version);
  if (!definition) throw new StudioError("INVALID", `${edit.capability} has no version ${version} in ${edit.contract}`);

  const effect = definition.effect === "observation" ? "observation" : "consequential";
  const dependencyId = edit.dependency ?? slug(edit.capability);
  const existing = (Array.isArray(recipe["requires"]) ? recipe["requires"] : []).find((d: Draft) => d?.id === dependencyId);
  if (!existing) {
    recipe["requires"] = upsert(recipe["requires"], {
      id: dependencyId,
      relationship: effect === "observation" ? "observes" : "invokes",
      target: { contract: edit.contract, capability: edit.capability },
      required: true,
      versionConstraint: `^${version}`,
      purpose: edit.purpose ?? definition.description ?? edit.capability
    });
  }

  // Suggested wiring: same-named fields of compatible type and the same concept only. Anything else is left for the author, and validation names it.
  const inputs = (recipe["inputs"]?.properties ?? {}) as Record<string, JSONSchema>;
  const rules: Draft[] = [];
  if (edit.wire !== false) {
    for (const [name, schema] of Object.entries((definition.inputSchema.properties ?? {}) as Record<string, JSONSchema>)) {
      const source = inputs[name];
      if (!source || name.includes("/") || name.includes("~")) continue;
      const a = schemaTypes(source);
      const b = schemaTypes(schema);
      if (a.length && b.length && !a.every((t) => b.includes(t))) continue;
      // A field with a different meaning is not the same field, whatever it is called: a concept mismatch is for the author to resolve.
      const concept = (x: JSONSchema) => (x as Record<string, unknown>)["x-appport-concept"];
      if (concept(source) !== concept(schema)) continue;
      rules.push({ op: "copy", from: `/input/${escapePointer(name)}`, to: `/${escapePointer(name)}` });
    }
  }
  const methods = verifyMethodsOf(entry.manifest, edit.capability, version);
  recipe["steps"] = upsert(recipe["steps"], {
    id: edit.step,
    kind: "capability",
    uses: dependencyId,
    effect,
    expects: { input: structuredClone(definition.inputSchema), output: structuredClone(definition.outputSchema) },
    input: rules,
    ...(edit.approval ? { approval: { task: edit.approval } } : {}),
    ...(methods.length ? { verify: { methods } } : {}),
    on: { success: edit.on.success, failure: edit.on.failure, ...(edit.on.uncertain ? { uncertain: edit.on.uncertain } : {}) }
  });
  if (!recipe["start"]) recipe["start"] = edit.step;
}
