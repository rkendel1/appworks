/**
 * Inspecting one step: what it needs, what it produces, and the authority it declares. "Declared" is the capability's
 * contract saying what invoking it requires; whether the runtime has been *granted* that is a separate fact the environment
 * answers (`readiness.ts`).
 */
import { findCapabilityVersion, type JSONSchema } from "@appport/protocol";
import { schemaTypes, type RecipeSource, type RecipeStep, recipeEdges, stepOutputSchema } from "@appport/recipe";
import { fieldsOf, type CatalogEntry, type FieldSummary } from "./catalog.js";
import { readsOf, type Reads } from "./sequence.js";

export interface StepInspection {
  id: string;
  kind: RecipeStep["kind"];
  description?: string;
  reads: Reads;
  /** Capability steps: the capability's input, each field with whether the step maps it. */
  needs?: Array<FieldSummary & { mapped: boolean; from?: string }>;
  /** What the step makes available to later steps, from its schema. */
  produces?: FieldSummary[];
  routes: Array<{ label: string; target: string }>;
  /** Capability steps: what the capability's contract declares invoking it requires. A declaration, not a grant. */
  declaredAuthority?: { dependency: string; contract: string; capability: string; effect: "observation" | "consequential"; scopes: string[]; approvalRequiredByContract?: boolean; approvalTask?: string; contractKnown: boolean };
  /** Task steps. */
  assignee?: string;
}

export function inspectStep(recipe: RecipeSource, id: string, catalog: readonly CatalogEntry[] = []): StepInspection | undefined {
  const step = recipe.steps.find((s) => s.id === id);
  if (!step) return undefined;
  const out: StepInspection = {
    id: step.id,
    kind: step.kind,
    ...(step.description ? { description: step.description } : {}),
    reads: readsOf(step),
    routes: recipeEdges(step).filter((e) => typeof e.target === "string").map((e) => ({ label: e.label, target: e.target })),
    ...(stepOutputSchema(step) ? { produces: fieldsOf(stepOutputSchema(step) as JSONSchema) } : {})
  };
  if (step.kind === "task") out.assignee = step.assignee?.role;
  if (step.kind === "capability") {
    const mapped = new Map((step.input ?? []).flatMap((r) => ("to" in r && typeof r.to === "string" ? [[r.to.replace(/^\//, "").split("/")[0]!, "from" in r ? String(r.from) : "(rule)"] as const] : [])));
    out.needs = fieldsOf(step.expects?.input).map((f) => ({ ...f, mapped: mapped.has(f.name), ...(mapped.has(f.name) ? { from: mapped.get(f.name)! } : {}) }));
    const dependency = recipe.requires.find((d) => d.id === step.uses);
    const target = dependency?.target as { contract?: string; capability?: string } | undefined;
    const entry = catalog.find((c) => c.contract === target?.contract);
    const name = target?.capability?.split("@")[0] ?? "";
    const version = Number(/\d+/.exec(dependency?.versionConstraint ?? "1")?.[0] ?? 1);
    const def = entry && name ? findCapabilityVersion(entry.manifest, name, version) : undefined;
    out.declaredAuthority = {
      dependency: step.uses,
      contract: target?.contract ?? "",
      capability: name,
      effect: step.effect,
      scopes: def ? [...def.authorization] : [],
      ...(def?.authorizationContract ? { approvalRequiredByContract: Boolean((def.authorizationContract as { required?: boolean }).required) } : {}),
      ...(step.approval ? { approvalTask: step.approval.task } : {}),
      contractKnown: Boolean(def)
    };
  }
  return out;
}

export { schemaTypes };
