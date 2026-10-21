/**
 * The recipe card: the recipe in the visual format of a printed recipe. A title and purpose; the preconditions the environment
 * must meet; a grid whose rows are the ingredients (the recipe's inputs, each with how it is prepared) and whose columns are
 * the steps in the order they happen, each spanning the rows it consumes; and the finish. It is computed from the canonical
 * source alone, so a card is exactly as portable as the recipe and says nothing about any environment's providers.
 *
 * A step that reads no input directly (it combines earlier results) spans every row, as a final "fold" does in a printed recipe.
 * Branches do not fit a straight grid, so each column lists where it can go next; the ends are summarised under `finish`.
 */
import type { JSONSchema } from "@appport/protocol";
import { recipeEdges, type RecipeSource } from "@appport/recipe";
import { fieldsOf } from "./catalog.js";
import { executionOrder, readsOf } from "./sequence.js";

export interface CardRow {
  name: string;
  type: string;
  required: boolean;
  /** How the ingredient is prepared before use: its declared constraints. */
  prep: string;
}

export interface CardColumn {
  step: string;
  kind: string;
  /** What happens, in a few words. */
  action: string;
  /** First and last row (0-based, inclusive) the step spans. */
  from: number;
  to: number;
  next: Array<{ label: string; target: string }>;
}

export interface RecipeCard {
  title: string;
  purpose: string;
  /** Full-width rows above the grid, like "preheat the oven": what must be true of the environment. Names no provider. */
  setup: string[];
  rows: CardRow[];
  columns: CardColumn[];
  finish: { produces: string[]; ends: Array<{ step: string; outcome: string; note?: string }>; verifies: string[] };
}

function prepOf(schema: JSONSchema): string {
  const parts: string[] = [];
  if (schema.enum) parts.push(`one of ${(schema.enum as unknown[]).join(", ")}`);
  if (typeof schema.minLength === "number") parts.push(`at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`);
  if (typeof schema.minimum === "number") parts.push(`at least ${schema.minimum}`);
  if (typeof schema.maximum === "number") parts.push(`at most ${schema.maximum}`);
  if (typeof schema.format === "string") parts.push(`${schema.format} format`);
  const unit = (schema as Record<string, unknown>)["x-appport-unit"];
  if (typeof unit === "string") parts.push(`in ${unit}`);
  return parts.join("; ");
}

function actionOf(recipe: RecipeSource, step: RecipeSource["steps"][number]): string {
  switch (step.kind) {
    case "capability": {
      const target = recipe.requires.find((d) => d.id === step.uses)?.target as { capability?: string } | undefined;
      return `${step.effect === "observation" ? "look up" : "perform"} ${target?.capability ?? step.uses}`;
    }
    case "decision":
      return `decide${step.description ? `: ${step.description}` : ""}`;
    case "transform":
      return `compute${step.description ? `: ${step.description}` : ""}`;
    case "task":
      return `ask ${step.assignee?.role ?? "a person"}${step.approval ? " to approve" : ""}`;
    case "end":
      return step.outcome;
  }
}

export function recipeCard(recipe: RecipeSource): RecipeCard {
  const rows: CardRow[] = fieldsOf(recipe.inputs).map((f) => ({ name: f.name, type: f.type, required: f.required, prep: prepOf((recipe.inputs.properties as Record<string, JSONSchema>)[f.name]!) }));
  const index = new Map(rows.map((r, i) => [r.name, i]));
  const last = Math.max(rows.length - 1, 0);

  const columns: CardColumn[] = executionOrder(recipe)
    .filter((s) => s.kind !== "end")
    .map((step) => {
      const consumed = readsOf(step).inputs.flatMap((n) => (index.has(n) ? [index.get(n)!] : []));
      return {
        step: step.id,
        kind: step.kind,
        action: actionOf(recipe, step),
        from: consumed.length ? Math.min(...consumed) : 0,
        to: consumed.length ? Math.max(...consumed) : last,
        next: recipeEdges(step).filter((e) => typeof e.target === "string").map((e) => ({ label: e.label, target: e.target }))
      };
    });

  const setup = [
    ...recipe.requires.map((d) => {
      const t = d.target as { contract?: string; capability?: string };
      return `${d.required === false ? "May use" : "Needs"} ${t.capability ?? d.id} from ${t.contract ?? "a contract"}${d.versionConstraint ? ` (${d.versionConstraint})` : ""}, which ${d.relationship === "observes" ? "only reads" : "changes things"}`;
    }),
    ...[...new Set(recipe.steps.flatMap((s) => (s.kind === "task" ? [s.assignee?.role] : [])))].filter(Boolean).map((r) => `Someone in ${r} must be available to answer`)
  ] as string[];

  return {
    title: recipe.name,
    purpose: recipe.objective,
    setup,
    rows,
    columns,
    finish: {
      produces: fieldsOf(recipe.outputs).map((f) => `${f.name} (${f.type}${f.required ? "" : ", optional"})`),
      ends: recipe.steps.flatMap((s) => (s.kind === "end" ? [{ step: s.id, outcome: s.outcome, ...(s.description ? { note: s.description } : {}) }] : [])),
      verifies: [recipe.outcome?.description, ...(recipe.outcome?.verify ?? []).map((v) => `${v.id}: read back through ${v.via.uses}`)].filter((x): x is string => Boolean(x))
    }
  };
}
