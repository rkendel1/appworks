/**
 * Recipe expressions: a closed, typed, side-effect-free expression form for decisions and computed values.
 *
 * An expression is JSON, not code: a literal (`{ "value": 10000 }`), a recipe data reference
 * (`{ "ref": "/input/amount" }`), or an operator over expressions (`{ "op": "gt", "args": [ … ] }`). There are no
 * functions, loops, variables, regular expressions, clocks or randomness, so the same expression over the same data
 * always gives the same result, and a rule can be read, type-checked and tested without running anything else.
 *
 * Missing data is explicit: a reference to a value that may be absent must be tested with `exists` or given a fallback
 * with `coalesce` before it is compared or combined. `and(exists(x), …)` and `if(exists(x), …, …)` make `x` present for
 * the operands they guard.
 */
import { SEMANTIC_KEYWORDS, readPointer, type JSONSchema, type JsonValue } from "@appport/protocol";

/** The primitive JSON types a schema admits (`integer` reported as `number`, as AppPort's mapping lint does); empty when it does not say. */
export function schemaTypes(schema: JSONSchema | undefined): string[] {
  const type = schema?.type;
  if (!type) return [];
  return (Array.isArray(type) ? type : [type]).map((t) => (t === "integer" ? "number" : t));
}

export const EXPRESSION_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "and", "or", "not", "exists", "coalesce", "if", "in"] as const;
export type ExpressionOp = (typeof EXPRESSION_OPS)[number];

export type ExpressionScalar = string | number | boolean | null;
export type Expression =
  | { value: ExpressionScalar | ExpressionScalar[] }
  | { ref: string }
  | { op: ExpressionOp; args: Expression[] };

/** Bound on nesting, so validation and evaluation are bounded for any input. */
export const MAX_EXPRESSION_DEPTH = 32;

/** The static type of an expression. `types` empty means the schema does not say. */
export interface ExpressionType {
  types: readonly string[];
  /** The value may be absent. */
  optional: boolean;
  /** The `x-appport-unit` of the value, when it carries one. */
  unit?: string;
}

/** What a reference resolves to for type checking, or why it does not resolve. */
export type ReferenceResolution = { schema: JSONSchema; required: boolean } | { error: string; code: "REFERENCE_INVALID" | "REFERENCE_UNAVAILABLE" };

export interface ExpressionIssue {
  code: "EXPRESSION_INVALID" | "EXPRESSION_TYPE" | "EXPRESSION_OPTIONAL" | "REFERENCE_INVALID" | "REFERENCE_UNAVAILABLE";
  /** JSON Pointer relative to the expression. */
  path: string;
  message: string;
}

const BOOLEAN: ExpressionType = { types: ["boolean"], optional: false };
const SCALARS = ["string", "number", "boolean", "null"];
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const typeOfValue = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const overlap = (a: readonly string[], b: readonly string[]) => !a.length || !b.length || a.some((t) => b.includes(t));

/**
 * Type-checks an expression. Returns its type, or undefined when it is malformed; every problem is reported.
 * `resolve` gives the schema of a recipe data pointer and whether it is always present there.
 */
