/**
 * Leases, worker takeover and human-task durability (spec/runtime-1.md §8, §9, §13). Only the current owner of a run may
 * make the authoritative transitions; an expired lease proves nothing about what an earlier worker's provider call did.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeRuntime, RuntimeError, type RuntimeAuthority, type RuntimePoint } from "../src/index.js";
import { accountingEnvironment } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";
import { AUTO, LARGE, MANAGER, ledgerState, onCleanup, recover, submits, tempDir, useCleanup } from "./support.js";
import { runWorker } from "./worker/spawn.js";

useCleanup();
const T = 180_000;

/** Two (or more) runtimes in this process over one home and one environment, sharing a controllable clock. */
async function pair(authority?: RuntimeAuthority) {
  const dir = tempDir();
  let clock = Date.parse("2026-10-21T10:00:00Z");
  const env = await accountingEnvironment(join(dir, "env"), supplierInvoice());
  onCleanup(() => env.close());
  const open = async (worker: string, hook?: (point: RuntimePoint, info: { step: string }) => void | Promise<void>) => {
    const rt = await RecipeRuntime.open({ home: join(dir, "runtime"), gateway: env.gateway, authority: authority ?? { canStart: () => true, canAnswer: () => true, canReconcile: () => true }, worker, leaseMs: 1000, now: () => clock, ...(hook ? { hook } : {}) });
    onCleanup(() => rt.close());
    return rt;
  };
  return { dir, env, open, advance: (ms: number) => (clock += ms) };
}

/** A hook that parks the worker at `point` until released, so another worker can act meanwhile. */
function gate(point: RuntimePoint, step: string) {
  let release!: () => void;
  let reached!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (reached = r));
  return { hook: async (p: RuntimePoint, info: { step: string }) => { if (p === point && info.step === step) { reached(); await open; } }, arrived, release };
}

