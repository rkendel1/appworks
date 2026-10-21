/**
 * Crash-recovery, reconciliation and idempotency conformance for the recipe runtime (spec/runtime-1.md §13). Workers are
 * real OS processes killed with SIGKILL at the named point; what happened is read from the ledger's own database, never
 * from a capability response. The central invariant: a consequential invocation that may have occurred is never
 * submitted again, and success is reported only when independent state supports it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeRuntime, RuntimeError } from "../src/index.js";
import { OperationRefused, Ledger } from "./accounting/ledger.js";
import { BOOKS_NAMES, accountingEnvironment } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";
import { AUTO, full, ledgerPath, ledgerState, recover, submits, tempDir, useCleanup } from "./support.js";
import { runWorker } from "./worker/spawn.js";
import type { WorkerSpec } from "./worker/worker.js";

useCleanup();
const T = 180_000;

/** Starts a recipe in a worker that dies by SIGKILL at `kill`, and returns the directory it left behind. */
async function crash(kill: Partial<WorkerSpec>, input: unknown = AUTO) {
  const dir = tempDir();
  const exit = await runWorker({ dir, command: "start", input, worker: "doomed", ...kill });
  return { dir, exit };
}
const runIdOf = async (dir: string) => {
  const { rt } = await recover(dir);
  return (await rt.runs())[0]?.id;
};

