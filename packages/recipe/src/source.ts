/**
 * Business recipes: `appport.recipe/1` source (spec/recipe-1.md).
 *
 * A recipe describes a business process as structured, inspectable data: the canonical capabilities it needs, how data
 * moves between them, the decisions and human tasks along the way, and how each effect and the final outcome are
 * verified. It names canonical capabilities only, never a provider's own capability, so the same source runs against
 * whichever providers an environment resolves.
 *
 * This module defines the source model only. Nothing here executes a step, selects a provider or grants authority:
 * compilation and execution belong to a future AppWorks compiler and runtime, which will reuse AppPort's resolution,
 * binding, authorization and invocation unchanged.
 *
 * Reused, not reinvented:
 * - schemas are JSON Schema with `x-appport-*` semantic annotations, as everywhere in AppPort;
 * - dependencies are `Dependency` values with a canonical target (AppPort `dependencies-1` §3);
 * - data transformations use the `appport.mapping/1` rule vocabulary, checked by AppPort's `lintRule`;
 * - verification and preconditions use the `appport.integration/1` state-verification model (`StateExpectation`,
 *   `ValueRef`), with a probe named by a declared dependency instead of a local capability.
 */
import type { Dependency, EffectDescriptor, JSONSchema, StateExpectation, ValueRef } from "@appport/protocol";
import type { Rule } from "@appport/integration";
import type { Expression } from "./expression.js";

export const RECIPE_FORMAT = "appport.recipe/1" as const;

/** Step ids: lowercase, digits and hyphens, starting with a letter. They appear in data pointers. */
export const STEP_ID = /^[a-z][a-z0-9-]{0,62}$/;