describe("stale workers cannot overwrite authoritative state (§8)", () => {
  it("a worker that returns from the provider after its lease was taken over cannot record the outcome: the successor's record stands, and no second submission is made", async () => {
    const w = await pair();
    const g = gate("invoke:returned", "submit");
    const stale = await w.open("stale", g.hook);
    const successor = await w.open("successor");
    const staleStart = stale.start(supplierInvoice(), AUTO, "alice").catch((e) => e as RuntimeError);
    await g.arrived; // the stale worker's provider call has returned (the invoice is committed) and it has not recorded anything
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);

    w.advance(5_000); // its lease expires; this proves nothing about the provider call, which has in fact committed
    const id = (await successor.runs())[0]!.id;
    const taken = await successor.resume(id);
    expect(taken).toMatchObject({ outcome: "uncertain" });
    expect(submits(taken)[0]).toMatchObject({ status: "uncertain", cause: "outcome-not-recorded" });

    g.release();
    const result = await staleStart;
    expect(result).toBeInstanceOf(RuntimeError);
    expect((result as RuntimeError).code).toBe("CONFLICT"); // its write lost: it could not record success over the successor's uncertain
    const final = await successor.status(id);
    expect(submits(final)[0]).toMatchObject({ status: "uncertain" }); // not overwritten by the stale worker's success
    expect(final).toMatchObject({ outcome: "uncertain" });
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);
  }, T);

  it("a worker that is parked after recording a success cannot complete the step once another worker has: the run completes once", async () => {
    const w = await pair();
    const g = gate("invoke:outcome-recorded", "submit");
    const stale = await w.open("stale", g.hook);
    const successor = await w.open("successor");
    const staleStart = stale.start(supplierInvoice(), AUTO, "alice").catch((e) => e as RuntimeError);
    await g.arrived;
    w.advance(5_000);
    const id = (await successor.runs())[0]!.id;
    const done = await successor.resume(id);
    expect(done).toMatchObject({ outcome: "completed" });

    g.release();
    const lost = await staleStart;
    expect(lost).toBeInstanceOf(RuntimeError);
    expect((lost as RuntimeError).code).toBe("CONFLICT");
    const final = await successor.status(id);
    expect(final).toMatchObject({ outcome: "completed" });
    expect(final.steps.filter((s) => s.stepId === "submit")).toHaveLength(1);
    expect(submits(final)).toHaveLength(1);
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);
  }, T);

  it("a stale worker that resumes after takeover is refused while the successor holds the lease, and changes nothing once the run has finished", async () => {
    const w = await pair();
    const dead = await w.open("dead", (p, i) => { if (p === "step:committed" && i.step === "check-duplicate") throw new Error("simulated"); });
    await expect(dead.start(supplierInvoice(), AUTO, "alice")).rejects.toThrow("simulated");
    const id = (await dead.runs())[0]!.id;
    const successor = await w.open("successor");
    const stale = await w.open("stale");
    w.advance(5_000);
    const resumed = await successor.resume(id);
    expect(resumed).toMatchObject({ outcome: "completed" });
    expect(await stale.resume(id)).toMatchObject({ outcome: "completed" }); // reported, nothing written
    await expect(stale.answerTask(id, "request-approval", { decision: "approved" }, MANAGER)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);
  }, T);

  it("takeover alone never authorizes a repeat of an uncertain operation, with one worker or several racing", async () => {
    const dir = tempDir();
    const exit = await runWorker({ dir, command: "start", input: AUTO, worker: "doomed", killAt: { point: "invoke:returned", step: "submit" } });
    expect(exit.signal).toBe("SIGKILL");
    await new Promise((r) => setTimeout(r, 700)); // the dead worker's real lease (500 ms) runs out
    const id = await (async () => (await (await recover(dir)).rt.runs())[0]!.id)();
    const racers = await Promise.all([runWorker({ dir, command: "resume", runId: id, worker: "r1" }), runWorker({ dir, command: "resume", runId: id, worker: "r2" }), runWorker({ dir, command: "resume", runId: id, worker: "r3" })]);
    for (const r of racers) if (r.result && !r.result.ok) expect(["RUN_LEASED", "CONFLICT"]).toContain(r.result.code);
    expect(racers.some((r) => r.result?.ok)).toBe(true);
    const { rt } = await recover(dir);
    const final = await rt.status(id);
    expect(final).toMatchObject({ status: "finished", outcome: "uncertain" });
    expect(submits(final)).toHaveLength(1);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);
});

