/**
 * The recipe runtime (spec/runtime-1.md). A run is a FeltDB record the runtime drives one step at a time. Every step
 * boundary is one fenced transaction; a consequential invocation is recorded as intent before it is made and as an
 * outcome after, and a run found with an intent and no outcome is never invoked again.
 */
import { randomUUID } from "node:crypto";
import { canonicalize, digestOf, readPointer, type JsonValue } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import {
  evaluateExpression,
  validateRecipe,
  validateRecipeInput,
  type CapabilityStep,
  type DecisionStep,
  type EndStep,
  type RecipeSource,
  type RecipeStateVerification,
  type TaskStep,
  type TransformStep,
  type RecipeStep
} from "@appport/recipe";
import type { StateExpectation, ValueRef } from "@appport/protocol";
import { permissiveAuthority, type CapabilityGateway, type GatewayResult, type RuntimeAuthority } from "./gateway.js";
import {
  RuntimeError,
  type HumanTaskRecord,
  type InvocationRecord,
  type RecipeRunRecord,
  type RunEventRecord,
  type RunOutcome,
  type StepAttemptRecord,
  type VerificationRecord
} from "./model.js";
import { declaredStateMethods } from "./contract.js";
import { applyRules } from "./rules.js";
import { Store, type Write } from "./store.js";
import { unsupportedConstructs } from "./support.js";

/** Points at which a test may stop the runtime as a crash would (spec §8). A hook that throws leaves the records as they are. */
export type RuntimePoint = "invoke:intent-recorded" | "invoke:returned" | "step:committed";

export interface RuntimeOptions {
  /** Directory holding the runtime's FeltDB state. */
  home: string;
  gateway: CapabilityGateway;
  authority?: RuntimeAuthority;
  /** Identifies this worker in leases. */
  worker?: string;
  leaseMs?: number;
  now?: () => number;
  hook?: (point: RuntimePoint, info: { run: string; step: string }) => void | Promise<void>;
}

export interface RunView {
  id: string;
  recipeId: string;
  recipeDigest: string;
  status: RecipeRunRecord["status"];
  outcome?: RunOutcome;
  endStep?: string;
  reason?: string;
  currentStep: string;
  output?: JsonValue;
  principal: string;
  /** A run with a lease that has expired and that is not finished: a worker died. `resume` takes it over. */
  interrupted: boolean;
  steps: Array<Pick<StepAttemptRecord, "stepId" | "kind" | "status" | "route" | "next">>;
  invocations: Array<Pick<InvocationRecord, "id" | "stepId" | "purpose" | "effect" | "status" | "classification" | "idempotencyKey" | "provider" | "cause" | "error">>;
  verifications: Array<Pick<VerificationRecord, "stepId" | "methodId" | "source" | "result" | "reason">>;
  tasks: Array<Pick<HumanTaskRecord, "stepId" | "role" | "approval" | "status" | "answeredBy" | "response" | "present">>;
  events: number;
}

type Verdict = "confirmed" | "contradicted" | "inconclusive";
type Versioned<T> = T & { __version: number };

const sorted = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
const isValueRef = (v: unknown): v is { $input: string } | { $output: string } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && ("$input" in v || "$output" in v);
const same = (a: unknown, b: unknown) => canonicalize(a as JsonValue) === canonicalize(b as JsonValue);

export class RecipeRuntime {
  private readonly authority: RuntimeAuthority;
  private readonly worker: string;
  private readonly leaseMs: number;
  private readonly now: () => number;

