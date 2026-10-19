/**
 * Recipe validation: deterministic, side-effect-free checks of `appport.recipe/1` source (spec/recipe-1.md §4).
 *
 * Findings carry a stable `code`, a `severity`, a JSON Pointer `path` into the source, and a `scope`:
 * - `source`: a defect of the recipe itself, true in every environment;
 * - `environment`: a fact about the contracts and providers of one environment (a contract that is unavailable, a
 *   schema the contract no longer accepts, no eligible provider). Supplied by the caller; nothing is fetched.
 *
 * Validation reads only what it is given. It makes no network call, invokes nothing, selects no provider and grants no
 * authority. It uses AppPort's published checks directly: dependency declarations, including canonical targets, through
 * `lintIntegration`; mapping rules through `lintRule` and `requiredTargetsNotProduced` (`@appport/integration`); interface
 * compatibility through `compareSchemas`; semantic annotations through `validateSemanticAnnotations`.
 */
import {
  INTEGRATION_EXTENSION,
  compareSchemas,
  findCapabilityVersion,
  getIntegration,
  isCanonicalContract,
  isCanonicalDependencyTarget,
  isPointer,
  isRequiredAt,
  isValidApplicationId,
  lintIntegration,
  parseDependencyRef,
  parsePointer,
  satisfiesVersionConstraint,
  schemaAt,
  validateSemanticAnnotations,
  type AppPortManifest,
  type CapabilityVersionEntry,
  type Dependency,
  type JSONSchema,
  type JsonValue
} from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { lintRule, requiredTargetsNotProduced, type RuleEndpoint } from "@appport/integration";
import { checkExpression, schemaTypes, type ExpressionIssue, type ReferenceResolution } from "./expression.js";
import {
  END_OUTCOMES,
  RECIPE_FORMAT,
  STEP_ID,
  STEP_KINDS,
  recipeEdges,
  stepOutputSchema,
  type CapabilityStep,
  type RecipeRule,
  type RecipeSource,
  type RecipeStep
} from "./source.js";

export type RecipeFindingCode =
  | "RECIPE_FORMAT"
  | "RECIPE_STRUCTURE"
  | "RECIPE_ID_INVALID"
  | "SCHEMA_INVALID"
  | "STEP_DUPLICATE_ID"
  | "STEP_UNKNOWN_KIND"
  | "TARGET_MISSING"
  | "CYCLE"
  | "STEP_UNREACHABLE"
  | "PATH_UNHANDLED"
  | "UNCERTAIN_UNHANDLED"
  | "REFERENCE_INVALID"
  | "REFERENCE_UNAVAILABLE"
  | "EXPRESSION_INVALID"
  | "EXPRESSION_TYPE"
  | "EXPRESSION_OPTIONAL"
  | "MAPPING_INVALID"
  | "MAPPING_INCOMPLETE"
  | "SCHEMA_MISMATCH"
  | "DEPENDENCY_INVALID"
  | "VERSION_CONSTRAINT_INVALID"
  | "DEPENDENCY_NOT_CANONICAL"
  | "DEPENDENCY_UNDECLARED"
  | "DEPENDENCY_UNUSED"
  | "VERIFICATION_MISSING"
  | "APPROVAL_TASK_INVALID"
  | "OUTCOME_OUTPUT_MISSING"
  | "REINVOKED_AFTER_UNCERTAIN"
  | "ENV_CONTRACT_UNAVAILABLE"
  | "ENV_CAPABILITY_UNAVAILABLE"
  | "ENV_SCHEMA_INCOMPATIBLE"
  | "ENV_EFFECT_MISMATCH"
  | "ENV_VERIFICATION_WEAKENED"
  | "ENV_VERIFICATION_UNKNOWN"
  | "ENV_APPROVAL_REQUIRED"
  | "ENV_UNCERTAIN_UNHANDLED"
  | "ENV_PROBE_NOT_OBSERVATION"
  | "ENV_NO_ELIGIBLE_PROVIDER"
  | "ENV_AMBIGUOUS_PROVIDER";

export interface RecipeFinding {
  code: RecipeFindingCode;
  severity: "error" | "warning";
  scope: "source" | "environment";
  /** JSON Pointer into the recipe source. */
  path: string;
  message: string;
}

/**
 * What an environment knows, supplied by the caller. `contracts`: the active canonical contracts by id, as its contract
 * registry holds them. `providers`: per dependency id, how many providers discovery found eligible.
 */
export interface RecipeEnvironment {
  contracts?: Readonly<Record<string, AppPortManifest | undefined>>;
  providers?: Readonly<Record<string, { eligible: number } | undefined>>;
}

export interface RecipeValidation {
  /** No error of any scope. */
  ok: boolean;
  /** No source error: the recipe itself is well-formed, whatever the environment. */
  sourceOk: boolean;
  findings: RecipeFinding[];
}

