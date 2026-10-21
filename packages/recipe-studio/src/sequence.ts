/** Reading a recipe's flow: the order steps are reached in, and the data each step reads. Pure functions of the canonical source. */
import { recipeEdges, type RecipeSource, type RecipeStep } from "@appport/recipe";

/** Steps in the order they are first reached from `start`, following routes in declared order; unreachable steps follow, last. */
export function executionOrder(recipe: RecipeSource): RecipeStep[] {
  const byId = new Map(recipe.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const order: RecipeStep[] = [];
  const queue = [recipe.start];
  while (queue.length) {
    const id = queue.shift()!;
    const step = byId.get(id);
    if (!step || seen.has(id)) continue;
    seen.add(id);
    order.push(step);
    for (const edge of recipeEdges(step)) if (typeof edge.target === "string") queue.push(edge.target);
  }
  return [...order, ...recipe.steps.filter((s) => !seen.has(s.id))];
}

export interface Reads {
  /** Recipe input fields (`/input/<field>`). */
  inputs: string[];
  /** Earlier steps' outputs (`/steps/<id>/output/...`). */
  steps: string[];
}

const unescape = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");

/** The recipe data a step reads, found where the model puts references: `from`, `ref`, and a task's `present` values. */
export function readsOf(step: RecipeStep): Reads {
  const inputs = new Set<string>();
  const steps = new Set<string>();
  const note = (pointer: unknown) => {
    if (typeof pointer !== "string") return;
    const input = /^\/input\/([^/]+)/.exec(pointer);
    if (input) inputs.add(unescape(input[1]!));
    const other = /^\/steps\/([^/]+)\//.exec(pointer);
    if (other) steps.add(other[1]!);
  };
  const walk = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === "from" || k === "ref") note(v);
        else if (k === "value" && key === "present") note(v);
        else walk(v, k);
      }
    }
  };
  // A step's own `expects` and `output` are schemas, not reads.
  const { expects: _expects, output: _output, response: _response, ...rest } = step as unknown as Record<string, unknown>;
  walk(rest);
  return { inputs: [...inputs], steps: [...steps] };
}