  private constructor(
    private readonly store: Store,
    private readonly options: RuntimeOptions
  ) {
    this.authority = options.authority ?? permissiveAuthority;
    this.worker = options.worker ?? `worker-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  static async open(options: RuntimeOptions): Promise<RecipeRuntime> {
    return new RecipeRuntime(await Store.open(options.home), options);
  }

  close(): Promise<void> {
    return this.store.close();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  // ------------------------------------------------------------------------------------------------ public API

  /** Starts a run (spec §4). A recipe that does not validate here, or an input that does not match, writes nothing. */
  async start(recipeSource: unknown, input: unknown, principal: string): Promise<RunView> {
    const id = (recipeSource as { id?: unknown } | null)?.id;
    if (!(await this.authority.canStart(principal, typeof id === "string" ? id : ""))) throw new RuntimeError("AUTHORITY_DENIED", `${principal} may not start ${String(id)}`);
    const shape = validateRecipe(recipeSource);
    if (!shape.sourceOk) throw new RuntimeError("RECIPE_INVALID", `the recipe does not validate: ${shape.findings.filter((f) => f.severity === "error").map((f) => `${f.code} ${f.path}`).join("; ")}`, { findings: shape.findings });
    const recipe = recipeSource as RecipeSource;
    const validation = validateRecipe(recipe, await this.options.gateway.snapshot(recipe.requires));
    if (!validation.ok) throw new RuntimeError("RECIPE_INVALID", `the recipe does not validate in this environment: ${validation.findings.filter((f) => f.severity === "error").map((f) => `${f.code} ${f.path}`).join("; ")}`, { findings: validation.findings });
    const unsupported = unsupportedConstructs(recipe);
    if (unsupported.length) throw new RuntimeError("RECIPE_UNSUPPORTED", `the runtime does not execute: ${unsupported.join("; ")}`, { unsupported });
    const checked = validateRecipeInput(recipe, input);
    if (!checked.ok) throw new RuntimeError("INPUT_INVALID", `the input does not match the recipe: ${checked.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`, { issues: checked.issues });

    const at = this.iso();
    const run: RecipeRunRecord = {
      id: `run-${randomUUID()}`,
      recipeId: recipe.id,
      recipeDigest: digestOf(recipe as never),
      recipe,
      input: input as JsonValue,
      principal,
      status: "running",
      currentStep: recipe.start,
      data: { input: input as JsonValue, steps: {} },
      owner: this.worker,
      leaseExpiresAt: this.lease(),
      events: 1,
      createdAt: at,
      updatedAt: at
    };
    await this.store.commit([
      { collection: "RecipeRun", id: run.id, value: run, create: true },
      this.event(run.id, 1, "run.started", undefined, { recipe: run.recipeDigest, principal })
    ]);
    return this.drive(run.id);
  }

  /** Takes over a run whose worker died (its lease expired) and continues it; a finished or waiting run is reported as it is. */
  async resume(runId: string): Promise<RunView> {
    const run = await this.load(runId);
    if (run.status === "finished" || run.status === "waiting") return this.view(runId);
    if (run.owner !== this.worker && run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) > this.now()) throw new RuntimeError("RUN_LEASED", `${runId} is held by ${run.owner} until ${run.leaseExpiresAt}`);
    await this.store.commit([this.runWrite(run, { owner: this.worker, leaseExpiresAt: this.lease() }), this.event(runId, run.events + 1, "run.resumed", undefined, { worker: this.worker, previous: run.owner ?? null })]);
    return this.drive(runId);
  }

  /** Answers a pending human task (spec §9) and continues the run. */
  async answerTask(runId: string, stepId: string, response: unknown, principal: string): Promise<RunView> {
    const { run, task, step } = await this.pendingTask(runId, stepId);
    if (!(await this.authority.canAnswer(principal, task.role))) throw new RuntimeError("AUTHORITY_DENIED", `${principal} may not answer for ${task.role}`);
    const checked = fromJSONSchema(step.response as never).validate(response);
    if (!checked.ok) throw new RuntimeError("RESPONSE_INVALID", `the response does not match the task: ${checked.issues.map((i) => i.message).join("; ")}`);
    const data = { ...run.data, steps: { ...run.data.steps, [stepId]: { output: response as JsonValue } } };
    const next = this.choose(step, data);
    await this.closeTask(run, task, step, "answered", next, data, { response: response as JsonValue, answeredBy: principal }, { route: "answered", by: principal });
    return this.drive(runId);
  }

  /** Marks a pending task unanswered and takes the recipe's `unanswered` edge (spec §9). */
  async expireTask(runId: string, stepId: string, principal: string): Promise<RunView> {
    const { run, task, step } = await this.pendingTask(runId, stepId);
    if (!(await this.authority.canAnswer(principal, task.role))) throw new RuntimeError("AUTHORITY_DENIED", `${principal} may not close a task for ${task.role}`);
    await this.closeTask(run, task, step, "unanswered", step.unanswered, run.data, {}, { route: "unanswered", by: principal });
    return this.drive(runId);
  }

  /** The runs in this home, oldest first. */
  async runs(): Promise<Array<Pick<RunView, "id" | "recipeId" | "status" | "outcome">>> {
    const all = await this.store.list<RecipeRunRecord>("RecipeRun");
    return all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1)).map((r) => ({ id: r.id, recipeId: r.recipeId, status: r.status, ...(r.outcome ? { outcome: r.outcome } : {}) }));
  }

  async status(runId: string): Promise<RunView> {
    return this.view(runId);
  }

  // ------------------------------------------------------------------------------------------------ driving

  private lease(): string {
    return new Date(this.now() + this.leaseMs).toISOString();
  }

  private async load(runId: string): Promise<Versioned<RecipeRunRecord>> {
    const run = await this.store.get<RecipeRunRecord>("RecipeRun", runId);
    if (!run) throw new RuntimeError("RUN_NOT_FOUND", `no run ${runId}`);
    return run;
  }

  private event(runId: string, seq: number, type: string, stepId: string | undefined, detail: object): Write {
    const value: RunEventRecord = { id: `${runId}.${String(seq).padStart(5, "0")}`, runId, seq, type, ...(stepId ? { stepId } : {}), at: this.iso(), detail: detail as JsonValue };
    return { collection: "RunEvent", id: value.id, value, create: true };
  }

  /** A fenced update of the run record: only the worker that holds the version it read can commit it. */
  private runWrite(run: Versioned<RecipeRunRecord>, patch: Partial<Omit<RecipeRunRecord, "owner" | "leaseExpiresAt">> & { owner?: string | null; leaseExpiresAt?: string | null }, eventCount = 1): Write {
    const { __version, ...rest } = run;
    const merged = { ...rest, ...patch, events: run.events + eventCount, updatedAt: this.iso() } as Record<string, unknown>;
    for (const key of ["owner", "leaseExpiresAt"]) if (merged[key] === null) delete merged[key];
    return { collection: "RecipeRun", id: run.id, value: merged, ifVersion: __version };
  }

  private async drive(runId: string): Promise<RunView> {
    for (;;) {
      const run = await this.load(runId);
      if (run.status !== "running") return this.view(runId);
      if (run.owner !== this.worker) throw new RuntimeError("RUN_LEASED", `${runId} is held by ${run.owner ?? "another worker"}`);
      const step = run.recipe.steps.find((s) => s.id === run.currentStep);
      if (!step) throw new RuntimeError("INVARIANT", `${runId}: no step ${run.currentStep}`);
      const waiting = await this.execute(run, step);
      if (waiting) return this.view(runId);
    }
  }

  /** Executes one step. Returns true when the run stopped (finished or waiting). */
  private async execute(run: Versioned<RecipeRunRecord>, step: RecipeStep): Promise<boolean> {
    switch (step.kind) {
      case "decision":
        return this.pure(run, step, () => ({ next: this.choose(step, run.data), route: "case" }));
      case "transform":
        return this.pure(run, step, () => {
          const output = applyRules(step.rules, run.data);
          const checked = fromJSONSchema(step.output as never).validate(output);
          if (!checked.ok) throw new Error(`transform output does not match its schema: ${checked.issues.map((i) => i.message).join("; ")}`);
          return { next: step.next, route: "next", data: { ...run.data, steps: { ...run.data.steps, [step.id]: { output } } } };
        });
      case "task":
        return this.taskStep(run, step);
      case "capability":
        return this.capabilityStep(run, step);
      case "end":
        return this.endStep(run, step);
    }
  }

  /** Decisions and transforms are pure: done in one transaction with the move to the next step. */
  private async pure(run: Versioned<RecipeRunRecord>, step: DecisionStep | TransformStep, compute: () => { next: string; route: string; data?: RecipeRunRecord["data"] }): Promise<boolean> {
    let result: ReturnType<typeof compute>;
    try {
      result = compute();
    } catch (error) {
      await this.finish(run, step.id, "failed", `step ${step.id} could not be evaluated: ${(error as Error).message}`, undefined, step.kind);
      return true;
    }
    const at = this.iso();
    const attempt: StepAttemptRecord = { id: `${run.id}.${step.id}`, runId: run.id, stepId: step.id, kind: step.kind, status: "completed", route: result.route, next: result.next, startedAt: at, finishedAt: at };
    await this.store.commit([
      { collection: "StepAttempt", id: attempt.id, value: attempt, create: true },
      this.runWrite(run, { currentStep: result.next, ...(result.data ? { data: result.data } : {}), leaseExpiresAt: this.lease() }),
      this.event(run.id, run.events + 1, "step.completed", step.id, { route: result.route, next: result.next })
    ]);
    await this.options.hook?.("step:committed", { run: run.id, step: step.id });
    return false;
  }

  /** The first case that is true, else `otherwise`. */
  private choose(step: DecisionStep | TaskStep, data: RecipeRunRecord["data"]): string {
    for (const c of step.cases) if (evaluateExpression(c.when, data as never) === true) return c.next;
    return step.otherwise;
  }

  private async finish(run: Versioned<RecipeRunRecord>, stepId: string, outcome: RunOutcome, reason?: string, output?: JsonValue, kind: StepAttemptRecord["kind"] = "end"): Promise<void> {
    const at = this.iso();
    const writes: Write[] = [];
    const record: StepAttemptRecord = { id: `${run.id}.${stepId}`, runId: run.id, stepId, kind, status: "completed", route: outcome, startedAt: at, finishedAt: at };
    writes.push({ collection: "StepAttempt", id: record.id, value: record, create: true });
    writes.push(this.runWrite(run, { status: "finished", outcome, endStep: stepId, ...(reason ? { reason } : {}), ...(output !== undefined ? { output } : {}), finishedAt: at, owner: null, leaseExpiresAt: null }, 1));
    writes.push(this.event(run.id, run.events + 1, "run.finished", stepId, { outcome, ...(reason ? { reason } : {}) }));
    await this.store.commit(writes);
  }

  // ------------------------------------------------------------------------------------------------ human tasks

  private async taskStep(run: Versioned<RecipeRunRecord>, step: TaskStep): Promise<boolean> {
    const id = `${run.id}.${step.id}`;
    const existing = await this.store.get<HumanTaskRecord>("HumanTask", id);
    if (existing && existing.status !== "pending") throw new RuntimeError("INVARIANT", `${id} is ${existing.status} but the run is still at it`);
    const at = this.iso();
    const writes: Write[] = [];
    if (!existing) {
      const task: HumanTaskRecord = {
        id, runId: run.id, stepId: step.id, role: step.assignee.role, approval: step.approval === true, purpose: step.purpose,
        present: step.present.map((p) => ({ label: p.label, value: (readPointer(run.data, p.value) ?? null) as JsonValue })) as JsonValue,
        status: "pending", createdAt: at
      };
      writes.push({ collection: "HumanTask", id, value: task, create: true });
      const attempt: StepAttemptRecord = { id, runId: run.id, stepId: step.id, kind: "task", status: "waiting", startedAt: at };
      writes.push({ collection: "StepAttempt", id, value: attempt, create: true });
    }
    writes.push(this.runWrite(run, { status: "waiting", owner: null, leaseExpiresAt: null }));
    writes.push(this.event(run.id, run.events + 1, "task.waiting", step.id, { role: step.assignee.role }));
    await this.store.commit(writes);
    return true;
  }

  private async pendingTask(runId: string, stepId: string) {
    const run = await this.load(runId);
    const task = await this.store.get<HumanTaskRecord>("HumanTask", `${runId}.${stepId}`);
    if (!task) throw new RuntimeError("TASK_NOT_FOUND", `${runId} has no task ${stepId}`);
    if (task.status !== "pending" || run.status !== "waiting" || run.currentStep !== stepId) throw new RuntimeError("TASK_NOT_PENDING", `task ${stepId} of ${runId} is ${task.status}; the run is ${run.status} at ${run.currentStep}`);
    const step = run.recipe.steps.find((s) => s.id === stepId) as TaskStep;
    return { run, task, step };
  }

  private async closeTask(run: Versioned<RecipeRunRecord>, task: Versioned<HumanTaskRecord>, step: TaskStep, status: "answered" | "unanswered", next: string, data: RecipeRunRecord["data"], patch: Partial<HumanTaskRecord>, detail: object): Promise<void> {
    const at = this.iso();
    const attempt = await this.store.get<StepAttemptRecord>("StepAttempt", task.id);
    const { __version: tv, ...taskRest } = task;
    const writes: Write[] = [
      { collection: "HumanTask", id: task.id, value: { ...taskRest, ...patch, status, closedAt: at }, ifVersion: tv },
      this.runWrite(run, { status: "running", currentStep: next, data, owner: this.worker, leaseExpiresAt: this.lease() }),
      this.event(run.id, run.events + 1, status === "answered" ? "task.answered" : "task.unanswered", step.id, { ...detail, next })
    ];
    if (attempt) {
      const { __version: av, ...attemptRest } = attempt;
      writes.push({ collection: "StepAttempt", id: attempt.id, value: { ...attemptRest, status: "completed", route: status, next, finishedAt: at }, ifVersion: av });
    }
    await this.store.commit(writes);
  }

  // ------------------------------------------------------------------------------------------------ capability steps

  private async capabilityStep(run: Versioned<RecipeRunRecord>, step: CapabilityStep): Promise<boolean> {
    const dependency = run.recipe.requires.find((d) => d.id === step.uses);
    if (!dependency) throw new RuntimeError("INVARIANT", `${step.id} uses undeclared dependency ${step.uses}`);
    if (step.approval) {
      const task = await this.store.get<HumanTaskRecord>("HumanTask", `${run.id}.${step.approval.task}`);
      if (task?.status !== "answered") throw new RuntimeError("INVARIANT", `${step.id} needs the approval task ${step.approval.task} answered; it is ${task?.status ?? "absent"}`);
    }
    const consequential = step.effect === "consequential";
    const all = (await this.store.list<InvocationRecord>("Invocation", { runId: run.id })).filter((i) => i.stepId === step.id && i.purpose === "step").sort((a, b) => a.ordinal - b.ordinal);
    let current = run;
    let last = all.at(-1);

    // Recovery (spec §6.3): an invocation left in `intent` means the previous worker died between deciding to call and recording the outcome.
    if (last?.status === "intent") {
      if (consequential) {
        last = await this.recordInvocation(current, last, { status: "uncertain", classification: "effect-unknown", cause: "outcome-not-recorded" }, "invocation.uncertain");
      } else {
        await this.recordInvocation(current, last, { status: "abandoned", cause: "outcome-not-recorded" }, "invocation.abandoned");
        last = undefined;
      }
      current = await this.load(run.id);
    }
    if (last?.status === "abandoned") last = undefined;

    if (!last) {
      const input = applyRules(step.input, current.data);
      const checked = fromJSONSchema(step.expects.input as never).validate(input);
      const ordinal = (all.at(-1)?.ordinal ?? 0) + 1;
      const base = {
        id: `${run.id}.${step.id}.${ordinal}`, runId: run.id, stepId: step.id, purpose: "step" as const, ordinal, dependency: dependency.id,
        effect: step.effect, inputDigest: digestOf(input as never), input: input as JsonValue, startedAt: this.iso()
      };
      const idempotencyKey = "wf1-" + digestOf({ run: run.id, step: step.id, ordinal, target: dependency.target, input } as never).replace(/^sha256:/, "");
      const startedAttempt = (await this.store.get<StepAttemptRecord>("StepAttempt", `${run.id}.${step.id}`)) === undefined;
      const attemptWrites: Write[] = startedAttempt ? [{ collection: "StepAttempt", id: `${run.id}.${step.id}`, value: { id: `${run.id}.${step.id}`, runId: run.id, stepId: step.id, kind: "capability", status: "started", startedAt: this.iso() } satisfies StepAttemptRecord, create: true }] : [];
      if (!checked.ok) {
        // Never sent: nothing can have happened.
        const rejected: InvocationRecord = { ...base, idempotencyKey, status: "failed", classification: "pre-effect", error: { code: "INPUT_INVALID", message: checked.issues.map((i) => i.message).join("; ") }, finishedAt: this.iso() };
        await this.store.commit([...attemptWrites, { collection: "Invocation", id: rejected.id, value: rejected, create: true }, this.runWrite(current, { leaseExpiresAt: this.lease() }), this.event(run.id, current.events + 1, "invocation.rejected", step.id, { code: "INPUT_INVALID" })]);
        current = await this.load(run.id);
        last = (await this.store.get<InvocationRecord>("Invocation", rejected.id))!;
      } else {
        const intent: InvocationRecord = { ...base, idempotencyKey, status: "intent" };
        await this.store.commit([...attemptWrites, { collection: "Invocation", id: intent.id, value: intent, create: true }, this.runWrite(current, { leaseExpiresAt: this.lease() }), this.event(run.id, current.events + 1, "invocation.intent", step.id, { invocation: intent.id, key: idempotencyKey, effect: step.effect })]);
        await this.options.hook?.("invoke:intent-recorded", { run: run.id, step: step.id });
        const result = await this.call(dependency, input as JsonValue, idempotencyKey, intent.id);
        await this.options.hook?.("invoke:returned", { run: run.id, step: step.id });
        current = await this.load(run.id);
        const outcome = this.classify(result, consequential);
        last = await this.recordInvocation(current, (await this.store.get<InvocationRecord>("Invocation", intent.id))!, outcome, `invocation.${outcome.status}`);
        current = await this.load(run.id);
        if (result.kind === "success") return this.afterSuccess(current, step, last, result);
      }
    } else if (last.status === "succeeded") {
      // A previous worker recorded the success and died before completing the step: nothing is called again.
      return this.afterSuccess(current, step, last, undefined);
    }

    const edge = last!.status === "uncertain" ? "uncertain" : "failure";
    return this.completeCapability(current, step, edge);
  }

  private async call(dependency: RecipeSource["requires"][number], input: JsonValue, idempotencyKey: string, requestId: string): Promise<GatewayResult> {
    try {
      return await this.options.gateway.invoke({ dependency, input, idempotencyKey, requestId });
    } catch (error) {
      // A gateway that throws gives no information about the effect.
      return { kind: "failed", code: "GATEWAY_ERROR", message: (error as Error).message.slice(0, 500) };
    }
  }

  /** Spec §6.3. Only a result that proves the provider was not entered is `pre-effect`; for a consequential step every other failure is `uncertain`. */
  private classify(result: GatewayResult, consequential: boolean): Pick<InvocationRecord, "status" | "classification" | "provider" | "output" | "error"> {
    switch (result.kind) {
      case "success":
        return { status: "succeeded", classification: "success", provider: result.provider as unknown as JsonValue, output: result.output };
      case "denied":
        return { status: "failed", classification: "pre-effect", error: { code: "DENIED", reason: result.reason, message: result.message } };
      case "unresolved":
        return { status: "failed", classification: "pre-effect", error: { code: "UNRESOLVED", message: result.reason } };
      case "rejected":
        return { status: "failed", classification: "pre-effect", error: { code: result.code, message: result.message } };
      case "failed":
        return consequential
          ? { status: "uncertain", classification: "effect-unknown", error: { code: result.code, message: result.message } }
          : { status: "failed", classification: "effect-unknown", error: { code: result.code, message: result.message } };
    }
  }

  private async recordInvocation(run: Versioned<RecipeRunRecord>, invocation: Versioned<InvocationRecord>, patch: Partial<InvocationRecord>, event: string): Promise<Versioned<InvocationRecord>> {
    const { __version, ...rest } = invocation;
    await this.store.commit([
      { collection: "Invocation", id: invocation.id, value: { ...rest, ...patch, finishedAt: this.iso() }, ifVersion: __version },
      this.runWrite(run, { leaseExpiresAt: this.lease() }),
      this.event(run.id, run.events + 1, event, invocation.stepId, { invocation: invocation.id, ...(patch.cause ? { cause: patch.cause } : {}) })
    ]);
    return (await this.store.get<InvocationRecord>("Invocation", invocation.id))!;
  }

  /** The invocation succeeded: observation steps take `success`; consequential steps first need verification to confirm the effect (spec §6.4). */
  private async afterSuccess(run: Versioned<RecipeRunRecord>, step: CapabilityStep, invocation: InvocationRecord, result: Extract<GatewayResult, { kind: "success" }> | undefined): Promise<boolean> {
    if (step.effect === "observation") return this.completeCapability(run, step, "success", invocation.output);
    const dependency = run.recipe.requires.find((d) => d.id === step.uses)!;
    const contractMethods = result ? result.verification : await this.contractMethods(dependency);
    const methods: Array<{ id: string; source: "contract" | "recipe"; probe: { capability?: string; uses?: string; input: Record<string, ValueRef> }; expect: StateExpectation[] }> = [
      ...contractMethods.map((m) => ({ id: m.id, source: "contract" as const, probe: { capability: m.via.capability, input: m.via.input }, expect: m.expect })),
      ...(step.verify?.additional ?? []).map((m: RecipeStateVerification) => ({ id: m.id, source: "recipe" as const, probe: { uses: m.via.uses, input: m.via.input }, expect: m.expect }))
    ];
    const verdict = await this.verify(run, step.id, methods, { input: invocation.input, output: invocation.output as JsonValue }, (dependency.target as { contract: string }).contract);
    if (verdict === "confirmed") return this.completeCapability(run, step, "success", invocation.output);
    return this.completeCapability(run, step, verdict === "contradicted" ? "failure" : "uncertain");
  }

  /** The contract's declared state methods, re-read when a resumed run no longer has the first call's result. */
  private async contractMethods(dependency: RecipeSource["requires"][number]) {
    const target = dependency.target as { contract: string; capability: string };
    const environment = await this.options.gateway.snapshot([dependency]);
    return declaredStateMethods(environment.contracts?.[target.contract], target.capability, dependency.versionConstraint);
  }

  private async completeCapability(run: Versioned<RecipeRunRecord>, step: CapabilityStep, edge: "success" | "failure" | "uncertain", output?: JsonValue): Promise<boolean> {
    const next = edge === "uncertain" ? step.on.uncertain : step.on[edge];
    if (!next) throw new RuntimeError("INVARIANT", `${step.id} has no ${edge} edge`);
    const at = this.iso();
    const attempt = await this.store.get<StepAttemptRecord>("StepAttempt", `${run.id}.${step.id}`);
    const writes: Write[] = [];
    if (attempt) {
      const { __version, ...rest } = attempt;
      writes.push({ collection: "StepAttempt", id: attempt.id, value: { ...rest, status: "completed", route: edge, next, finishedAt: at }, ifVersion: __version });
    }
    const data = edge === "success" && output !== undefined ? { ...run.data, steps: { ...run.data.steps, [step.id]: { output } } } : run.data;
    writes.push(this.runWrite(run, { currentStep: next, data, leaseExpiresAt: this.lease() }));
    writes.push(this.event(run.id, run.events + 1, "step.completed", step.id, { route: edge, next }));
    await this.store.commit(writes);
    await this.options.hook?.("step:committed", { run: run.id, step: step.id });
    return false;
  }

  // ------------------------------------------------------------------------------------------------ verification

  /**
   * Runs each method's probe through the gateway and judges its expectations (spec §6.4). Contradicted beats
   * inconclusive; success needs every method confirmed and at least one method. A recorded verification is reused, so a
   * resumed run does not re-judge what was already established.
   */
  private async verify(run: Versioned<RecipeRunRecord>, stepId: string, methods: Array<{ id: string; source: "contract" | "recipe" | "outcome"; probe: { capability?: string; uses?: string; input: Record<string, ValueRef> }; expect: StateExpectation[] }>, scope: { input: JsonValue; output: JsonValue }, contract?: string): Promise<Verdict> {
    if (!methods.length) {
      await this.recordVerification({ id: `${run.id}.${stepId}.none`, runId: run.id, stepId, methodId: "(none)", source: "contract", result: "inconclusive", checks: [], reason: "no verification method is declared, so nothing independent establishes the effect", at: this.iso() }, undefined);
      return "inconclusive";
    }
    const verdicts: Verdict[] = [];
    for (const method of methods) {
      const id = `${run.id}.${stepId}.${method.id}`;
      const recorded = await this.store.get<VerificationRecord>("Verification", id);
      if (recorded) {
        verdicts.push(recorded.result);
        continue;
      }
      // A contract's method names a capability of that contract; the recipe must declare a dependency on it to probe it.
      const dependency = method.probe.uses
        ? run.recipe.requires.find((d) => d.id === method.probe.uses)
        : run.recipe.requires.find((d) => (d.target as { contract: string; capability: string }).contract === contract && (d.target as { capability: string }).capability === method.probe.capability);
      let record: VerificationRecord;
      let probe: InvocationRecord | undefined;
      if (!dependency) {
        record = { id, runId: run.id, stepId, methodId: method.id, source: method.source, result: "inconclusive", checks: [], reason: `the recipe declares no dependency to probe ${method.probe.capability ?? method.probe.uses}`, at: this.iso() };
      } else {
        const input = Object.fromEntries(Object.entries(method.probe.input).map(([k, v]) => [k, this.valueOf(v, scope)])) as JsonValue;
        const key = "wf1-" + digestOf({ run: run.id, step: stepId, verification: method.id, input } as never).replace(/^sha256:/, "");
        const result = await this.call(dependency, input, key, `${id}.probe`);
        const at = this.iso();
        probe = {
          id: `${run.id}.${stepId}.v-${method.id}`, runId: run.id, stepId, purpose: "verification", ordinal: 1, dependency: dependency.id, effect: "observation",
          idempotencyKey: key, inputDigest: digestOf(input as never), input, startedAt: at, finishedAt: at,
          ...(result.kind === "success"
            ? { status: "succeeded" as const, classification: "success" as const, provider: result.provider as unknown as JsonValue, output: result.output }
            : { status: "failed" as const, classification: result.kind === "failed" ? ("effect-unknown" as const) : ("pre-effect" as const), error: { code: result.kind, message: "message" in result ? result.message : (result as { reason: string }).reason } })
        };
        if (result.kind !== "success") {
          record = { id, runId: run.id, stepId, methodId: method.id, source: method.source, result: "inconclusive", invocation: probe.id, checks: [], reason: `the probe did not return state (${result.kind}); nothing is established`, at };
        } else {
          const checks = method.expect.map((e) => {
            const actual = readPointer(result.output, e.at) as JsonValue | undefined;
            const expected = e.equals !== undefined ? this.valueOf(e.equals, scope) : undefined;
            const ok = e.equals !== undefined ? actual !== undefined && same(actual, expected) : e.exists ? actual !== undefined : true;
            return { at: e.at, ...(e.equals !== undefined ? { expected: expected as JsonValue } : { exists: true }), ...(actual !== undefined ? { actual } : {}), ok };
          });
          record = { id, runId: run.id, stepId, methodId: method.id, source: method.source, result: checks.every((c) => c.ok) ? "confirmed" : "contradicted", invocation: probe.id, checks: checks as JsonValue, at };
        }
      }
      await this.recordVerification(record, probe);
      verdicts.push(record.result);
    }
    if (verdicts.includes("contradicted")) return "contradicted";
    return verdicts.every((v) => v === "confirmed") ? "confirmed" : "inconclusive";
  }

  private async recordVerification(record: VerificationRecord, probe: InvocationRecord | undefined): Promise<void> {
    const writes: Write[] = [{ collection: "Verification", id: record.id, value: record, create: true }];
    if (probe) writes.push({ collection: "Invocation", id: probe.id, value: probe, create: true });
    await this.store.commit(writes);
  }

  private valueOf(ref: ValueRef, scope: { input: JsonValue; output: JsonValue }): JsonValue {
    if (!isValueRef(ref)) return ref as JsonValue;
    const value = "$input" in ref ? readPointer(scope.input, ref.$input) : readPointer(scope.output, ref.$output);
    return (value ?? null) as JsonValue;
  }

  // ------------------------------------------------------------------------------------------------ ends

  private async endStep(run: Versioned<RecipeRunRecord>, step: EndStep): Promise<boolean> {
    if (step.outcome !== "completed") {
      await this.finish(run, step.id, step.outcome);
      return true;
    }
    let output: Record<string, JsonValue>;
    try {
      output = applyRules(step.output ?? [], run.data);
      const checked = fromJSONSchema(run.recipe.outputs as never).validate(output);
      if (!checked.ok) throw new Error(checked.issues.map((i) => i.message).join("; "));
    } catch (error) {
      await this.finish(run, step.id, "failed", `the recipe outputs could not be built: ${(error as Error).message}`);
      return true;
    }
    // Outcome verification (spec §6.4): success is reported only when the independently observed state confirms it.
    const methods = run.recipe.outcome.verify.map((m) => ({ id: m.id, source: "outcome" as const, probe: { uses: m.via.uses, input: m.via.input }, expect: m.expect }));
    const consequential = run.recipe.steps.some((s) => s.kind === "capability" && s.effect === "consequential");
    const verdict = methods.length === 0 && !consequential ? "confirmed" : await this.verify(run, "outcome", methods, { input: run.input, output: output as JsonValue });
    if (verdict === "confirmed") await this.finish(run, step.id, "completed", undefined, output as JsonValue);
    else if (verdict === "contradicted") await this.finish(run, step.id, "failed", "outcome verification contradicted the recipe's declared outcome; the effect is treated as not having happened");
    else await this.finish(run, step.id, "uncertain", "outcome verification could not establish the declared outcome");
    return true;
  }

  // ------------------------------------------------------------------------------------------------ view

  private async view(runId: string): Promise<RunView> {
    const run = await this.load(runId);
    const by = <T extends { id: string }>(collection: "StepAttempt" | "Invocation" | "Verification" | "HumanTask") => this.store.list<T>(collection, { runId }).then(sorted);
    const [steps, invocations, verifications, tasks] = await Promise.all([by<StepAttemptRecord>("StepAttempt"), by<InvocationRecord>("Invocation"), by<VerificationRecord>("Verification"), by<HumanTaskRecord>("HumanTask")]);
    return {
      id: run.id, recipeId: run.recipeId, recipeDigest: run.recipeDigest, status: run.status,
      ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.endStep ? { endStep: run.endStep } : {}), ...(run.reason ? { reason: run.reason } : {}),
      currentStep: run.currentStep, ...(run.output !== undefined ? { output: run.output } : {}), principal: run.principal,
      interrupted: run.status === "running" && Boolean(run.leaseExpiresAt) && Date.parse(run.leaseExpiresAt!) <= this.now(),
      steps: steps.map((s) => ({ stepId: s.stepId, kind: s.kind, status: s.status, ...(s.route ? { route: s.route } : {}), ...(s.next ? { next: s.next } : {}) })),
      invocations: invocations.map((i) => ({ id: i.id, stepId: i.stepId, purpose: i.purpose, effect: i.effect, status: i.status, ...(i.classification ? { classification: i.classification } : {}), idempotencyKey: i.idempotencyKey, ...(i.provider ? { provider: i.provider } : {}), ...(i.cause ? { cause: i.cause } : {}), ...(i.error ? { error: i.error } : {}) })),
      verifications: verifications.map((v) => ({ stepId: v.stepId, methodId: v.methodId, source: v.source, result: v.result, ...(v.reason ? { reason: v.reason } : {}) })),
      tasks: tasks.map((t) => ({ stepId: t.stepId, role: t.role, approval: t.approval, status: t.status, ...(t.answeredBy ? { answeredBy: t.answeredBy } : {}), ...(t.response !== undefined ? { response: t.response } : {}), present: t.present })),
      events: run.events
    };
  }
}
