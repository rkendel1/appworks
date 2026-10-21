/**
 * The runtime's records and errors (spec/runtime-1.md §2-§3). The shapes mirror `feltdb.flow`, which is authoritative.
 */
import type { JsonValue } from "@appport/protocol";
import type { RecipeSource } from "@appport/recipe";

export type RunStatus = "running" | "waiting" | "finished";
export type RunOutcome = "completed" | "rejected" | "failed" | "uncertain";

export interface RecipeRunRecord {
  id: string;
  recipeId: string;
  recipeDigest: string;
  recipe: RecipeSource;
  input: JsonValue;
  principal: string;
  status: RunStatus;
  outcome?: RunOutcome;
  endStep?: string;
  reason?: string;
  currentStep: string;
  /** `{ input, steps: { <id>: { output } } }`, the data recipe pointers address. */
  data: { input: JsonValue; steps: Record<string, { output: JsonValue }> };
  output?: JsonValue;
  /** Where the recipe came from when it was not handed over directly: the installed package and release (spec/distribution-1.md §6). */
  origin?: JsonValue;
  owner?: string;
  leaseExpiresAt?: string;
  events: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface StepAttemptRecord {
  id: string;
  runId: string;
  stepId: string;
  kind: "capability" | "decision" | "transform" | "task" | "end";
  status: "started" | "waiting" | "completed";
  route?: string;
  next?: string;
  startedAt: string;
  finishedAt?: string;
}

export type InvocationStatus = "prepared" | "intent" | "succeeded" | "failed" | "uncertain" | "abandoned";

export interface InvocationRecord {
  id: string;
  runId: string;
  stepId: string;
  purpose: "step" | "verification" | "reconciliation";
  ordinal: number;
  dependency: string;
  effect: "observation" | "consequential";
  idempotencyKey: string;
  inputDigest: string;
  input: JsonValue;
  status: InvocationStatus;
  classification?: "success" | "pre-effect" | "effect-unknown";
  provider?: JsonValue;
  output?: JsonValue;
  error?: JsonValue;
  cause?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface VerificationRecord {
  id: string;
  runId: string;
  stepId: string;
  methodId: string;
  source: "contract" | "recipe" | "outcome";
  result: "confirmed" | "contradicted" | "inconclusive";
  invocation?: string;
  checks: JsonValue;
  reason?: string;
  at: string;
}

export interface HumanTaskRecord {
  id: string;
  runId: string;
  stepId: string;
  role: string;
  approval: boolean;
  purpose: string;
  present: JsonValue;
  status: "pending" | "answered" | "unanswered";
  response?: JsonValue;
  answeredBy?: string;
  createdAt: string;
  closedAt?: string;
}

/**
 * What a run's records establish, kept apart so that none is mistaken for another (spec §3.1). A recorded provider result is
 * not a business outcome, and the absence of one is not proof that nothing happened.
 */
export type AssessmentState =
  | "in-progress"
  | "waiting"
  | "verified"
  | "rejected"
  | "invocation-outcome-unknown"
  | "recorded-unverified"
  | "business-outcome-unexpected"
  | "not-executed-confirmed"
  | "failed-no-effect"
  | "unresolved"
  | "failed";

export interface Assessment {
  state: AssessmentState;
  step?: string;
  invocation?: string;
  summary: string;
  /** What the operator can do about it; absent when nothing remains to do. */
  next?: string;
  /** The latest finding for each verification method, with why it is not conclusive when it is not. */
  evidence: Array<{ stepId: string; methodId: string; source: string; result: string; reason?: string }>;
  /** How many times verification recovery has been started on this run. */
  rechecks: number;
}

export type Resolution = "confirmed-completed" | "confirmed-not-executed" | "indeterminate";

export interface ReconciliationRecord {
  id: string;
  runId: string;
  stepId: string;
  invocation: string;
  operationKey: string;
  resolution: Resolution;
  lookup?: string;
  evidence: JsonValue;
  reason?: string;
  by: string;
  at: string;
}

export interface RunEventRecord {
  id: string;
  runId: string;
  seq: number;
  type: string;
  stepId?: string;
  at: string;
  detail: JsonValue;
}

export type RuntimeErrorCode =
  | "RECIPE_INVALID"
  | "RECIPE_UNSUPPORTED"
  | "INPUT_INVALID"
  | "AUTHORITY_DENIED"
  | "RUN_NOT_FOUND"
  | "RUN_LEASED"
  | "RUN_FINISHED"
  | "CONFLICT"
  | "RECORD_INVALID"
  | "FLOW_NOT_DEPLOYED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_PENDING"
  | "NOT_RECONCILABLE"
  | "RESPONSE_INVALID"
  | "INVARIANT";

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