export function checkExpression(expression: unknown, resolve: (pointer: string) => ReferenceResolution): { type?: ExpressionType; issues: ExpressionIssue[] } {
  const issues: ExpressionIssue[] = [];
  const report = (code: ExpressionIssue["code"], path: string, message: string) => issues.push({ code, path, message });

  /** A value the operator consumes: it must be present, and of one of `allowed` types when given. */
  const need = (t: ExpressionType | undefined, path: string, allowed?: readonly string[]): ExpressionType | undefined => {
    if (!t) return undefined;
    if (t.optional) report("EXPRESSION_OPTIONAL", path, "the value may be absent here; test it with exists or give it a fallback with coalesce");
    if (allowed && !overlap(t.types, allowed)) report("EXPRESSION_TYPE", path, `expected ${allowed.join(" or ")}, got ${t.types.join(" or ")}`);
    return t;
  };

  const check = (e: unknown, path: string, depth: number, present: ReadonlySet<string>, allowList = false): ExpressionType | undefined => {
    if (depth > MAX_EXPRESSION_DEPTH) return void report("EXPRESSION_INVALID", path, `expressions nest at most ${MAX_EXPRESSION_DEPTH} deep`);
    if (!isPlain(e)) return void report("EXPRESSION_INVALID", path, "an expression is an object with value, ref, or op and args");
    const keys = Object.keys(e).sort().join(",");
    if (keys === "value") {
      const v = e["value"];
      if (Array.isArray(v)) {
        if (!allowList) return void report("EXPRESSION_INVALID", `${path}/value`, "a list literal is allowed only as the second operand of in");
        if (!v.every((x) => SCALARS.includes(typeOfValue(x)))) return void report("EXPRESSION_INVALID", `${path}/value`, "a list literal holds scalars only");
        return { types: [...new Set(v.map(typeOfValue))], optional: false };
      }
      if (!SCALARS.includes(typeOfValue(v))) return void report("EXPRESSION_INVALID", `${path}/value`, "a literal is a string, number, boolean or null");
      return { types: [typeOfValue(v)], optional: false };
    }
    if (keys === "ref") {
      const pointer = e["ref"];
      if (typeof pointer !== "string") return void report("EXPRESSION_INVALID", `${path}/ref`, "a reference is a JSON Pointer into recipe data");
      const resolved = resolve(pointer);
      if ("error" in resolved) return void report(resolved.code, `${path}/ref`, resolved.error);
      const unit = (resolved.schema as Record<string, unknown>)[SEMANTIC_KEYWORDS.unit];
      return { types: schemaTypes(resolved.schema), optional: !resolved.required && !present.has(pointer), ...(typeof unit === "string" ? { unit } : {}) };
    }
    if (keys !== "args,op") return void report("EXPRESSION_INVALID", path, "an expression is an object with value, ref, or op and args");
    const op = e["op"] as ExpressionOp;
    const args = e["args"];
    if (!(EXPRESSION_OPS as readonly string[]).includes(op as string)) return void report("EXPRESSION_INVALID", `${path}/op`, `unknown operator ${JSON.stringify(op)}; operators are ${EXPRESSION_OPS.join(", ")}`);
    if (!Array.isArray(args)) return void report("EXPRESSION_INVALID", `${path}/args`, "args must be an array");
    const arity: Record<ExpressionOp, [number, number]> = {
      eq: [2, 2], ne: [2, 2], lt: [2, 2], le: [2, 2], gt: [2, 2], ge: [2, 2], and: [2, 16], or: [2, 16], not: [1, 1], exists: [1, 1], coalesce: [2, 16], if: [3, 3], in: [2, 2]
    };
    const [min, max] = arity[op];
    if (args.length < min || args.length > max) return void report("EXPRESSION_INVALID", `${path}/args`, `${op} takes ${min === max ? min : `${min} to ${max}`} operands`);
    const at = (i: number) => `${path}/args/${i}`;
    const sub = (i: number, guard = present, list = false) => check(args[i], at(i), depth + 1, guard, list);

    switch (op) {
      case "eq":
      case "ne": {
        const [a, b] = [need(sub(0), at(0), SCALARS), need(sub(1), at(1), SCALARS)];
        if (a && b && !overlap(a.types, b.types)) report("EXPRESSION_TYPE", path, `${op} compares ${a.types.join("|")} with ${b.types.join("|")}`);
        if (a?.unit && b?.unit && a.unit !== b.unit) report("EXPRESSION_TYPE", path, `${op} compares values in different units (${a.unit}, ${b.unit})`);
        return BOOLEAN;
      }
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const [a, b] = [need(sub(0), at(0), ["number"]), need(sub(1), at(1), ["number"])];
        if (a?.unit && b?.unit && a.unit !== b.unit) report("EXPRESSION_TYPE", path, `${op} compares values in different units (${a.unit}, ${b.unit})`);
        return BOOLEAN;
      }
      case "and":
      case "or": {
        const guarded = new Set(present);
        args.forEach((_, i) => {
          need(sub(i, op === "and" ? guarded : present), at(i), ["boolean"]);
          const guard = existsTarget(args[i]);
          if (op === "and" && guard) guarded.add(guard);
        });
        return BOOLEAN;
      }
      case "not":
        need(sub(0), at(0), ["boolean"]);
        return BOOLEAN;
      case "exists": {
        if (!isPlain(args[0]) || Object.keys(args[0]).join() !== "ref") report("EXPRESSION_INVALID", at(0), "exists takes a reference");
        else sub(0);
        return BOOLEAN;
      }
      case "coalesce": {
        const types = args.map((_, i) => sub(i));
        const last = types[types.length - 1];
        if (last?.optional) report("EXPRESSION_OPTIONAL", at(args.length - 1), "the last operand of coalesce must always be present");
        const known = types.filter((t): t is ExpressionType => t !== undefined);
        for (let i = 1; i < known.length; i++) if (!overlap(known[0]!.types, known[i]!.types)) report("EXPRESSION_TYPE", path, "coalesce operands have different types");
        const units = new Set(known.map((t) => t.unit).filter(Boolean));
        if (units.size > 1) report("EXPRESSION_TYPE", path, "coalesce operands are in different units");
        return { types: [...new Set(known.flatMap((t) => t.types))], optional: last?.optional ?? false, ...(units.size === 1 ? { unit: [...units][0] } : {}) };
      }
      case "if": {
        need(sub(0), at(0), ["boolean"]);
        const guard = existsTarget(args[0]);
        const then = sub(1, guard ? new Set([...present, guard]) : present);
        const otherwise = sub(2);
        if (then && otherwise && !overlap(then.types, otherwise.types)) report("EXPRESSION_TYPE", path, "the branches of if have different types");
        if (then?.unit !== otherwise?.unit && then?.unit && otherwise?.unit) report("EXPRESSION_TYPE", path, "the branches of if are in different units");
        if (!then || !otherwise) return undefined;
        return { types: [...new Set([...then.types, ...otherwise.types])], optional: then.optional || otherwise.optional, ...(then.unit ? { unit: then.unit } : {}) };
      }
      case "in": {
        const a = need(sub(0), at(0), SCALARS);
        if (!isPlain(args[1]) || Object.keys(args[1]).join() !== "value" || !Array.isArray(args[1]["value"])) {
          report("EXPRESSION_INVALID", at(1), "the second operand of in is a list literal");
          return BOOLEAN;
        }
        const list = sub(1, present, true);
        if (a && list && !overlap(a.types, list.types)) report("EXPRESSION_TYPE", path, `in tests ${a.types.join("|")} against a list of ${list.types.join("|")}`);
        return BOOLEAN;
      }
    }
  };

  const type = check(expression, "", 0, new Set());
  return { ...(type ? { type } : {}), issues };
}