describe("crash-boundary matrix: every durable transition around a consequential invocation (§13)", () => {
  // Each case: where the process dies, how many invoices exist when it has died (independent), and what the successor does.
  const cases: Array<{
    id: string;
    boundary: string;
    kill: Partial<WorkerSpec>;
    effectsAtDeath: number;
    afterResume?: { outcome: string; endStep?: string; submitStatus?: string; cause?: string };
    noRun?: boolean;
  }> = [
    { id: "B1", boundary: "before run creation", kill: { killAt: { point: "run:starting" } }, effectsAtDeath: 0, noRun: true },
    { id: "B2", boundary: "run created, first step not begun", kill: { killAt: { point: "run:created" } }, effectsAtDeath: 0, afterResume: { outcome: "completed", submitStatus: "succeeded" } },
    { id: "B4a", boundary: "invocation prepared, never dispatched", kill: { killAt: { point: "invoke:prepared", step: "submit" } }, effectsAtDeath: 0, afterResume: { outcome: "completed", submitStatus: "succeeded" } },
    { id: "B4b", boundary: "intent recorded, dispatch may or may not have started", kill: { killAt: { point: "invoke:intent-recorded", step: "submit" } }, effectsAtDeath: 0, afterResume: { outcome: "uncertain", endStep: "submission-uncertain", submitStatus: "uncertain", cause: "outcome-not-recorded" } },
    { id: "B6", boundary: "provider entered, died before its write committed", kill: { ledgerKillAt: "before-commit" }, effectsAtDeath: 0, afterResume: { outcome: "uncertain", endStep: "submission-uncertain", submitStatus: "uncertain", cause: "outcome-not-recorded" } },
    { id: "B7", boundary: "provider committed, died before responding", kill: { ledgerKillAt: "after-commit" }, effectsAtDeath: 1, afterResume: { outcome: "uncertain", endStep: "submission-uncertain", submitStatus: "uncertain", cause: "outcome-not-recorded" } },
    { id: "B8", boundary: "response received, outcome not recorded", kill: { killAt: { point: "invoke:returned", step: "submit" } }, effectsAtDeath: 1, afterResume: { outcome: "uncertain", endStep: "submission-uncertain", submitStatus: "uncertain", cause: "outcome-not-recorded" } },
    { id: "B9", boundary: "outcome recorded, step not completed", kill: { killAt: { point: "invoke:outcome-recorded", step: "submit" } }, effectsAtDeath: 1, afterResume: { outcome: "completed", submitStatus: "succeeded" } },
    { id: "B10", boundary: "step completed, next step not begun", kill: { killAt: { point: "step:committed", step: "submit" } }, effectsAtDeath: 1, afterResume: { outcome: "completed", submitStatus: "succeeded" } },
    { id: "B11", boundary: "outcome verified, terminal state not committed", kill: { killAt: { point: "verify:completed", step: "outcome" } }, effectsAtDeath: 1, afterResume: { outcome: "completed", submitStatus: "succeeded" } },
    { id: "B12", boundary: "immediately after the terminal commit", kill: { killAt: { point: "run:finished" } }, effectsAtDeath: 1, afterResume: { outcome: "completed", submitStatus: "succeeded" } }
  ];

  it.each(cases)("$id: $boundary", async (c) => {
    const { dir, exit } = await crash(c.kill);
    expect(exit.signal, `the worker must die by SIGKILL, not exit (${exit.stderr.slice(0, 300)})`).toBe("SIGKILL");
    expect(exit.result).toBeUndefined(); // it never got to report anything

    const before = await ledgerState(dir);
    expect(before.rows).toHaveLength(c.effectsAtDeath);
    const { rt } = await recover(dir);
    const runs = await rt.runs();
    if (c.noRun) {
      expect(runs).toEqual([]);
      return;
    }
    expect(runs).toHaveLength(1);
    const id = runs[0]!.id;
    const keyBefore = submits(await rt.status(id))[0]?.idempotencyKey;

    const resumed = await rt.resume(id);
    expect(resumed).toMatchObject({ status: "finished", outcome: c.afterResume!.outcome, ...(c.afterResume!.endStep ? { endStep: c.afterResume!.endStep } : {}) });

    // The effect count is never more than one, whatever the boundary: nothing was submitted a second time.
    const after = await ledgerState(dir);
    expect(after.rows.length).toBeLessThanOrEqual(1);
    if (c.afterResume!.outcome === "completed") expect(after.rows).toHaveLength(1);
    else expect(after.rows).toHaveLength(c.effectsAtDeath); // recovery added nothing

    const submit = submits(resumed);
    expect(submit).toHaveLength(1); // one logical invocation, never a second ordinal
    expect(submit[0]).toMatchObject({ status: c.afterResume!.submitStatus, ...(c.afterResume!.cause ? { cause: c.afterResume!.cause } : {}) });
    if (keyBefore) expect(submit[0]!.idempotencyKey).toBe(keyBefore); // the resumed logical invocation kept its identity
    if (after.rows[0] && c.afterResume!.outcome === "completed") expect(after.rows[0].idempotencyKey).toBe(submit[0]!.idempotencyKey);
  }, T);

  it("B11/B12 recovery reuses recorded verifications and a finished run is not re-run", async () => {
    const { dir } = await crash({ killAt: { point: "verify:completed", step: "outcome" } });
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    const done = await rt.resume(id);
    expect(done.verifications.map((v) => v.methodId).sort()).toEqual(["invoice-number-recorded", "invoice-recorded", "ledger-holds-invoice"]); // three, not six
    expect(await rt.resume(id)).toMatchObject({ outcome: "completed" });
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);
});

describe("an intent proves nothing; a prepared invocation proves non-dispatch (§6.3)", () => {
  it("a worker killed after `prepared` provably never called the provider, so the successor dispatches the same invocation with the same key", async () => {
    const { dir } = await crash({ killAt: { point: "invoke:prepared", step: "submit" } });
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    const before = await rt.status(id);
    expect(submits(before)).toEqual([expect.objectContaining({ status: "prepared" })]);
    const done = await rt.resume(id);
    expect(done).toMatchObject({ outcome: "completed" });
    expect(submits(done)[0]!.idempotencyKey).toBe(submits(before)[0]!.idempotencyKey);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("a worker killed after `intent` stays uncertain even though the ledger proves nothing was written: an intent record is not proof of dispatch, and its absence of a result is not proof of non-execution", async () => {
    const { dir } = await crash({ killAt: { point: "invoke:intent-recorded", step: "submit" } });
    expect((await ledgerState(dir)).rows).toEqual([]);
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    expect(await rt.resume(id)).toMatchObject({ outcome: "uncertain" });
    expect((await ledgerState(dir)).rows).toEqual([]);
  }, T);

  it("authorization is rechecked before the invocation that is actually made: a grant revoked after `prepared` stops the dispatch, and nothing reaches the provider", async () => {
    const { dir } = await crash({ killAt: { point: "invoke:prepared", step: "submit" } });
    const { rt, env } = await recover(dir);
    await env.revoke("com.example.ledger", "submit");
    const id = (await rt.runs())[0]!.id;
    const done = await rt.resume(id);
    expect(done).toMatchObject({ outcome: "failed", endStep: "submission-failed" });
    expect(submits(done)[0]).toMatchObject({ status: "failed", classification: "pre-effect", error: { code: "DENIED" } });
    expect((await ledgerState(dir)).rows).toEqual([]);
  }, T);
});

describe("reconciliation of an uncertain operation (§6.5)", () => {
  it("confirms completion: the invoice the lost response described exists, is verified independently, and the run completes without a second submission", async () => {
    const { dir } = await crash({ ledgerKillAt: "after-commit" });
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    const uncertain = await rt.resume(id);
    expect(uncertain).toMatchObject({ outcome: "uncertain" });
    const key = submits(uncertain)[0]!.idempotencyKey;

    const done = await rt.reconcile(id, "operator");
    expect(done).toMatchObject({ status: "finished", outcome: "completed", endStep: "submitted", output: { invoiceId: "inv-1", status: "submitted", approval: "automatic" } });
    expect(done.reconciliations).toEqual([expect.objectContaining({ operationKey: key, resolution: "confirmed-completed", by: "operator" })]);
    expect(submits(done)).toEqual([expect.objectContaining({ status: "succeeded", cause: "reconciled", idempotencyKey: key })]);
    // success was verified against the ledger after the lookup, and again for the outcome
    expect(done.verifications.filter((v) => v.result === "confirmed").map((v) => `${v.stepId}:${v.methodId}`).sort()).toEqual([
      "outcome:ledger-holds-invoice", "submit.reconciliation-1:invoice-number-recorded", "submit.reconciliation-1:invoice-recorded"
    ]);
    const ledger = await ledgerState(dir);
    expect(ledger.rows).toHaveLength(1); // the original; reconciliation submitted nothing
    expect(ledger.rows[0]!.idempotencyKey).toBe(key);
    expect(ledger.fenced).toEqual([]); // a recorded operation is never fenced
  }, T);

  it("confirms non-execution when the provider reports the key absent, strongly consistent and fenced: the run fails, and a late arrival of the original is refused", async () => {
    const { dir } = await crash({ ledgerKillAt: "before-commit" });
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    const key = submits(await rt.resume(id))[0]!.idempotencyKey;

    const done = await rt.reconcile(id, "operator");
    expect(done).toMatchObject({ status: "finished", outcome: "failed", endStep: "submission-failed" });
    expect(done.reconciliations).toEqual([expect.objectContaining({ resolution: "confirmed-not-executed" })]);
    expect(submits(done)[0]).toMatchObject({ status: "failed", cause: "reconciled-not-executed" });
    const ledger = await ledgerState(dir);
    expect(ledger.rows).toEqual([]);
    expect(ledger.fenced).toEqual([key]);

    // The original request, delayed in the network, now arrives. It must not be executed.
    const late = Ledger.open(ledgerPath(dir));
    try {
      await expect(late.submit({ ...AUTO } as never, key)).rejects.toBeInstanceOf(OperationRefused);
    } finally {
      await late.close();
    }
    expect((await ledgerState(dir)).rows).toEqual([]);
  }, T);

  it("stays uncertain when absence is not conclusive (an eventually consistent lookup), and nothing is fenced, assumed or submitted", async () => {
    const { dir } = await crash({ ledgerKillAt: "before-commit" });
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    await rt.resume(id);
    const eventual = await runWorker({ dir, command: "reconcile", runId: id, worker: "recon-1", eventual: true });
    expect(eventual.result).toMatchObject({ ok: true, view: { outcome: "uncertain", reconciliations: [expect.objectContaining({ resolution: "indeterminate", reason: expect.stringContaining("not found") })] } });
    expect((await ledgerState(dir)).fenced).toEqual([]);
    expect((await ledgerState(dir)).rows).toEqual([]);
    // Later, with a lookup that can answer, the same run can still be resolved: the earlier attempt is history, not a verdict.
    const done = await rt.reconcile(id, "operator");
    expect(done).toMatchObject({ outcome: "failed" });
    expect(done.reconciliations.map((r) => r.resolution)).toEqual(["indeterminate", "confirmed-not-executed"]);
  }, T);

  it("does not declare success when the recorded operation fails independent verification: the ledger row exists but contradicts the request", async () => {
    const { dir } = await crash({ ledgerKillAt: "after-commit" });
    const tamper = Ledger.open(ledgerPath(dir));
    await tamper.tamper("inv-1", { invoiceNumber: "SOMETHING-ELSE" });
    await tamper.close();
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    await rt.resume(id);
    const view = await rt.reconcile(id, "operator");
    expect(view).toMatchObject({ outcome: "uncertain" });
    expect(view.reconciliations).toEqual([expect.objectContaining({ resolution: "indeterminate", reason: expect.stringContaining("contradicted") })]);
  }, T);

  it("preserves uncertainty when the lookup cannot be made (no grant for it), and checks authority and applicability first", async () => {
    const { dir } = await crash({ ledgerKillAt: "after-commit" });
    const { rt, env } = await recover(dir, { authority: { canStart: () => true, canAnswer: () => true } });
    const id = (await rt.runs())[0]!.id;
    await rt.resume(id);
    await expect(rt.reconcile(id, "operator")).rejects.toMatchObject({ code: "AUTHORITY_DENIED" }); // no canReconcile: nobody may

    const { rt: allowed } = await recover(dir, { authority: full, worker: "reconciler" });
    await env.close();
    const denied = await recover(dir, { authority: full, worker: "ungranted" });
    await denied.env.grants.revoke({ consumerId: denied.env.consumer.id, providerId: "com.example.ledger", capabilityName: "ledger.resolve", capabilityVersion: 1 });
    const view = await denied.rt.reconcile(id, "operator");
    expect(view).toMatchObject({ outcome: "uncertain" });
    expect(view.reconciliations[0]).toMatchObject({ resolution: "indeterminate", reason: expect.stringContaining("lookup did not return") });
    expect((await ledgerState(dir)).rows).toHaveLength(1);

    // Applicability: a completed run, and a run that is uncertain for another reason, are not reconcilable.
    const fresh = await allowed.start(supplierInvoice(), { ...AUTO, invoiceNumber: "INV-5" }, "alice");
    await expect(allowed.reconcile(fresh.id, "operator")).rejects.toMatchObject({ code: "NOT_RECONCILABLE" });
  }, T);

  it("lets exactly one of two concurrent reconcilers change the run, in one process or two", async () => {
    const { dir } = await crash({ ledgerKillAt: "after-commit" });
    const { rt, open } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    await rt.resume(id);

    const other = await open("reconciler-2");
    const inProcess = await Promise.allSettled([rt.reconcile(id, "a"), other.reconcile(id, "b")]);
    expect(inProcess.filter((r) => r.status === "fulfilled" && r.value.outcome === "completed")).toHaveLength(1);
    for (const r of inProcess) if (r.status === "rejected") expect(["CONFLICT", "NOT_RECONCILABLE"]).toContain((r.reason as RuntimeError).code);
    const view = await rt.status(id);
    expect(view.reconciliations.filter((r) => r.resolution === "confirmed-completed")).toHaveLength(1);
    expect((await ledgerState(dir)).rows).toHaveLength(1);

    // Two real processes racing for another uncertain run.
    const second = await crash({ ledgerKillAt: "after-commit" }, { ...AUTO, invoiceNumber: "INV-6" });
    const { rt: rt2 } = await recover(second.dir);
    const id2 = (await rt2.runs())[0]!.id;
    await rt2.resume(id2);
    const exits = await Promise.all([runWorker({ dir: second.dir, command: "reconcile", runId: id2, worker: "p1" }), runWorker({ dir: second.dir, command: "reconcile", runId: id2, worker: "p2" })]);
    const winners = exits.filter((e) => e.result?.ok && e.result.view.outcome === "completed");
    expect(winners).toHaveLength(1);
    for (const e of exits) if (e.result && !e.result.ok) expect(["CONFLICT", "NOT_RECONCILABLE"]).toContain(e.result.code);
    const final = await rt2.status(id2);
    expect(final).toMatchObject({ outcome: "completed" });
    expect(final.reconciliations.filter((r) => r.resolution === "confirmed-completed")).toHaveLength(1);
    expect((await ledgerState(second.dir)).rows).toHaveLength(1);
  }, T);
});

describe("idempotency and operation identity (§6.2)", () => {
  it("the ledger rejects a reused key with different input, replays the same input, and never executes a second invoice", async () => {
    const dir = tempDir();
    const recipe = supplierInvoice();
    const env = await accountingEnvironment(join(dir, "env"), recipe);
    const dependency = recipe.requires.find((d) => d.id === "submit-invoice")!;
    const call = (input: object) => env.gateway.invoke({ dependency, input: input as never, idempotencyKey: "wf1-shared-key", requestId: "r" });
    const { purchaseOrder: _po, ...first } = AUTO;
    const a = await call(first);
    const replay = await call(first);
    const reused = await call({ ...first, amount: 999 });
    await env.close();
    expect(a).toMatchObject({ kind: "success" });
    expect(replay).toMatchObject({ kind: "success", output: (a as { output: unknown }).output });
    expect(reused.kind).toBe("failed"); // refused as a different request with the same key
    const ledger = await ledgerState(dir);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ amount: 120 });
  }, T);

  it("different logical operations never share a key, and a retried observation is a new operation with a new key", async () => {
    const dir = tempDir();
    const { rt } = await recover(dir);
    const runs = await Promise.all([rt.start(supplierInvoice(), AUTO, "alice"), rt.start(supplierInvoice(), { ...AUTO, invoiceNumber: "INV-7" }, "alice")]);
    const keys = runs.flatMap((r) => r.invocations.filter((i) => i.purpose === "step").map((i) => i.idempotencyKey));
    expect(new Set(keys).size).toBe(keys.length);
    const crashed = await crash({ killAt: { point: "invoke:returned", step: "check-duplicate" } });
    const { rt: rt2 } = await recover(crashed.dir);
    const done = await rt2.resume((await rt2.runs())[0]!.id);
    const lookups = done.invocations.filter((i) => i.stepId === "check-duplicate");
    expect(lookups.map((l) => l.status)).toEqual(["abandoned", "succeeded"]);
    expect(lookups[0]!.idempotencyKey).not.toBe(lookups[1]!.idempotencyKey);
  }, T);

  it("verification goes through the canonical contract: with a provider that names everything differently, the probes still resolve the canonical `invoice.get`", async () => {
    const dir = tempDir();
    const env = await accountingEnvironment(join(dir, "env"), supplierInvoice(), [{ id: "com.globex.books", names: BOOKS_NAMES }]);
    const rt = await RecipeRuntime.open({ home: `${dir}/runtime`, gateway: env.gateway, authority: full });
    const run = await rt.start(supplierInvoice(), AUTO, "alice");
    await rt.close();
    await env.close();
    expect(run).toMatchObject({ outcome: "completed" });
    const probes = run.invocations.filter((i) => i.purpose === "verification");
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((p) => (p.provider as { capability: { name: string } }).capability.name === "books.fetch")).toBe(true);
    expect(run.verifications.every((v) => v.result === "confirmed")).toBe(true);
  }, T);
});

