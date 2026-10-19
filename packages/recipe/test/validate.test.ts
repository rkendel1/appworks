/**
 * `appport.recipe/1` source model and validation (spec/recipe-1.md §3–§4).
 *
 * Each invalid case is a focused mutation of the valid supplier-invoice example, so a finding is attributable to the
 * one change that caused it.
 */
import { describe, expect, it } from "vitest";
import {
  checkExpression,
  evaluateExpression,
  validateRecipe,
  validateRecipeInput,
  type CapabilityStep,
  type DecisionStep,
  type Expression,
  type RecipeFinding,
  type RecipeSource,
  type TaskStep
} from "../src/index.js";
import { CONTRACT, accountingContract, example, step } from "./fixtures.js";

const errors = (recipe: unknown, environment?: Parameters<typeof validateRecipe>[1]) =>
  validateRecipe(recipe, environment).findings.filter((f) => f.severity === "error");
const find = (recipe: unknown, code: RecipeFinding["code"], environment?: Parameters<typeof validateRecipe>[1]) =>
  validateRecipe(recipe, environment).findings.filter((f) => f.code === code);
const mutate = (change: (recipe: RecipeSource) => void): RecipeSource => {
  const recipe = example();
  change(recipe);
  return recipe;
};
const environment = (contract = accountingContract()) => ({ contracts: { [CONTRACT]: contract } });

