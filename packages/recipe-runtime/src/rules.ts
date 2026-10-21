/**
 * The rule vocabulary the runtime executes (spec/runtime-1.md §5): `copy`, `const` and `compute`. Everything else in
 * `appport.mapping/1` (`enum`, `unit`, `encoding`) is refused when a run is started, never half-applied.
 */
import type { JsonValue } from "@appport/protocol";
import { readPointer, parsePointer } from "@appport/protocol";
import { evaluateExpression, type RecipeRule } from "@appport/recipe";

export const SUPPORTED_RULE_OPS = ["copy", "const", "compute"] as const;

/** Sets `value` at `pointer` in `target`, creating objects on the way. Array indices are not supported (no rule needs them). */
export function setPointer(target: Record<string, JsonValue>, pointer: string, value: JsonValue): void {
  const parts = parsePointer(pointer);
  if (!parts.length) throw new Error("a rule cannot write the whole document");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === undefined) cursor[part] = {};
    else if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error(`${pointer}: ${part} is not an object`);
    cursor = cursor[part] as Record<string, JsonValue>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Builds an object from `rules` over `data`. A `copy` whose source is absent writes its `default` when it has one and
 * nothing otherwise; `compute` writes nothing when its expression has no value. An expression that cannot be
 * evaluated throws (the evaluator fails closed on a wrong type rather than coercing).
 */
export function applyRules(rules: readonly RecipeRule[], data: unknown): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const rule of rules) {
    switch (rule.op) {
      case "copy": {
        const value = readPointer(data, rule.from) as JsonValue | undefined;
        if (value !== undefined) setPointer(out, rule.to, value);
        else if (rule.default !== undefined) setPointer(out, rule.to, rule.default);
        break;
      }
      case "const":
        setPointer(out, rule.to, rule.value);
        break;
      case "compute": {
        const value = evaluateExpression(rule.expr, data as JsonValue);
        if (value !== undefined) setPointer(out, rule.to, value as JsonValue);
        break;
      }
      default:
        throw new Error(`rule ${(rule as { op: string }).op} is not supported`);
    }
  }
  return out;
}