export const STEP_KINDS = ["capability", "decision", "transform", "task", "end"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** How a recipe ends. Only `completed` produces the recipe's outputs and is subject to its outcome verification. */
export const END_OUTCOMES = ["completed", "rejected", "failed", "uncertain"] as const;
export type EndOutcome = (typeof END_OUTCOMES)[number];

export interface RecipeSource {
  format: typeof RECIPE_FORMAT;
  /**
   * The recipe's business identity: a reverse-domain identifier, e.g. `org.example.recipes.supplier-invoice`. Stable
   * across revisions and releases; never a URL and never a digest of the content.
   */
  id: string;
  name: string;
  description?: string;
  /** The business objective, in prose. */
  objective: string;
  /** The recipe's input contract: an object schema, validated before execution. */
  inputs: JSONSchema;
  /** The output contract of a `completed` run: an object schema. */
  outputs: JSONSchema;
  /** The final business outcome and how it is verified independently of any step's response. */
  outcome: RecipeOutcome;
  /** Canonical capabilities the recipe depends on. Application targets are not allowed. */
  requires: Dependency[];
  /** The first step. */
  start: string;
  steps: RecipeStep[];
  /** Authorship and provenance. Descriptive; never an identity or a trust claim. */
  provenance?: RecipeProvenance;
}

export interface RecipeProvenance {
  authors?: string[];
  /** Where the source is maintained. Location hints, not identity. */
  source?: { repository?: string; path?: string; revision?: string };
}

export interface RecipeOutcome {
  description: string;
  /** Declared business effects of a completed run, as semantic identifiers. */
  effects?: EffectDescriptor[];
  /** State verification of the final outcome. `$input` / `$output` refer to the recipe's own input and output. */
  verify: RecipeStateVerification[];
}

/** A probe call: an observation capability named by a declared dependency, with input built from references. */
export interface RecipeProbe {
  uses: string;
  input: Record<string, ValueRef>;
}

/** The `appport.integration/1` state verification, with the probe named by a declared canonical dependency. */
export interface RecipeStateVerification {
  id: string;
  kind: "state";
  via: RecipeProbe;
  expect: StateExpectation[];
}

/** The `appport.integration/1` precondition, with the probe named by a declared canonical dependency. */
export interface RecipePrecondition {
  id: string;
  via: RecipeProbe;
  require: "found" | "not-found";
  expect?: StateExpectation[];
}

/** A rule writing into a step's input, a transform's output or the recipe output. `from` pointers are recipe data pointers. */
export type RecipeRule = Rule | { op: "compute"; to: string; expr: Expression };

export interface StepBase {
  id: string;
  description?: string;
}

/**
 * Invoke a canonical capability.
 *
 * Outcomes:
 * - `success`: the invocation completed and every required verification method confirmed the effect;
 * - `failure`: the invocation failed with no effect, or verification contradicted the effect;
 * - `uncertain`: the effect may or may not have happened (a failure whose declared effect is `possible` or `unknown`,
 *   or verification that could not reach a conclusion). Required unless the step is an observation.
 *
 * Nothing is retried implicitly. Re-invoking after an uncertain outcome has to be written as another step.
 */
export interface CapabilityStep extends StepBase {
  kind: "capability";
  /** The id of a declared canonical dependency. */
  uses: string;
  /** What the recipe relies on the capability being; checked against the contract. */
  effect: "observation" | "consequential";
  /** The canonical shapes the recipe was written against. */
  expects: { input: JSONSchema; output: JSONSchema };
  /** Builds the capability input (`to` pointers into `expects.input`) from recipe data. */
  input: RecipeRule[];
  /** The task step whose response is the approval this invocation requires. */
  approval?: { task: string };
  /** Additional preconditions. They never replace the capability's own. */
  preconditions?: RecipePrecondition[];
  /**
   * `methods`: the canonical capability's declared verification methods, by id; every declared state method must be
   * listed. `additional`: recipe-specific postconditions. `$input` / `$output` refer to this invocation.
   */
  verify?: { methods?: string[]; additional?: RecipeStateVerification[] };
  on: { success: string; failure: string; uncertain?: string };
}

/** Route on declared rules: the first case whose condition holds, else `otherwise`. */
export interface DecisionStep extends StepBase {
  kind: "decision";
  cases: Array<{ when: Expression; next: string }>;
  otherwise: string;
}

/** Compute a named, schema-typed value from recipe data: the recipe's explicit, single-assignment state. */
export interface TransformStep extends StepBase {
  kind: "transform";
  output: JSONSchema;
  rules: RecipeRule[];
  next: string;
}

/**
 * Ask a person. The response is validated against `response` and becomes the step's output. AppPort records no
 * approval: the future runtime owns task persistence; this declares what is asked of whom.
 */
export interface TaskStep extends StepBase {
  kind: "task";
  purpose: string;
  /** Who must answer: a semantic role (e.g. `role:ap-manager`), never a person. */
  assignee: { role: string };
  /** The response is an approval decision a capability step may rely on (`CapabilityStep.approval`). */
  approval?: boolean;
  /** What the person is shown, from recipe data. */
  present: Array<{ label: string; value: string }>;
  response: JSONSchema;
  cases: Array<{ when: Expression; next: string }>;
  otherwise: string;
  /** Where to go if the task is never answered (expired, withdrawn). */
  unanswered: string;
}

export interface EndStep extends StepBase {
  kind: "end";
  outcome: EndOutcome;
  /** For `completed`: builds the recipe output (`to` pointers into `outputs`). Not allowed otherwise. */
  output?: RecipeRule[];
}

export type RecipeStep = CapabilityStep | DecisionStep | TransformStep | TaskStep | EndStep;

/** Every control-flow edge leaving a step, with whether the step's output is available along it. */
export function recipeEdges(step: RecipeStep): Array<{ label: string; target: string; produces: boolean }> {
  switch (step.kind) {
    case "capability":
      return [
        { label: "on.success", target: step.on?.success, produces: true },
        { label: "on.failure", target: step.on?.failure, produces: false },
        ...(step.on?.uncertain !== undefined ? [{ label: "on.uncertain", target: step.on.uncertain, produces: false }] : [])
      ];
    case "decision":
      return [
        ...(step.cases ?? []).map((c, i) => ({ label: `cases/${i}/next`, target: c?.next, produces: false })),
        { label: "otherwise", target: step.otherwise, produces: false }
      ];
    case "transform":
      return [{ label: "next", target: step.next, produces: true }];
    case "task":
      return [
        ...(step.cases ?? []).map((c, i) => ({ label: `cases/${i}/next`, target: c?.next, produces: true })),
        { label: "otherwise", target: step.otherwise, produces: true },
        { label: "unanswered", target: step.unanswered, produces: false }
      ];
    default:
      return [];
  }
}

/** The schema of a step's output, as recipe data exposes it at `/steps/<id>/output`. Decisions and ends have none. */
export function stepOutputSchema(step: RecipeStep): JSONSchema | undefined {
  if (step.kind === "capability") return step.expects?.output;
  if (step.kind === "transform") return step.output;
  if (step.kind === "task") return step.response;
  return undefined;
}