/** The pointer an `exists` test establishes, if the expression is one. */
function existsTarget(e: unknown): string | undefined {
  if (!isPlain(e) || e["op"] !== "exists" || !Array.isArray(e["args"])) return undefined;
  const ref = e["args"][0];
  return isPlain(ref) && typeof ref["ref"] === "string" ? ref["ref"] : undefined;
}

export class RecipeExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeExpressionError";
  }
}

/**
 * Evaluates a type-checked expression over recipe data (`{ input, steps: { <id>: { output } } }`). Pure and
 * deterministic. Fails closed: an operand of the wrong type, which a checked expression cannot produce from valid data,
 * throws rather than coercing. A missing value is `undefined`, distinct from `null`.
 */
export function evaluateExpression(expression: Expression, data: JsonValue): ExpressionScalar | undefined {
  const evaluate = (e: Expression): ExpressionScalar | ExpressionScalar[] | undefined => {
    if ("value" in e) return e.value;
    if ("ref" in e) {
      const value = readPointer(data, e.ref);
      if (value !== undefined && value !== null && typeof value === "object") throw new RecipeExpressionError(`${e.ref} is not a scalar`);
      return value as ExpressionScalar | undefined;
    }
    const args = e.args;
    const scalar = (x: unknown): ExpressionScalar => {
      if (x === undefined) throw new RecipeExpressionError(`${e.op}: an operand is absent`);
      if (Array.isArray(x)) throw new RecipeExpressionError(`${e.op}: a list is not a scalar`);
      return x as ExpressionScalar;
    };
    const number = (x: unknown): number => {
      if (typeof x !== "number") throw new RecipeExpressionError(`${e.op}: expected a number`);
      return x;
    };
    const boolean = (x: unknown): boolean => {
      if (typeof x !== "boolean") throw new RecipeExpressionError(`${e.op}: expected a boolean`);
      return x;
    };
    switch (e.op) {
      case "eq":
        return scalar(evaluate(args[0]!)) === scalar(evaluate(args[1]!));
      case "ne":
        return scalar(evaluate(args[0]!)) !== scalar(evaluate(args[1]!));
      case "lt":
        return number(evaluate(args[0]!)) < number(evaluate(args[1]!));
      case "le":
        return number(evaluate(args[0]!)) <= number(evaluate(args[1]!));
      case "gt":
        return number(evaluate(args[0]!)) > number(evaluate(args[1]!));
      case "ge":
        return number(evaluate(args[0]!)) >= number(evaluate(args[1]!));
      case "and":
        return args.every((a) => boolean(evaluate(a)));
      case "or":
        return args.some((a) => boolean(evaluate(a)));
      case "not":
        return !boolean(evaluate(args[0]!));
      case "exists":
        return evaluate(args[0]!) !== undefined;
      case "coalesce":
        for (const a of args) {
          const value = evaluate(a);
          if (value !== undefined) return value;
        }
        return undefined;
      case "if":
        return boolean(evaluate(args[0]!)) ? evaluate(args[1]!) : evaluate(args[2]!);
      case "in": {
        const needle = scalar(evaluate(args[0]!));
        const list = evaluate(args[1]!);
        if (!Array.isArray(list)) throw new RecipeExpressionError("in: expected a list");
        return list.includes(needle);
      }
      default:
        throw new RecipeExpressionError(`unknown operator ${JSON.stringify((e as { op: unknown }).op)}`);
    }
  };
  const result = evaluate(expression);
  if (Array.isArray(result)) throw new RecipeExpressionError("an expression evaluates to a scalar");
  return result;
}