describe("the supplier-invoice example", () => {
  it("is valid source, with no finding of any kind", () => {
    expect(validateRecipe(example()).findings).toEqual([]);
    expect(validateRecipe(example())).toMatchObject({ ok: true, sourceOk: true });
  });

  it("makes its unresolved contract explicit: an environment without it reports every dependency, as environment findings", () => {
    const result = validateRecipe(example(), {});
    expect(result.sourceOk).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.code, f.scope, f.path])).toEqual([
      ["ENV_CONTRACT_UNAVAILABLE", "environment", "/requires/0/target/contract"],
      ["ENV_CONTRACT_UNAVAILABLE", "environment", "/requires/1/target/contract"],
      ["ENV_CONTRACT_UNAVAILABLE", "environment", "/requires/2/target/contract"]
    ]);
  });

  it("is valid against the test-fixture contract it was written for", () => {
    expect(validateRecipe(example(), environment()).findings).toEqual([]);
  });

  it("names canonical capabilities only: no provider, application or local capability name appears in it", () => {
    const recipe = example();
    for (const dependency of recipe.requires) {
      expect(dependency.target).toHaveProperty("contract", CONTRACT);
      expect(dependency.target).not.toHaveProperty("application");
      expect(dependency.target).not.toHaveProperty("provider");
    }
    expect(JSON.stringify(recipe)).not.toMatch(/registrationId|fingerprint|"application"/);
  });

  it("validates inputs against the declared input contract before anything runs", () => {
    const recipe = example();
    expect(validateRecipeInput(recipe, { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30" })).toEqual({ ok: true });
    const bad = validateRecipeInput(recipe, { supplierId: "s1", amount: "120", currency: "JPY", dueDate: "2026-11-30" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["/amount", "/currency"]));
  });

  it("its approval rule is deterministic and testable on its own", () => {
    const rule = step<DecisionStep>(example(), "needs-approval").cases[0]!.when;
    const data = (input: Record<string, unknown>) => ({ input, steps: {} }) as never;
    expect(evaluateExpression(rule, data({ amount: 500, purchaseOrder: "PO-7" }))).toBe(false);
    expect(evaluateExpression(rule, data({ amount: 500 }))).toBe(true);
    expect(evaluateExpression(rule, data({ amount: 25000, purchaseOrder: "PO-7" }))).toBe(true);
  });
});

describe("structure and format", () => {
  it("rejects an unsupported format version, and stops there", () => {
    const result = validateRecipe({ ...example(), format: "appport.recipe/2" });
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([["RECIPE_FORMAT", "/format"]]);
    expect(result.findings[0]?.message).toMatch(/appport.recipe\/2 is not supported/);
    expect(find({ ...example(), format: "something-else" }, "RECIPE_FORMAT")[0]?.message).toMatch(/must be appport.recipe\/1/);

  });

  it("rejects undocumented members instead of ignoring them", () => {
    expect(find({ ...example(), retries: 3 }, "RECIPE_STRUCTURE").map((f) => f.path)).toEqual(["/retries"]);
    const recipe = mutate((r) => Object.assign(step(r, "submit"), { retry: { attempts: 3 } }));
    expect(find(recipe, "RECIPE_STRUCTURE").map((f) => f.path)).toEqual(["/steps/5/retry"]);
  });

  it("rejects a URL or digest as the recipe's identity", () => {
    expect(find({ ...example(), id: "https://recipes.example.org/supplier-invoice" }, "RECIPE_ID_INVALID")).toHaveLength(1);
    expect(find({ ...example(), id: "sha256:" + "0".repeat(64) }, "RECIPE_ID_INVALID")).toHaveLength(1);
  });

  it("reports duplicate step identifiers", () => {
    const recipe = mutate((r) => r.steps.push({ ...structuredClone(step(r, "reject-invalid")) }));
    expect(find(recipe, "STEP_DUPLICATE_ID").map((f) => f.path)).toEqual([`/steps/${recipe.steps.length - 1}/id`]);
  });

  it("reports unknown step kinds", () => {
    const recipe = mutate((r) => r.steps.push({ id: "run-script", kind: "script" } as never));
    expect(find(recipe, "STEP_UNKNOWN_KIND")).toHaveLength(1);
  });
});

describe("control flow", () => {
  it("reports a missing control-flow target", () => {
    const recipe = mutate((r) => (step(r, "submit").on.failure = "nowhere"));
    expect(find(recipe, "TARGET_MISSING").map((f) => f.path)).toEqual(["/steps/5/on/failure"]);
  });

  it("reports a missing start", () => {
    expect(find(mutate((r) => (r.start = "begin")), "TARGET_MISSING").map((f) => f.path)).toEqual(["/start"]);
  });

  it("rejects cycles: there are no loops or implicit retries", () => {
    const recipe = mutate((r) => (step(r, "submit").on.uncertain = "check-duplicate"));
    expect(find(recipe, "CYCLE")).toHaveLength(1);
    expect(find(recipe, "CYCLE")[0]?.message).toMatch(/check-duplicate → is-duplicate → needs-approval → submit → check-duplicate/);
  });

  it("reports unreachable steps", () => {
    const recipe = mutate((r) => r.steps.push({ id: "orphan", kind: "end", outcome: "failed" }));
    expect(find(recipe, "STEP_UNREACHABLE")).toEqual([expect.objectContaining({ severity: "warning", path: `/steps/${recipe.steps.length - 1}` })]);
  });

  it("reports an unhandled failure path", () => {
    const recipe = mutate((r) => delete (step(r, "check-duplicate").on as { failure?: string }).failure);
    expect(find(recipe, "PATH_UNHANDLED").map((f) => f.path)).toEqual(["/steps/1/on/failure"]);
  });

  it("requires an uncertain outcome of a consequential step to be routed", () => {
    const recipe = mutate((r) => delete step(r, "submit").on.uncertain);
    expect(find(recipe, "UNCERTAIN_UNHANDLED").map((f) => f.path)).toEqual(["/steps/5/on"]);
  });

  it("requires the environment's declared failure semantics to be routed even for an observation", () => {
    const contract = accountingContract();
    (contract.attributes!["appport.integration/1"] as { capabilities: Record<string, unknown> }).capabilities["invoice.duplicate@1"] = {
      failures: [{ code: "TIMEOUT", retry: "safe", effect: "unknown" }]
    };
    expect(find(example(), "ENV_UNCERTAIN_UNHANDLED", environment(contract)).map((f) => [f.path, f.scope])).toEqual([["/steps/1/on", "environment"]]);
  });

  it("flags a consequential re-invocation after an uncertain outcome", () => {
    const recipe = mutate((r) => {
      step(r, "submit").on.uncertain = "retry-submit";
      r.steps.push({ ...structuredClone(step(r, "submit")), id: "retry-submit", on: { success: "submitted", failure: "submission-failed", uncertain: "submission-uncertain" } } as CapabilityStep);
    });
    expect(find(recipe, "REINVOKED_AFTER_UNCERTAIN")).toEqual([expect.objectContaining({ severity: "warning" })]);
  });

  it("requires a task to route an unanswered task", () => {
    const recipe = mutate((r) => delete (step<TaskStep>(r, "request-approval") as { unanswered?: string }).unanswered);
    expect(find(recipe, "PATH_UNHANDLED").map((f) => f.path)).toEqual(["/steps/4/unanswered"]);
  });

  it("requires a completed end, and outputs from it", () => {
    const recipe = mutate((r) => {
      for (const s of r.steps) if (s.kind === "end" && s.outcome === "completed") s.outcome = "rejected", delete s.output;
    });
    expect(find(recipe, "OUTCOME_OUTPUT_MISSING").map((f) => f.path)).toEqual(["/steps"]);
    const noOutput = mutate((r) => delete step<{ output?: unknown }>(r, "submitted").output);
    expect(find(noOutput, "OUTCOME_OUTPUT_MISSING").map((f) => f.path)).toEqual(["/steps/7/output"]);
  });
});

describe("data references and types", () => {
  it("rejects a reference to a field no schema declares", () => {
    const recipe = mutate((r) => (step(r, "check-duplicate").input[0] = { op: "copy", from: "/input/supplierCode", to: "/supplierId" }));
    expect(find(recipe, "REFERENCE_INVALID").map((f) => f.path)).toEqual(["/steps/1/input/0/from"]);
  });

  it("rejects a reference outside recipe data, or to a step without output", () => {
    const outside = mutate((r) => (step<DecisionStep>(r, "validate-fields").cases[0]!.when = { op: "le", args: [{ ref: "/env/AMOUNT" }, { value: 0 }] }));
    expect(find(outside, "REFERENCE_INVALID")).toHaveLength(1);
    const decision = mutate((r) => (step<DecisionStep>(r, "is-duplicate").cases[0]!.when = { op: "eq", args: [{ ref: "/steps/validate-fields/output/x" }, { value: 1 }] }));
    expect(find(decision, "REFERENCE_INVALID")[0]?.message).toMatch(/a decision step has no output/);
  });

  it("rejects a reference to an output that is not produced on every path", () => {
    // The approval comment exists only on the approved branch, not on the automatic one.
    const recipe = mutate((r) => step(r, "submit").input.push({ op: "copy", from: "/steps/request-approval/output/comment", to: "/approvalNote" }));
    expect(find(recipe, "REFERENCE_UNAVAILABLE").map((f) => f.path)).toEqual(["/steps/5/input/6/from"]);
    // Nor is a capability's output available on its failure path.
    const failed = mutate((r) => {
      step(r, "check-duplicate").on.failure = "explain";
      r.steps.push({ id: "explain", kind: "decision", cases: [{ when: { op: "eq", args: [{ ref: "/steps/check-duplicate/output/duplicate" }, { value: true }] }, next: "lookup-failed" }], otherwise: "lookup-failed" });
    });
    expect(find(failed, "REFERENCE_UNAVAILABLE")).toHaveLength(1);
  });

  it("rejects an input/output type mismatch in a mapping", () => {
    const recipe = mutate((r) => (step(r, "submit").input[2] = { op: "copy", from: "/input/supplierId", to: "/amount" }));
    expect(find(recipe, "SCHEMA_MISMATCH").map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringMatching(/incompatible types \(string → number\)/)]));
  });

  it("rejects an optional source written to a required field without a default", () => {
    const recipe = mutate((r) => (step(r, "check-duplicate").input[0] = { op: "copy", from: "/input/purchaseOrder", to: "/supplierId" }));
    expect(find(recipe, "SCHEMA_MISMATCH").map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringMatching(/optional but \/supplierId is required/)]));
  });

  it("reports a required capability input no rule produces", () => {
    const recipe = mutate((r) => step(r, "submit").input.splice(4, 1));
    expect(find(recipe, "MAPPING_INCOMPLETE").map((f) => f.message)).toEqual(["required field /dueDate is not produced by any rule"]);
  });

  it("rejects ill-typed expressions", () => {
    const string = mutate((r) => (step<DecisionStep>(r, "validate-fields").cases[0]!.when = { op: "gt", args: [{ ref: "/input/supplierId" }, { value: 0 }] }));
    expect(find(string, "EXPRESSION_TYPE").map((f) => f.path)).toEqual(["/steps/0/cases/0/when/args/0"]);
    const notBoolean = mutate((r) => (step<DecisionStep>(r, "validate-fields").cases[0]!.when = { ref: "/input/amount" }));
    expect(find(notBoolean, "EXPRESSION_TYPE")[0]?.message).toMatch(/a condition must be boolean/);
    const unknownOp = mutate((r) => (step<DecisionStep>(r, "validate-fields").cases[0]!.when = { op: "eval", args: [{ value: "process.exit()" }] } as never));
    expect(find(unknownOp, "EXPRESSION_INVALID")[0]?.message).toMatch(/unknown operator "eval"/);
  });

  it("requires optional data to be handled explicitly", () => {
    const unguarded = mutate((r) => (step<DecisionStep>(r, "needs-approval").cases[0]!.when = { op: "eq", args: [{ ref: "/input/purchaseOrder" }, { value: "" }] }));
    expect(find(unguarded, "EXPRESSION_OPTIONAL").map((f) => f.path)).toEqual(["/steps/3/cases/0/when/args/0"]);
    const guarded = mutate((r) => (step<DecisionStep>(r, "needs-approval").cases[0]!.when = {
      op: "and", args: [{ op: "exists", args: [{ ref: "/input/purchaseOrder" }] }, { op: "eq", args: [{ ref: "/input/purchaseOrder" }, { value: "" }] }]
    }));
    expect(find(guarded, "EXPRESSION_OPTIONAL")).toEqual([]);
    const fallback = mutate((r) => (step<DecisionStep>(r, "needs-approval").cases[0]!.when = { op: "eq", args: [{ op: "coalesce", args: [{ ref: "/input/purchaseOrder" }, { value: "" }] }, { value: "" }] }));
    expect(find(fallback, "EXPRESSION_OPTIONAL")).toEqual([]);
  });
});