const TOP_LEVEL = ["format", "id", "name", "description", "objective", "inputs", "outputs", "outcome", "requires", "start", "steps", "provenance"];
const STEP_MEMBERS: Record<string, string[]> = {
  capability: ["id", "kind", "description", "uses", "effect", "expects", "input", "approval", "preconditions", "verify", "on"],
  decision: ["id", "kind", "description", "cases", "otherwise"],
  transform: ["id", "kind", "description", "output", "rules", "next"],
  task: ["id", "kind", "description", "purpose", "assignee", "approval", "present", "response", "cases", "otherwise", "unanswered"],
  end: ["id", "kind", "description", "outcome", "output"]
};
const RULE_OPS = ["copy", "const", "enum", "unit", "encoding", "compute"];
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** True when every object on the way to `pointer` declares the next member required. */
function requiredChain(schema: JSONSchema, pointer: string): boolean {
  const segments = parsePointer(pointer);
  for (let i = 1; i <= segments.length; i++) {
    if (!isRequiredAt(schema, "/" + segments.slice(0, i).map(esc).join("/"))) return false;
  }
  return true;
}

/**
 * Validates recipe source, and, when an environment is given, the recipe against it. Never throws on malformed input:
 * every problem is a finding.
 */
export function validateRecipe(source: unknown, environment?: RecipeEnvironment): RecipeValidation {
  const findings: RecipeFinding[] = [];
  const add = (code: RecipeFindingCode, path: string, message: string, severity: "error" | "warning" = "error", scope: "source" | "environment" = "source") =>
    findings.push({ code, severity, scope, path, message });
  const result = (): RecipeValidation => ({
    ok: !findings.some((f) => f.severity === "error"),
    sourceOk: !findings.some((f) => f.severity === "error" && f.scope === "source"),
    findings
  });

  // ------------------------------------------------------------------ format and structure
  if (!isPlain(source)) {
    add("RECIPE_STRUCTURE", "", "a recipe is a JSON object");
    return result();
  }
  if (source["format"] !== RECIPE_FORMAT) {
    const format = source["format"];
    add("RECIPE_FORMAT", "/format", typeof format === "string" && format.startsWith("appport.recipe/")
      ? `recipe format ${format} is not supported; this validator reads ${RECIPE_FORMAT}`
      : `format must be ${RECIPE_FORMAT}`);
    return result();
  }
  for (const key of Object.keys(source)) if (!TOP_LEVEL.includes(key)) add("RECIPE_STRUCTURE", `/${esc(key)}`, `unknown member "${key}"; undocumented members are rejected, never ignored`);
  for (const key of ["name", "objective", "start"]) if (typeof source[key] !== "string" || !(source[key] as string).length) add("RECIPE_STRUCTURE", `/${key}`, `${key} must be a non-empty string`);
  if (!isValidApplicationId(source["id"])) add("RECIPE_ID_INVALID", "/id", "id must be a reverse-domain identifier such as org.example.recipes.supplier-invoice");
  for (const key of ["inputs", "outputs"]) checkObjectSchema(source[key], `/${key}`);
  if (!isPlain(source["outcome"]) || typeof source["outcome"]["description"] !== "string" || !Array.isArray(source["outcome"]["verify"])) {
    add("RECIPE_STRUCTURE", "/outcome", "outcome needs a description and a verify list");
  }
  if (!Array.isArray(source["requires"])) add("RECIPE_STRUCTURE", "/requires", "requires must be an array of dependencies");
  if (!Array.isArray(source["steps"]) || source["steps"].length === 0) add("RECIPE_STRUCTURE", "/steps", "steps must be a non-empty array");
  if (findings.some((f) => f.severity === "error" && (f.code === "RECIPE_STRUCTURE" || f.code === "SCHEMA_INVALID") && ["/inputs", "/outputs", "/outcome", "/requires", "/steps", "/start"].includes(f.path))) {
    return result();
  }
  const recipe = source as unknown as RecipeSource;

  // ------------------------------------------------------------------ dependencies (reusing lintIntegration)
  const dependencies = new Map<string, { dependency: Dependency; index: number }>();
  checkDependencies(recipe.requires, recipe.id);
  recipe.requires.forEach((dependency, index) => {
    if (isPlain(dependency) && typeof dependency.id === "string" && !dependencies.has(dependency.id)) dependencies.set(dependency.id, { dependency, index });
  });
  const used = new Set<string>();
  const uses = (id: unknown, path: string) => {
    if (typeof id !== "string" || !dependencies.has(id)) return void add("DEPENDENCY_UNDECLARED", path, `${JSON.stringify(id)} is not a declared dependency`);
    used.add(id);
  };

  // ------------------------------------------------------------------ steps
  const steps = new Map<string, { step: RecipeStep; index: number }>();
  recipe.steps.forEach((step, index) => {
    const path = `/steps/${index}`;
    if (!isPlain(step)) return void add("RECIPE_STRUCTURE", path, "a step is an object");
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) add("RECIPE_STRUCTURE", `${path}/id`, "a step id is lowercase letters, digits and hyphens, starting with a letter");
    else if (steps.has(step.id)) add("STEP_DUPLICATE_ID", `${path}/id`, `step id "${step.id}" is already used by /steps/${steps.get(step.id)!.index}`);
    if (!(STEP_KINDS as readonly string[]).includes(step.kind as string)) return void add("STEP_UNKNOWN_KIND", `${path}/kind`, `unknown step kind ${JSON.stringify(step.kind)}; kinds are ${STEP_KINDS.join(", ")}`);
    for (const key of Object.keys(step)) if (!STEP_MEMBERS[step.kind]!.includes(key)) add("RECIPE_STRUCTURE", `${path}/${esc(key)}`, `unknown member "${key}" of a ${step.kind} step`);
    if (typeof step.id === "string" && STEP_ID.test(step.id) && !steps.has(step.id)) steps.set(step.id, { step, index });
  });
  const pathOf = (id: string) => `/steps/${steps.get(id)!.index}`;

  // ------------------------------------------------------------------ control flow
  if (typeof recipe.start === "string" && !steps.has(recipe.start)) add("TARGET_MISSING", "/start", `start names no step: "${recipe.start}"`);
  for (const [id, { step }] of steps) {
    const path = pathOf(id);
    const required: Record<string, string[]> = {
      capability: ["on.success", "on.failure"],
      decision: ["otherwise"],
      transform: ["next"],
      task: ["otherwise", "unanswered"],
      end: []
    };
    for (const label of required[step.kind]!) {
      const edge = recipeEdges(step).find((e) => e.label === label);
      if (!edge || edge.target === undefined) add("PATH_UNHANDLED", `${path}/${label.replace(".", "/")}`, `the ${step.kind} step "${id}" does not say where ${label} leads`);
    }
    if (step.kind === "capability" && step.effect === "consequential" && step.on?.uncertain === undefined) {
      add("UNCERTAIN_UNHANDLED", `${path}/on`, `"${id}" is consequential: an outcome where the effect may have happened must be routed (on.uncertain)`);
    }
    for (const edge of recipeEdges(step)) {
      if (edge.target === undefined) continue;
      if (typeof edge.target !== "string" || !steps.has(edge.target)) add("TARGET_MISSING", `${path}/${edge.label.replace(".", "/")}`, `${edge.label} names no step: ${JSON.stringify(edge.target)}`);
    }
  }
  const successors = (id: string) => recipeEdges(steps.get(id)!.step).filter((e) => typeof e.target === "string" && steps.has(e.target));

  // Cycles: none are supported in recipe/1.
  const state = new Map<string, "visiting" | "done">();
  let cyclic = false;
  const visit = (id: string, trail: string[]) => {
    state.set(id, "visiting");
    for (const { target } of successors(id)) {
      if (state.get(target) === "visiting") {
        cyclic = true;
        add("CYCLE", pathOf(target), `control flow cycles (${[...trail.slice(trail.indexOf(target)), target].join(" → ")}); recipe/1 has no loops or implicit retries`);
      } else if (!state.has(target)) visit(target, [...trail, target]);
    }
    state.set(id, "done");
  };
  for (const id of steps.keys()) if (!state.has(id)) visit(id, [id]);

  const reachable = new Set<string>();
  const walk = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const { target } of successors(id)) walk(target);
  };
  if (steps.has(recipe.start)) walk(recipe.start);
  for (const id of steps.keys()) if (!reachable.has(id) && steps.has(recipe.start)) add("STEP_UNREACHABLE", pathOf(id), `step "${id}" cannot be reached from the start`, "warning");

  // Which step outputs are available, on every path, when a step begins.
  const available = new Map<string, Set<string>>();
  if (!cyclic && steps.has(recipe.start)) {
    const incoming = new Map<string, Array<{ from: string; produces: boolean }>>();
    for (const id of reachable) for (const e of successors(id)) incoming.set(e.target, [...(incoming.get(e.target) ?? []), { from: id, produces: e.produces }]);
    const order: string[] = [];
    const seen = new Set<string>();
    const post = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const e of successors(id)) post(e.target);
      order.unshift(id);
    };
    post(recipe.start);
    for (const id of order) {
      if (id === recipe.start) {
        available.set(id, new Set());
        continue;
      }
      let set: Set<string> | undefined;
      for (const edge of incoming.get(id) ?? []) {
        const along = new Set([...(available.get(edge.from) ?? []), ...(edge.produces ? [edge.from] : [])]);
        set = set ? new Set([...set].filter((x) => along.has(x))) : along;
      }
      available.set(id, set ?? new Set());
    }
  }

  /** Resolves a recipe data pointer for a step that has `avail` outputs available. */
  const resolver = (avail: ReadonlySet<string> | undefined) => (pointer: string): ReferenceResolution => {
    if (!isPointer(pointer)) return { code: "REFERENCE_INVALID", error: `${JSON.stringify(pointer)} is not a JSON Pointer` };
    const segments = parsePointer(pointer);
    let schema: JSONSchema | undefined;
    let inner: string[];
    if (segments[0] === "input") {
      schema = recipe.inputs;
      inner = segments.slice(1);
    } else if (segments[0] === "steps" && segments.length >= 3 && segments[2] === "output") {
      const target = steps.get(segments[1]!);
      if (!target) return { code: "REFERENCE_INVALID", error: `${pointer} names no step` };
      schema = stepOutputSchema(target.step);
      if (!schema) return { code: "REFERENCE_INVALID", error: `${pointer}: a ${target.step.kind} step has no output` };
      if (avail && !avail.has(segments[1]!)) return { code: "REFERENCE_UNAVAILABLE", error: `${pointer}: step "${segments[1]}" has not completed with an output on every path to here` };
      inner = segments.slice(3);
    } else {
      return { code: "REFERENCE_INVALID", error: `${pointer} is not recipe data; references start with /input or /steps/<id>/output` };
    }
    const at = "/" + inner.map(esc).join("/");
    const node = inner.length ? schemaAt(schema, at) : schema;
    if (!node) return { code: "REFERENCE_INVALID", error: `${pointer} is not declared by the schema it refers to` };
    return { schema: node, required: inner.length ? requiredChain(schema, at) : true };
  };

  const expression = (expr: unknown, path: string, avail: ReadonlySet<string> | undefined, expect?: "boolean") => {
    const checked = checkExpression(expr, resolver(avail));
    for (const issue of checked.issues) add(issue.code as ExpressionIssue["code"], `${path}${issue.path}`, issue.message);
    if (expect && checked.type && !checked.issues.length) {
      if (checked.type.optional) add("EXPRESSION_OPTIONAL", path, "the condition may be absent; test it with exists or give it a fallback with coalesce");
      if (checked.type.types.length && !checked.type.types.includes("boolean")) add("EXPRESSION_TYPE", path, `a condition must be boolean, not ${checked.type.types.join("|")}`);
    }
    return checked;
  };

  /** Checks rules writing into `target`, and that they produce every required field of it. */
  const rules = (list: unknown, path: string, target: JSONSchema, avail: ReadonlySet<string> | undefined) => {
    if (!Array.isArray(list)) return void add("RECIPE_STRUCTURE", path, "rules must be an array");
    const written = new Set<string>();
    const targetEndpoint: RuleEndpoint = (pointer) => {
      const node = pointer === "" ? target : schemaAt(target, pointer);
      return node ? { schema: node, required: pointer === "" || requiredChain(target, pointer) } : undefined;
    };
    list.forEach((rule: unknown, index) => {
      const at = `${path}/${index}`;
      if (!isPlain(rule) || !RULE_OPS.includes(rule["op"] as string)) return void add("MAPPING_INVALID", at, `a rule's op is one of ${RULE_OPS.join(", ")}`);
      if (!isPointer(rule["to"]) || rule["to"] === "") return void add("MAPPING_INVALID", `${at}/to`, "to must be a JSON Pointer to a field");
      const to = rule["to"] as string;
      for (const other of written) {
        if (other === to || to.startsWith(`${other}/`) || other.startsWith(`${to}/`)) add("MAPPING_INVALID", `${at}/to`, `${to} overlaps ${other}, written by an earlier rule`);
      }
      written.add(to);
      const missing = ({ enum: ["from", "table", "relation", "unmapped"], unit: ["from", "fromUnit", "toUnit"], encoding: ["from", "fromEncoding", "toEncoding"], copy: ["from"], const: ["value"], compute: ["expr"] } as Record<string, string[]>)[rule["op"] as string]!
        .filter((key) => rule[key] === undefined);
      if (missing.length) return void add("MAPPING_INVALID", at, `a ${String(rule["op"])} rule needs ${missing.join(", ")}`);
      if (rule["op"] === "enum" && !isPlain(rule["table"])) return void add("MAPPING_INVALID", `${at}/table`, "table must be an object");

      if (rule["op"] === "compute") {
        const checked = expression(rule["expr"], `${at}/expr`, avail);
        const field = targetEndpoint(to);
        if (!field) return void add("SCHEMA_MISMATCH", `${at}/to`, `${to} is not declared by the target schema`);
        if (checked.type) {
          const want = schemaTypes(field.schema);
          if (want.length && checked.type.types.length && !checked.type.types.some((t) => want.includes(t))) {
            add("SCHEMA_MISMATCH", at, `the expression gives ${checked.type.types.join("|")}, ${to} accepts ${want.join("|")}`);
          }
          const unit = (field.schema as Record<string, unknown>)["x-appport-unit"];
          if (checked.type.unit !== undefined && checked.type.unit !== unit) {
            add("SCHEMA_MISMATCH", at, `the expression is in ${checked.type.unit}, ${to} declares ${unit === undefined ? "no unit" : String(unit)}`);
          }
          if (checked.type.optional && field.required) add("EXPRESSION_OPTIONAL", at, `${to} is required but the expression may be absent; give it a fallback with coalesce`);
        }
        return;
      }
      if (rule["op"] !== "const") {
        const from = resolver(avail)(rule["from"] as string);
        if ("error" in from) return void add(from.code, `${at}/from`, from.error);
      }
      const source: RuleEndpoint = (pointer) => {
        const resolved = resolver(avail)(pointer);
        return "error" in resolved ? undefined : resolved;
      };
      lintRule(
        rule as unknown as Parameters<typeof lintRule>[0],
        at,
        { source, target: targetEndpoint },
        { requireConcepts: false, lossFor: () => false },
        (where, message) => add("SCHEMA_MISMATCH", where.startsWith(at) ? where : at, message),
        (where, message) => add("SCHEMA_MISMATCH", where.startsWith(at) ? where : at, message, "warning")
      );
    });
    for (const pointer of requiredTargetsNotProduced(target, written)) add("MAPPING_INCOMPLETE", path, `required field ${pointer} is not produced by any rule`);
  };

  const probes = (list: unknown, path: string, refs: { input?: JSONSchema; output?: JSONSchema }, kind: "verify" | "precondition") => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      add("RECIPE_STRUCTURE", path, "must be an array");
      return [];
    }
    const ids = new Set<string>();
    const out: Array<{ uses: string; path: string }> = [];
    list.forEach((item: unknown, index) => {
      const at = `${path}/${index}`;
      if (!isPlain(item) || typeof item["id"] !== "string" || !isPlain(item["via"])) return void add("RECIPE_STRUCTURE", at, `a ${kind} method needs an id and a via probe`);
      if (ids.has(item["id"])) add("RECIPE_STRUCTURE", `${at}/id`, `duplicate id "${item["id"]}"`);
      ids.add(item["id"]);
      if (kind === "verify" && item["kind"] !== "state") add("RECIPE_STRUCTURE", `${at}/kind`, 'only "state" verification can establish an effect; kind must be "state"');
      if (kind === "precondition" && item["require"] !== "found" && item["require"] !== "not-found") add("RECIPE_STRUCTURE", `${at}/require`, 'require is "found" or "not-found"');
      const via = item["via"] as Record<string, unknown>;
      uses(via["uses"], `${at}/via/uses`);
      if (typeof via["uses"] === "string") out.push({ uses: via["uses"], path: `${at}/via/uses` });
      const valueRef = (value: unknown, where: string) => {
        if (!isPlain(value)) return;
        const keys = Object.keys(value);
        if (keys.length !== 1 || (keys[0] !== "$input" && keys[0] !== "$output")) return;
        const side = keys[0] === "$input" ? refs.input : refs.output;
        if (!side) return void add("REFERENCE_INVALID", where, `${keys[0]} has nothing to refer to here`);
        const pointer = value[keys[0]!];
        if (typeof pointer !== "string" || (pointer !== "" && !schemaAt(side, pointer))) add("REFERENCE_INVALID", where, `${String(pointer)} is not declared by the ${keys[0] === "$input" ? "input" : "output"} schema`);
      };
      if (!isPlain(via["input"])) add("RECIPE_STRUCTURE", `${at}/via/input`, "via.input must be an object");
      else for (const [key, value] of Object.entries(via["input"])) valueRef(value, `${at}/via/input/${esc(key)}`);
      const expect = item["expect"];
      if (kind === "verify" && (!Array.isArray(expect) || expect.length === 0)) add("RECIPE_STRUCTURE", `${at}/expect`, "a state verification needs at least one expectation");
      (Array.isArray(expect) ? expect : []).forEach((e: unknown, j) => {
        const where = `${at}/expect/${j}`;
        if (!isPlain(e) || !isPointer(e["at"]) || (e["equals"] === undefined) === (e["exists"] === undefined)) return void add("RECIPE_STRUCTURE", where, "an expectation has at and exactly one of equals / exists");
        valueRef(e["equals"], `${where}/equals`);
      });
    });
    return out;
  };

  // Per-step checks.
  const probeUses: Array<{ uses: string; path: string }> = [];
  const approvals: Array<{ step: CapabilityStep; path: string }> = [];
  for (const [id, { step }] of steps) {
    const path = pathOf(id);
    const avail = available.get(id);
    switch (step.kind) {
      case "capability": {
        uses(step.uses, `${path}/uses`);
        if (step.effect !== "observation" && step.effect !== "consequential") add("RECIPE_STRUCTURE", `${path}/effect`, 'effect is "observation" or "consequential"');
        if (!isPlain(step.expects) || !checkObjectSchema(step.expects.input, `${path}/expects/input`) || !checkObjectSchema(step.expects.output, `${path}/expects/output`)) {
          if (!isPlain(step.expects)) add("RECIPE_STRUCTURE", `${path}/expects`, "expects names the input and output schemas the recipe was written against");
          break;
        }
        if (!isPlain(step.on)) add("RECIPE_STRUCTURE", `${path}/on`, "on routes success, failure and uncertain outcomes");
        rules(step.input, `${path}/input`, step.expects.input, avail);
        if (step.approval !== undefined) approvals.push({ step, path: `${path}/approval/task` });
        probeUses.push(...probes(step.preconditions, `${path}/preconditions`, { input: step.expects.input }, "precondition"));
        if (step.verify !== undefined && !isPlain(step.verify)) add("RECIPE_STRUCTURE", `${path}/verify`, "verify is an object");
        const methods = step.verify?.methods;
        if (methods !== undefined && (!Array.isArray(methods) || !methods.every((m) => typeof m === "string") || new Set(methods).size !== methods.length)) {
          add("RECIPE_STRUCTURE", `${path}/verify/methods`, "methods is a list of distinct verification method ids");
        }
        probeUses.push(...probes(step.verify?.additional, `${path}/verify/additional`, { input: step.expects.input, output: step.expects.output }, "verify"));
        if (step.effect === "consequential" && !(methods?.length || step.verify?.additional?.length)) {
          add("VERIFICATION_MISSING", `${path}/verify`, `"${id}" is consequential and declares no verification of its effect: name the contract's methods or add a state verification`);
        }
        break;
      }
      case "decision":
        if (!Array.isArray(step.cases) || step.cases.length === 0) add("RECIPE_STRUCTURE", `${path}/cases`, "a decision needs at least one case");
        (Array.isArray(step.cases) ? step.cases : []).forEach((c, i) => {
          if (!isPlain(c)) return void add("RECIPE_STRUCTURE", `${path}/cases/${i}`, "a case has when and next");
          expression(c.when, `${path}/cases/${i}/when`, avail, "boolean");
        });
        break;
      case "transform":
        if (checkObjectSchema(step.output, `${path}/output`)) rules(step.rules, `${path}/rules`, step.output, avail);
        break;
      case "task": {
        if (typeof step.purpose !== "string" || !step.purpose) add("RECIPE_STRUCTURE", `${path}/purpose`, "a task states its purpose");
        if (!isPlain(step.assignee) || typeof step.assignee.role !== "string" || !/^\S+$/.test(step.assignee.role)) add("RECIPE_STRUCTURE", `${path}/assignee`, "assignee.role is a semantic role identifier, e.g. role:ap-manager");
        if (step.approval !== undefined && typeof step.approval !== "boolean") add("RECIPE_STRUCTURE", `${path}/approval`, "approval is true or false");
        if (!Array.isArray(step.present)) add("RECIPE_STRUCTURE", `${path}/present`, "present lists what the person is shown");
        (Array.isArray(step.present) ? step.present : []).forEach((item, i) => {
          if (!isPlain(item) || typeof item.label !== "string") return void add("RECIPE_STRUCTURE", `${path}/present/${i}`, "an item has a label and a value pointer");
          const resolved = resolver(avail)(item.value);
          if ("error" in resolved) add(resolved.code, `${path}/present/${i}/value`, resolved.error);
        });
        if (!checkObjectSchema(step.response, `${path}/response`)) break;
        const answered = new Set([...(avail ?? []), id]);
        if (!Array.isArray(step.cases)) add("RECIPE_STRUCTURE", `${path}/cases`, "cases route on the response");
        (Array.isArray(step.cases) ? step.cases : []).forEach((c, i) => {
          if (!isPlain(c)) return void add("RECIPE_STRUCTURE", `${path}/cases/${i}`, "a case has when and next");
          expression(c.when, `${path}/cases/${i}/when`, avail ? answered : undefined, "boolean");
        });
        break;
      }
      case "end":
        if (!(END_OUTCOMES as readonly string[]).includes(step.outcome)) add("RECIPE_STRUCTURE", `${path}/outcome`, `outcome is one of ${END_OUTCOMES.join(", ")}`);
        if (step.outcome === "completed") {
          if (step.output === undefined) add("OUTCOME_OUTPUT_MISSING", `${path}/output`, "a completed end must produce the recipe outputs");
          else rules(step.output, `${path}/output`, recipe.outputs, avail);
        } else if (step.output !== undefined) {
          add("RECIPE_STRUCTURE", `${path}/output`, `only a completed end produces outputs; "${step.outcome}" does not`);
        }
        break;
    }
  }

  // Approvals: the named task must ask for an approval, and have been answered on every path.
  for (const { step, path } of approvals) {
    const task = steps.get(step.approval!.task)?.step;
    if (!task || task.kind !== "task" || task.approval !== true) add("APPROVAL_TASK_INVALID", path, `${JSON.stringify(step.approval!.task)} is not a task step with approval: true`);
    else if (available.get(step.id) && !available.get(step.id)!.has(task.id)) add("APPROVAL_TASK_INVALID", path, `"${task.id}" is not answered on every path to "${step.id}"`);
  }

  // The final outcome.
  const ends = [...steps.values()].map((s) => s.step).filter((s) => s.kind === "end");
  if (!ends.some((s) => s.kind === "end" && s.outcome === "completed")) add("OUTCOME_OUTPUT_MISSING", "/steps", "no end step completes the recipe");
  probeUses.push(...probes(recipe.outcome.verify, "/outcome/verify", { input: recipe.inputs, output: recipe.outputs }, "verify"));
  const consequential = [...steps.values()].some(({ step }) => step.kind === "capability" && step.effect === "consequential");
  if (consequential && recipe.outcome.verify.length === 0) add("VERIFICATION_MISSING", "/outcome/verify", "the recipe has consequential steps but declares no verification of its final outcome");

  for (const [id, { index }] of dependencies) if (!used.has(id)) add("DEPENDENCY_UNUSED", `/requires/${index}`, `dependency "${id}" is declared but not used`, "warning");

  // Re-invoking a consequential capability after its outcome was uncertain is a retry the source makes visible.
  if (!cyclic) {
    for (const [id, { step }] of steps) {
      if (step.kind !== "capability" || step.effect !== "consequential" || typeof step.on?.uncertain !== "string" || !steps.has(step.on.uncertain)) continue;
      const seen = new Set<string>();
      const stack = [step.on.uncertain];
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        const later = steps.get(next)!.step;
        if (later.kind === "capability" && later.effect === "consequential" && later.uses === step.uses) {
          add("REINVOKED_AFTER_UNCERTAIN", pathOf(next), `"${next}" invokes ${step.uses} again after "${id}" ended uncertain; the first effect may already have happened`, "warning");
        }
        stack.push(...successors(next).map((e) => e.target));
      }
    }
  }

  if (environment) checkEnvironment();
  return result();

  // ------------------------------------------------------------------ helpers
  function checkObjectSchema(schema: unknown, path: string): schema is JSONSchema {
    if (!isPlain(schema) || (schema["type"] !== undefined && schema["type"] !== "object")) {
      add("SCHEMA_INVALID", path, "must be an object schema");
      return false;
    }
    for (const issue of validateSemanticAnnotations(schema as JSONSchema)) add("SCHEMA_INVALID", `${path}${issue.path}`, issue.message);
    return true;
  }

  function checkDependencies(requires: unknown[], recipeId: string) {
    const id = isValidApplicationId(recipeId) ? recipeId : "org.invalid.recipe";
    const manifest = {
      protocol: "appport/1",
      application: { id, name: id, version: "0.0.0" },
      capabilities: [],
      events: [],
      transports: [],
      extensions: [INTEGRATION_EXTENSION],
      attributes: { [INTEGRATION_EXTENSION]: { capabilities: {}, requires } as unknown as JsonValue }
    } as unknown as AppPortManifest;
    for (const issue of lintIntegration(manifest)) {
      const match = /^descriptor\.requires\[(\d+)\](.*)$/.exec(issue.path);
      if (!match || issue.level !== "error") continue;
      const tail = match[2]!.replace(/\./g, "/");
      add(tail.endsWith("versionConstraint") ? "VERSION_CONSTRAINT_INVALID" : "DEPENDENCY_INVALID", `/requires/${match[1]}${tail}`, issue.message);
    }
    requires.forEach((dependency, index) => {
      const path = `/requires/${index}`;
      if (!isPlain(dependency) || !isPlain(dependency["target"])) return;
      const target = dependency["target"] as Dependency["target"];
      if (!isCanonicalDependencyTarget(target)) {
        return void add("DEPENDENCY_NOT_CANONICAL", `${path}/target`, "a recipe depends on canonical capabilities ({ contract, capability }), never on an application's own capability");
      }
      if (dependency["relationship"] !== "invokes" && dependency["relationship"] !== "observes") add("DEPENDENCY_INVALID", `${path}/relationship`, 'a recipe dependency is "invokes" or "observes"');
      if (dependency["required"] !== true) add("DEPENDENCY_INVALID", `${path}/required`, "optional dependencies are not supported by recipe/1");
    });
  }

  function checkEnvironment() {
    const contracts = environment!.contracts ?? {};
    const selected = new Map<string, { contract: AppPortManifest; name: string; definition: CapabilityVersionEntry }>();
    for (const [id, { dependency, index }] of dependencies) {
      const path = `/requires/${index}`;
      const target = dependency.target;
      if (!isCanonicalDependencyTarget(target)) continue;
      const contract = contracts[target.contract];
      if (!contract || !isCanonicalContract(contract)) {
        add("ENV_CONTRACT_UNAVAILABLE", `${path}/target/contract`, `canonical contract ${target.contract} is not available in this environment`, "error", "environment");
        continue;
      }
      const ref = parseDependencyRef(target.capability);
      if (!ref) continue;
      const versions = (contract.capabilities.find((c) => c.name === ref.name)?.definitions ?? [])
        .map((d) => d.version)
        .filter((v) => (ref.version !== undefined ? v === ref.version : satisfiesVersionConstraint(v, dependency.versionConstraint ?? "")));
      if (!versions.length) {
        add("ENV_CAPABILITY_UNAVAILABLE", `${path}/target/capability`, `${target.contract} defines no version of ${ref.name} satisfying ${ref.version ?? dependency.versionConstraint}`, "error", "environment");
        continue;
      }
      const version = Math.max(...versions);
      selected.set(id, { contract, name: ref.name, definition: findCapabilityVersion(contract, ref.name, version)! });
      const providers = environment!.providers?.[id];
      if (providers && providers.eligible === 0) add("ENV_NO_ELIGIBLE_PROVIDER", path, `no provider holds a valid fulfillment claim for ${target.contract} ${ref.name}@${version}`, "error", "environment");
      if (providers && providers.eligible > 1) add("ENV_AMBIGUOUS_PROVIDER", path, `${providers.eligible} providers are eligible for ${ref.name}@${version}; the deployment must select one explicitly`, "warning", "environment");
    }

    for (const [id, { step }] of steps) {
      if (step.kind !== "capability" || !isPlain(step.expects)) continue;
      const path = pathOf(id);
      const chosen = selected.get(step.uses);
      if (!chosen) continue;
      const { contract, name, definition } = chosen;
      const key = `${name}@${definition.version}`;
      if (definition.effect !== undefined && definition.effect !== step.effect) {
        add("ENV_EFFECT_MISMATCH", `${path}/effect`, `the recipe treats ${key} as ${step.effect}; the contract declares it ${definition.effect}`, "error", "environment");
      }
      for (const [side, mine, theirs] of [["input", step.expects.input, definition.inputSchema], ["output", step.expects.output, definition.outputSchema]] as const) {
        for (const change of compareSchemas(mine, theirs as JSONSchema, `${key} ${side}`, side).filter((c) => c.severity === "breaking")) {
          add("ENV_SCHEMA_INCOMPATIBLE", `${path}/expects/${side}`, change.message, "error", "environment");
        }
      }
      const integration = getIntegration(contract)?.capabilities[key];
      const stateMethods = (integration?.verify ?? []).filter((m) => m.kind === "state").map((m) => m.id);
      const declared = new Set((integration?.verify ?? []).map((m) => m.id));
      const listed = step.verify?.methods ?? [];
      for (const method of stateMethods) if (!listed.includes(method)) add("ENV_VERIFICATION_WEAKENED", `${path}/verify/methods`, `the contract verifies ${key} with "${method}"; the recipe must not drop it`, "error", "environment");
      for (const method of listed) if (!declared.has(method)) add("ENV_VERIFICATION_UNKNOWN", `${path}/verify/methods`, `${key} declares no verification method "${method}"`, "error", "environment");
      if (integration?.approval?.required) {
        const task = step.approval ? steps.get(step.approval.task)?.step : undefined;
        if (!task || task.kind !== "task") add("ENV_APPROVAL_REQUIRED", `${path}/approval`, `${key} requires approval${integration.approval.approver ? ` by ${integration.approval.approver}` : ""}; the recipe must obtain it in a task before invoking`, "error", "environment");
        else if (integration.approval.approver && task.assignee?.role !== integration.approval.approver) {
          add("ENV_APPROVAL_REQUIRED", `${path}/approval`, `${key} requires approval by ${integration.approval.approver}; task "${task.id}" is assigned to ${task.assignee?.role}`, "error", "environment");
        }
      }
      if (step.on?.uncertain === undefined && (integration?.failures ?? []).some((f) => f.effect !== "none")) {
        add("ENV_UNCERTAIN_UNHANDLED", `${path}/on`, `${key} declares failures whose effect may have happened; route on.uncertain`, "error", "environment");
      }
    }
    for (const probe of probeUses) {
      const chosen = selected.get(probe.uses);
      if (chosen && chosen.definition.effect !== "observation") {
        add("ENV_PROBE_NOT_OBSERVATION", probe.path, `${chosen.name}@${chosen.definition.version} is not an observation capability, so it cannot be used as a probe`, "error", "environment");
      }
    }
  }
}

/** Validates a recipe input against the recipe's input contract, before anything runs. */
export function validateRecipeInput(recipe: RecipeSource, input: unknown): { ok: true } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const checked = fromJSONSchema(recipe.inputs).validate(input);
  if (checked.ok) return { ok: true };
  return { ok: false, issues: checked.issues.map((issue) => ({ path: "/" + issue.path.map((p) => esc(String(p))).join("/"), message: issue.message })) };
}

/** Every canonical dependency a recipe names, as `{ id, contract, capability, versionConstraint }`. Source only. */
export function recipeDependencies(recipe: RecipeSource): Array<{ id: string; contract: string; capability: string; version?: number; versionConstraint?: string }> {
  return recipe.requires.flatMap((dependency) => {
    if (!isCanonicalDependencyTarget(dependency.target)) return [];
    const ref = parseDependencyRef(dependency.target.capability);
    if (!ref) return [];
    return [{
      id: dependency.id,
      contract: dependency.target.contract,
      capability: ref.name,
      ...(ref.version !== undefined ? { version: ref.version } : {}),
      ...(dependency.versionConstraint ? { versionConstraint: dependency.versionConstraint } : {})
    }];
  });
}

// Keep the rule type reachable from this module's signatures.
export type { RecipeRule };