describe("human tasks are durable and their transitions are checked (§9)", () => {
  it("a process killed right after the task was created leaves a pending task that a new process can answer, once", async () => {
    const dir = tempDir();
    const exit = await runWorker({ dir, command: "start", input: LARGE, worker: "doomed", killAt: { point: "task:waiting" } });
    expect(exit.signal).toBe("SIGKILL");
    const { rt } = await recover(dir);
    const id = (await rt.runs())[0]!.id;
    const waiting = await rt.status(id);
    expect(waiting).toMatchObject({ status: "waiting", currentStep: "request-approval" });
    expect(waiting.tasks).toEqual([expect.objectContaining({ status: "pending", role: "role:ap-manager" })]);
    expect((await ledgerState(dir)).rows).toEqual([]);

    const answered = await runWorker({ dir, command: "answer", runId: id, step: "request-approval", response: { decision: "approved", comment: "fine" }, principal: MANAGER, worker: "answerer" });
    expect(answered.result).toMatchObject({ ok: true, view: { outcome: "completed", endStep: "submitted-approved" } });
    expect((await ledgerState(dir)).rows).toHaveLength(1);
    const again = await runWorker({ dir, command: "answer", runId: id, step: "request-approval", response: { decision: "approved" }, principal: MANAGER, worker: "answerer-2" });
    expect(again.result).toMatchObject({ ok: false, code: "TASK_NOT_PENDING" });
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("rejects an invalid answer without closing the task, honours authority as it is when the answer is given, and rejects answering after expiry (and expiry after an answer)", async () => {
    let allowed = true;
    const w = await pair({ canStart: () => true, canAnswer: (p, role) => allowed && p === MANAGER && role === "role:ap-manager", canReconcile: () => true });
    const rt = await w.open("w");
    const waiting = await rt.start(supplierInvoice(), LARGE, "alice");
    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "approved", extra: 1 }, MANAGER)).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    expect((await rt.status(waiting.id)).tasks[0]).toMatchObject({ status: "pending" }); // still answerable
    allowed = false; // the approver's authority was withdrawn while the run waited
    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "approved" }, MANAGER)).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    expect(await rt.status(waiting.id)).toMatchObject({ status: "waiting" });
    allowed = true;
    expect(await rt.expireTask(waiting.id, "request-approval", MANAGER)).toMatchObject({ outcome: "failed", endStep: "approval-unanswered" });
    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "approved" }, MANAGER)).rejects.toMatchObject({ code: "TASK_NOT_PENDING" });

    const second = await rt.start(supplierInvoice(), { ...LARGE, invoiceNumber: "INV-3" }, "alice");
    await rt.answerTask(second.id, "request-approval", { decision: "rejected" }, MANAGER);
    await expect(rt.expireTask(second.id, "request-approval", MANAGER)).rejects.toMatchObject({ code: "TASK_NOT_PENDING" });
    expect((await ledgerState(w.dir)).rows).toEqual([]);
  }, T);

  it("two answers racing, and an answer racing an expiry, leave one consistent outcome: exactly one transition, and task state agrees with run state", async () => {
    const w = await pair();
    const a = await w.open("a");
    const b = await w.open("b");
    for (let i = 0; i < 4; i++) {
      const run = await a.start(supplierInvoice(), { ...LARGE, invoiceNumber: `INV-R${i}` }, "alice");
      const race = i % 2 === 0
        ? await Promise.allSettled([a.answerTask(run.id, "request-approval", { decision: "approved" }, MANAGER), b.answerTask(run.id, "request-approval", { decision: "approved" }, MANAGER)])
        : await Promise.allSettled([a.answerTask(run.id, "request-approval", { decision: "approved" }, MANAGER), b.expireTask(run.id, "request-approval", MANAGER)]);
      expect(race.filter((r) => r.status === "fulfilled"), `race ${i}`).toHaveLength(1);
      for (const r of race) if (r.status === "rejected") expect(["CONFLICT", "TASK_NOT_PENDING"]).toContain((r.reason as RuntimeError).code);
      const final = await a.status(run.id);
      expect(final.status).toBe("finished");
      const task = final.tasks[0]!;
      if (task.status === "answered") expect(final.outcome).toBe("completed");
      else expect(final).toMatchObject({ outcome: "failed", endStep: "approval-unanswered" });
      const rows = (await ledgerState(w.dir)).rows.filter((r) => r.invoiceNumber === `INV-R${i}`);
      expect(rows).toHaveLength(task.status === "answered" ? 1 : 0); // an approved invoice exists exactly once; an expired one never
    }
  }, T);
});

describe("a runtime home created by an earlier release opens under this flow (additive changes only)", () => {
  it.each(["feltdb.flow.v1", "feltdb.flow.v2"])("deploys the current flow over %s without destroying anything, and runs", async (fixture) => {
    const { createFeltDB, parseFlowSpec } = (await import("@feltdb/core")) as unknown as { createFeltDB: typeof import("@feltdb/core").createFeltDB; parseFlowSpec: typeof import("@feltdb/core").parseFlowSpec };
    const { readFileSync, mkdirSync } = await import("node:fs");
    const dir = tempDir();
    mkdirSync(join(dir, "runtime", "state"), { recursive: true });
    const old = createFeltDB({ namespace: "appworks-recipe-runtime", mode: "local", path: join(dir, "runtime", "state") });
    await old.deployFlowSpec(parseFlowSpec(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8")), 0);
    await old.close();

    const env = await accountingEnvironment(join(dir, "env"), supplierInvoice());
    onCleanup(() => env.close());
    const rt = await RecipeRuntime.open({ home: join(dir, "runtime"), gateway: env.gateway });
    onCleanup(() => rt.close());
    expect(await rt.start(supplierInvoice(), AUTO, "alice")).toMatchObject({ outcome: "completed" });
  }, T);
});