describe("dependencies", () => {
  it("rejects a dependency on an application's own capability", () => {
    const recipe = mutate((r) => (r.requires[1]!.target = { application: "com.acme.erp", capability: "ap.release@1" }));
    expect(find(recipe, "DEPENDENCY_NOT_CANONICAL").map((f) => f.path)).toEqual(["/requires/1/target"]);
  });

  it("rejects a step without a canonical capability requirement", () => {
    const recipe = mutate((r) => (step(r, "submit").uses = "ap.release"));
    expect(find(recipe, "DEPENDENCY_UNDECLARED").map((f) => f.path)).toEqual(["/steps/5/uses"]);
  });

  it("rejects malformed version constraints, reusing the dependency rules of appport.integration/1", () => {
    const recipe = mutate((r) => (r.requires[1]!.versionConstraint = "^one"));
    expect(find(recipe, "VERSION_CONSTRAINT_INVALID").map((f) => f.path)).toEqual(["/requires/1/versionConstraint"]);
    const unpinned = mutate((r) => delete r.requires[1]!.versionConstraint);
    expect(find(unpinned, "DEPENDENCY_INVALID")[0]?.message).toBe("an unpinned target needs a versionConstraint");
  });

  it("warns about a declared dependency nothing uses", () => {
    const recipe = mutate((r) => r.requires.push({ id: "spare", relationship: "observes", target: { contract: CONTRACT, capability: "invoice.get@1" }, required: true }));
    expect(find(recipe, "DEPENDENCY_UNUSED")).toEqual([expect.objectContaining({ severity: "warning", path: "/requires/3" })]);
  });

  it("keeps provider constraints distinct from the canonical requirement, and never needs one", () => {
    const constrained = mutate((r) => ((r.requires[1]!.target as { provider?: string }).provider = "com.acme.erp"));
    expect(errors(constrained)).toEqual([]);
    expect(constrained.requires[1]!.target).toEqual({ contract: CONTRACT, capability: "invoice.submit", provider: "com.acme.erp" });
  });
});

