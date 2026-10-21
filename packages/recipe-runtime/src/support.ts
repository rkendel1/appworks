/**
 * What this slice of the runtime executes (spec/runtime-1.md §12). A recipe outside it is refused when a run is
 * started, with every reason, instead of being run partly.
 */
import type { RecipeSource } from "@appport/recipe";
import { SUPPORTED_RULE_OPS } from "./rules.js";

export function unsupportedConstructs(recipe: RecipeSource): string[] {
  const out: string[] = [];
  const rules = (path: string, list: readonly { op: string }[] | undefined) =>
    (list ?? []).forEach((rule, i) => {
      if (!(SUPPORTED_RULE_OPS as readonly string[]).includes(rule.op)) out.push(`${path}/${i}: rule "${rule.op}" is not executed by this runtime`);
    });
  recipe.steps.forEach((step, i) => {
    const at = `/steps/${i} (${step.id})`;
    switch (step.kind) {
      case "capability":
        rules(`${at}/input`, step.input);
        if (step.preconditions?.length) out.push(`${at}/preconditions: preconditions are not executed by this runtime`);
        break;
      case "transform":
        rules(`${at}/rules`, step.rules);
        break;
      case "end":
        rules(`${at}/output`, step.output);
        break;
      default:
        break;
    }
  });
  return out;
}