describe("verification and approval", () => {
  it("requires a consequential step to declare verification of its effect", () => {
    const recipe = mutate((r) => delete step(r, "submit").verify);
    expect(find(recipe, "VERIFICATION_MISSING").map((f) => f.path)).toEqual(["/steps/5/verify"]);
  });

  it("requires the final outcome to be verified", () => {
    const recipe = mutate((r) => (r.outcome.verify = []));
    expect(find(recipe, "VERIFICATION_MISSING").map((f) => f.path)).toEqual(["/outcome/verify"]);
  });

  it("never lets a recipe drop a verification method the contract declares", () => {
    const recipe = mutate((r) => {
      step(r, "submit").verify = { additional: step(r, "submit").verify!.additional };
      step(r, "submit-approved").verify = { additional: step(r, "submit-approved").verify!.additional };
    });
    expect(errors(recipe)).toEqual([]);
    expect(find(recipe, "ENV_VERIFICATION_WEAKENED", environment()).map((f) => f.path)).toEqual(["/steps/5/verify/methods", "/steps/6/verify/methods"]);
    expect(find(example(), "ENV_VERIFICATION_UNKNOWN", environment(accountingContract({ verifyId: "ledger-read-back" })))).toHaveLength(2);
  });

  it("requires a probe to be an observation", () => {
    const recipe = mutate((r) => (r.outcome.verify[0]!.via.uses = "submit-invoice"));
    expect(find(recipe, "ENV_PROBE_NOT_OBSERVATION", environment()).map((f) => f.path)).toEqual(["/outcome/verify/0/via/uses"]);
  });

  it("requires the approval a contract demands to be obtained by a task on every path", () => {
    const strict = environment(accountingContract({ approval: { required: true, approver: "role:ap-manager" } }));
    expect(find(example(), "ENV_APPROVAL_REQUIRED", strict).map((f) => f.path)).toEqual(["/steps/5/approval"]);
    const wrongRole = environment(accountingContract({ approval: { required: true, approver: "role:controller" } }));
    expect(find(example(), "ENV_APPROVAL_REQUIRED", wrongRole).map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringMatching(/assigned to role:ap-manager/)]));
    const notDominating = mutate((r) => (step(r, "submit").approval = { task: "request-approval" }));
    expect(find(notDominating, "APPROVAL_TASK_INVALID")[0]?.message).toMatch(/not answered on every path to "submit"/);
  });

  it("reports a contract that no longer accepts what the recipe sends", () => {
    const narrowed = accountingContract({ submitInput: { ...step(example(), "submit").expects.input, required: ["supplierId", "invoiceNumber", "amount", "currency", "dueDate", "costCentre"], properties: { ...step(example(), "submit").expects.input.properties, costCentre: { type: "string" } } } });
    expect(find(example(), "ENV_SCHEMA_INCOMPATIBLE", environment(narrowed)).map((f) => f.scope)).toEqual(["environment", "environment"]);
  });

  it("distinguishes environment findings from source errors, and reports provider availability", () => {
    const result = validateRecipe(example(), { ...environment(), providers: { "submit-invoice": { eligible: 0 }, "get-invoice": { eligible: 2 } } });
    expect(result.sourceOk).toBe(true);
    expect(result.findings.map((f) => [f.code, f.severity, f.scope])).toEqual([
      ["ENV_NO_ELIGIBLE_PROVIDER", "error", "environment"],
      ["ENV_AMBIGUOUS_PROVIDER", "warning", "environment"]
    ]);
  });
});

describe("expressions", () => {
  const resolve = (types: Record<string, string | undefined>) => (pointer: string) =>
    pointer in types ? { schema: { type: types[pointer] as never }, required: true } : { code: "REFERENCE_INVALID" as const, error: "no" };

  it("are bounded", () => {
    let deep: Expression = { value: true };
    for (let i = 0; i < 40; i++) deep = { op: "not", args: [deep] };
    expect(checkExpression(deep, resolve({})).issues.map((i) => i.code)).toContain("EXPRESSION_INVALID");
  });

  it("check units", () => {
    const resolveUnits = (pointer: string) => ({ schema: { type: "number" as const, "x-appport-unit": pointer === "/a" ? "h" : "min" } as never, required: true });
    expect(checkExpression({ op: "gt", args: [{ ref: "/a" }, { ref: "/b" }] }, resolveUnits).issues[0]?.message).toMatch(/different units \(h, min\)/);
  });

  it("evaluate without coercion and fail closed on a wrong operand", () => {
    expect(evaluateExpression({ op: "in", args: [{ ref: "/c" }, { value: ["EUR", "USD"] }] }, { c: "EUR" })).toBe(true);
    expect(evaluateExpression({ op: "if", args: [{ op: "exists", args: [{ ref: "/x" }] }, { ref: "/x" }, { value: "none" }] }, {})).toBe("none");
    expect(() => evaluateExpression({ op: "gt", args: [{ ref: "/a" }, { value: 1 }] }, { a: "2" })).toThrow(/expected a number/);
  });
});
