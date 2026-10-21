/**
 * Recovery of a recorded result whose verification settled nothing (spec/runtime-1.md §3.1, §6.6). The invariant: a recorded
 * invocation result is not proof of the business outcome, and verification is recovered on its own: the consequential
 * invocation is never repeated because its outcome has not yet been verified. Effects are read from the ledger's own database.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecipeRuntime, RuntimeError, type RuntimePoint } from "../src/index.js";
import { accountingEnvironment } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";
import { AUTO, full, ledgerState, onCleanup, recover, submits, tempDir, useCleanup } from "./support.js";
import { runWorker } from "./worker/spawn.js";

useCleanup();
const T = 240_000;
const UNAVAILABLE = { read: "unavailable" } as const;

/** Starts a recipe in a worker process whose ledger reads fail (or that dies at `killAt`), leaving the directory behind. */
async function start(extra: Parameters<typeof runWorker>[0] extends infer S ? Partial<S> : never = {}, input: unknown = AUTO) {
  const dir = tempDir();
  const exit = await runWorker({ dir, command: "start", input, worker: "starter", ledgerFaults: UNAVAILABLE, ...extra } as never);
  return { dir, exit };
}
const idOf = async (dir: string) => (await (await recover(dir)).rt.runs())[0]!.id;
const methodResults = (view: { verifications: Array<{ stepId: string; methodId: string; result: string }> }, stepId: string, methodId: string) =>
  view.verifications.filter((v) => v.stepId === stepId && v.methodId === methodId).map((v) => v.result);

describe("the gap, represented: a recorded result with unresolved verification is not an unknown outcome (§3.1)", () => {
  it("is reported as recorded-unverified, not as a lost invocation and not as failed; the evidence says why", async () => {
    const { dir, exit } = await start();
    expect(exit.result).toMatchObject({ ok: true, view: { status: "finished", outcome: "uncertain", endStep: "submission-uncertain" } });
    const { rt } = await recover(dir);
    const view = await rt.status(await idOf(dir));
    expect(submits(view)).toEqual([expect.objectContaining({ status: "succeeded" })]); // the result IS recorded
    expect(view.assessment).toMatchObject({ state: "recorded-unverified", step: "submit", rechecks: 0 });
    expect(view.assessment.evidence.length).toBeGreaterThan(0);
    expect(view.assessment.evidence.every((e) => e.result === "inconclusive" && e.reason?.includes("nothing is established"))).toBe(true);
    expect(view.assessment.next).toContain("recipe reconcile");
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("keeps the four situations apart: unknown outcome, recorded-unverified, verified, and unexpected", async () => {
    // unknown invocation outcome
    const lost = await start({ ledgerKillAt: "after-commit", ledgerFaults: undefined, killAt: undefined });
    const a = await recover(lost.dir);
    const unknown = await a.rt.resume(await idOf(lost.dir));
    expect(unknown.assessment.state).toBe("invocation-outcome-unknown");
    // verified
    const ok = await runWorker({ dir: tempDir(), command: "start", input: AUTO, worker: "w" });
    expect(ok.result).toMatchObject({ ok: true, view: { assessment: { state: "verified" } } });
    // unexpected
    const bad = await runWorker({ dir: tempDir(), command: "start", input: AUTO, worker: "w", ledgerFaults: { tamperOnCommit: { invoiceNumber: "WRONG" } } });
    expect(bad.result).toMatchObject({ ok: true, view: { outcome: "failed", assessment: { state: "business-outcome-unexpected" } } });
  }, T);
});

describe("test 1: recorded result, verification unavailable, process killed, verification restored", () => {
  it("a worker killed after verification found nothing, resumed in a fresh process once reads work, completes without a second invocation, keeping the inconclusive attempt as history", async () => {
    const { dir, exit } = await start({ killAt: { point: "verify:completed", step: "submit" } });
    expect(exit.signal).toBe("SIGKILL");
    expect((await ledgerState(dir)).rows).toHaveLength(1);

    const { rt } = await recover(dir); // a fresh process's view, with a healthy ledger
    const id = await idOf(dir);
    const before = await rt.status(id);
    expect(before).toMatchObject({ status: "running", interrupted: true }); // suspended and recoverable: not terminal
    expect(submits(before)).toEqual([expect.objectContaining({ status: "succeeded" })]);
    const key = submits(before)[0]!.idempotencyKey;

    const done = await rt.resume(id);
    expect(done).toMatchObject({ status: "finished", outcome: "completed", output: { invoiceId: "inv-1" } });
    expect(done.assessment.state).toBe("verified");
    expect(submits(done)).toEqual([expect.objectContaining({ status: "succeeded", idempotencyKey: key })]); // one invocation, same identity
    expect(methodResults(done, "submit", "invoice-recorded")).toEqual(["inconclusive", "confirmed"]); // the failed attempt is history
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("without a crash: the run ends uncertain, and `reconcile` re-verifies once reads work, completes, and never invokes", async () => {
    const { dir } = await start();
    const { rt } = await recover(dir);
    const id = await idOf(dir);
    const before = submits(await rt.status(id))[0]!;
    const done = await rt.reconcile(id, "operator");
    expect(done).toMatchObject({ status: "finished", outcome: "completed", endStep: "submitted", output: { invoiceId: "inv-1", status: "submitted", approval: "automatic" } });
    expect(done.assessment).toMatchObject({ state: "verified", rechecks: 1 });
    expect(submits(done)).toEqual([expect.objectContaining({ id: before.id, idempotencyKey: before.idempotencyKey, status: "succeeded" })]);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("recovers an outcome-level verification the same way: only the outcome check is repeated, the step's confirmed verification is not", async () => {
    const dir = tempDir();
    // Reads fail only after the step has been verified, so the recipe's final outcome verification is what settles nothing.
    const { rt, env } = await recover(dir, { now: () => Date.now(), hook: (p: RuntimePoint, i: { step: string }) => { if (p === "step:committed" && i.step === "submit") env.ledger.faults.read = "unavailable"; } });
    const run = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ outcome: "uncertain", endStep: "submitted" }); // the recipe's own `completed` end, not reached as success
    expect(run.assessment).toMatchObject({ state: "recorded-unverified", evidence: [expect.objectContaining({ stepId: "outcome", result: "inconclusive" })] });

    env.ledger.faults.read = undefined;
    const done = await rt.reconcile(run.id, "operator");
    expect(done).toMatchObject({ outcome: "completed", endStep: "submitted", output: { invoiceId: "inv-1" } });
    expect(methodResults(done, "outcome", "ledger-holds-invoice")).toEqual(["inconclusive", "confirmed"]);
    expect(methodResults(done, "submit", "invoice-recorded")).toEqual(["confirmed"]); // not redone
    expect(submits(done)).toHaveLength(1);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);
});

describe("test 2: verification stays inconclusive", () => {
  it("remains explicitly unresolved across repeated recoveries in separate processes, never succeeds or fails, and never adds a second effect", async () => {
    const { dir } = await start();
    const id = await idOf(dir);
    for (const [n, fault] of [[1, "lagging"], [2, "unavailable"]] as const) {
      const exit = await runWorker({ dir, command: "reconcile", runId: id, worker: `recovery-${n}`, ledgerFaults: { read: fault } });
      expect(exit.result).toMatchObject({ ok: true, view: { status: "finished", outcome: "uncertain", assessment: { state: "recorded-unverified", rechecks: n } } });
      expect((await ledgerState(dir)).rows).toHaveLength(1);
    }
    const { rt } = await recover(dir);
    const view = await rt.status(id);
    expect(submits(view)).toHaveLength(1);
    expect(methodResults(view, "submit", "invoice-recorded")).toEqual(["inconclusive", "inconclusive", "inconclusive"]); // each attempt kept, none a verdict
    expect(view.assessment.evidence.length).toBeGreaterThan(0);
    // Finally the evidence arrives.
    expect(await rt.reconcile(id, "operator")).toMatchObject({ outcome: "completed", assessment: { state: "verified", rechecks: 3 } });
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("rechecks the current authority: a withdrawn read grant leaves it inconclusive with the reason, and restoring it lets recovery finish", async () => {
    const { dir } = await start();
    const { rt, env } = await recover(dir);
    const id = await idOf(dir);
    await env.revoke("com.example.ledger", "get");
    const denied = await rt.reconcile(id, "operator");
    expect(denied.assessment.state).toBe("recorded-unverified");
    expect(denied.assessment.evidence.some((e) => e.reason?.includes("denied"))).toBe(true);
    await env.grantAll("com.example.ledger");
    expect(await rt.reconcile(id, "operator")).toMatchObject({ outcome: "completed" });
    const { rt: nobody } = await recover(dir, { authority: { canStart: () => true, canAnswer: () => true } });
    await expect(nobody.reconcile(id, "x")).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  }, T);
});

describe("test 3: killed after verification returned, before it was durably committed", () => {
  it("probe returned but not recorded: the probe is repeated (an observation, safe), the invocation is not", async () => {
    const { dir, exit } = await start({ ledgerFaults: undefined, killAt: { point: "verify:probe-returned", step: "submit" } });
    expect(exit.signal).toBe("SIGKILL");
    const { rt } = await recover(dir);
    const id = await idOf(dir);
    const done = await rt.resume(id);
    expect(done).toMatchObject({ outcome: "completed" });
    expect(submits(done)).toHaveLength(1);
    expect(methodResults(done, "submit", "invoice-recorded")).toEqual(["confirmed"]); // one record: the lost probe left none
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("verification recorded as confirmed but the step not committed: the finding is reused, nothing is probed or invoked again", async () => {
    const { dir, exit } = await start({ ledgerFaults: undefined, killAt: { point: "verify:completed", step: "submit" } });
    expect(exit.signal).toBe("SIGKILL");
    const { rt } = await recover(dir);
    const id = await idOf(dir);
    const before = await rt.status(id);
    const probesBefore = before.invocations.filter((i) => i.purpose === "verification").length;
    const done = await rt.resume(id);
    expect(done).toMatchObject({ outcome: "completed" });
    expect(submits(done)).toHaveLength(1);
    // the step's two confirmed verifications were reused: only the outcome verification added probes
    expect(done.invocations.filter((i) => i.purpose === "verification" && i.stepId === "submit")).toHaveLength(probesBefore);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);
});

describe("test 4: an unexpected business outcome is neither success nor safe non-execution", () => {
  it("a provider that answers success while the ledger holds something else ends failed-as-unexpected, keeps the invoice, and is never repeated", async () => {
    const { dir } = await start({ ledgerFaults: { tamperOnCommit: { invoiceNumber: "WRONG" } } });
    const { rt } = await recover(dir);
    const id = await idOf(dir);
    const view = await rt.status(id);
    expect(view).toMatchObject({ outcome: "failed" });
    expect(view.assessment).toMatchObject({ state: "business-outcome-unexpected", step: "submit" });
    expect(view.assessment.summary).toContain("may well have executed");
    expect(view.assessment.summary).toContain("not evidence that it did not");
    expect(view.assessment.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ result: "contradicted" })]));
    expect(view.output).toBeUndefined();
    // nothing re-runs it, and recovery does not treat it as unverified or as not executed
    await expect(rt.reconcile(id, "operator")).rejects.toMatchObject({ code: "NOT_RECONCILABLE" });
    expect(await rt.resume(id)).toMatchObject({ outcome: "failed" });
    const ledger = await ledgerState(dir);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ invoiceNumber: "WRONG" });
    expect(ledger.fenced).toEqual([]);
  }, T);

  it("evidence found during recovery that contradicts the expected result fails the run through the recipe's own edge, still without a second effect", async () => {
    const { dir } = await start();
    const { rt, env } = await recover(dir);
    const id = await idOf(dir);
    await env.ledger.tamper("inv-1", { invoiceNumber: "SOMETHING-ELSE" });
    const done = await rt.reconcile(id, "operator");
    expect(done).toMatchObject({ outcome: "failed", endStep: "submission-failed", assessment: { state: "business-outcome-unexpected" } });
    expect((await ledgerState(dir)).rows).toHaveLength(1);
    expect(submits(done)).toHaveLength(1);
  }, T);
});

describe("test 5: concurrent recovery", () => {
  it("two processes recovering the same run: one claim wins, the other is refused, one verification outcome, one effect", async () => {
    const { dir } = await start();
    const id = await idOf(dir);
    const exits = await Promise.all([runWorker({ dir, command: "reconcile", runId: id, worker: "p1" }), runWorker({ dir, command: "reconcile", runId: id, worker: "p2" })]);
    const winners = exits.filter((e) => e.result?.ok && e.result.view.outcome === "completed");
    expect(winners).toHaveLength(1);
    for (const e of exits) if (e.result && !e.result.ok) expect(["CONFLICT", "NOT_RECONCILABLE"]).toContain(e.result.code);
    const { rt } = await recover(dir);
    const final = await rt.status(id);
    expect(final).toMatchObject({ status: "finished", outcome: "completed" });
    expect(final.assessment.rechecks).toBe(1);
    expect(submits(final)).toHaveLength(1);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);

  it("a recoverer killed mid-verification leaves a recoverable running run; several workers resuming it produce one outcome and no resubmission", async () => {
    const { dir } = await start();
    const id = await idOf(dir);
    const killed = await runWorker({ dir, command: "reconcile", runId: id, worker: "recoverer", leaseMs: 500, killAt: { point: "verify:probe-returned", step: "submit" } });
    expect(killed.signal).toBe("SIGKILL");
    await new Promise((r) => setTimeout(r, 700));
    const racers = await Promise.all([runWorker({ dir, command: "resume", runId: id, worker: "r1" }), runWorker({ dir, command: "resume", runId: id, worker: "r2" }), runWorker({ dir, command: "resume", runId: id, worker: "r3" })]);
    for (const r of racers) if (r.result && !r.result.ok) expect(["RUN_LEASED", "CONFLICT"]).toContain(r.result.code);
    expect(racers.some((r) => r.result?.ok)).toBe(true);
    const { rt } = await recover(dir);
    const final = await rt.status(id);
    expect(final).toMatchObject({ outcome: "completed" });
    expect(submits(final)).toHaveLength(1);
    expect((await ledgerState(dir)).rows).toHaveLength(1);
  }, T);
});

describe("fencing and ownership of verification (§8)", () => {
  async function pair() {
    const dir = tempDir();
    let clock = Date.parse("2026-10-21T10:00:00Z");
    const env = await accountingEnvironment(join(dir, "env"), supplierInvoice());
    onCleanup(() => env.close());
    const open = async (worker: string, hook?: (p: RuntimePoint, i: { step: string }) => void | Promise<void>) => {
      const rt = await RecipeRuntime.open({ home: join(dir, "runtime"), gateway: env.gateway, authority: full, worker, leaseMs: 1000, now: () => clock, ...(hook ? { hook } : {}) });
      onCleanup(() => rt.close());
      return rt;
    };
    return { dir, env, open, advance: (ms: number) => (clock += ms) };
  }
  const gate = (point: RuntimePoint, step?: string) => {
    let release!: () => void;
    let reached!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const arrived = new Promise<void>((r) => (reached = r));
    let armed = false;
    return { arm: () => (armed = true), hook: async (p: RuntimePoint, i: { step: string }) => { if (armed && p === point && (!step || i.step === step)) { armed = false; reached(); await open; } }, arrived, release };
  };

  it("a verifier that lost its lease cannot record a finding or finish the run; the successor's outcome stands", async () => {
    const w = await pair();
    const g = gate("verify:probe-returned", "submit");
    const stale = await w.open("stale", g.hook);
    const successor = await w.open("successor");
    w.env.ledger.faults.read = "unavailable";
    const run = await successor.start(supplierInvoice(), AUTO, "alice");
    expect(run.assessment.state).toBe("recorded-unverified");
    w.env.ledger.faults.read = undefined;

    g.arm();
    const recovering = stale.reconcile(run.id, "op").catch((e) => e as RuntimeError); // the stale worker is parked mid-verification, holding the run
    await g.arrived;
    w.advance(5_000); // its lease expires (which proves nothing about what it is doing)
    const taken = await successor.resume(run.id);
    expect(taken).toMatchObject({ outcome: "completed" });

    g.release();
    const lost = await recovering;
    expect(lost).toBeInstanceOf(RuntimeError);
    expect((lost as RuntimeError).code).toBe("CONFLICT");
    const final = await successor.status(run.id);
    expect(final).toMatchObject({ outcome: "completed" });
    expect(submits(final)).toHaveLength(1);
    expect(methodResults(final, "submit", "invoice-recorded").at(-1)).toBe("confirmed"); // not overwritten by anything stale
    expect(final.assessment.rechecks).toBe(1);
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);
  }, T);

  it("a lookup answer gathered before another reconciliation settled the run cannot overwrite that settlement", async () => {
    const w = await pair();
    const g = gate("reconcile:evidence");
    const slow = await w.open("slow", g.hook);
    const quick = await w.open("quick");
    w.env.ledger.faults.loseResponseAfterCommit = true;
    const run = await quick.start(supplierInvoice(), AUTO, "alice");
    w.env.ledger.faults.loseResponseAfterCommit = false;
    expect(run.assessment.state).toBe("invocation-outcome-unknown");

    g.arm();
    const late = slow.reconcile(run.id, "slow").catch((e) => e as RuntimeError);
    await g.arrived; // it has the lookup's answer ("recorded") and has not yet committed anything
    const settled = await quick.reconcile(run.id, "quick");
    expect(settled).toMatchObject({ outcome: "completed" });
    g.release();
    const lost = await late;
    expect(lost).toBeInstanceOf(RuntimeError);
    expect((lost as RuntimeError).code).toBe("CONFLICT");
    const final = await quick.status(run.id);
    expect(final.reconciliations.filter((r) => r.resolution === "confirmed-completed")).toHaveLength(1);
    expect(submits(final)).toHaveLength(1);
    expect((await ledgerState(w.dir)).rows).toHaveLength(1);
  }, T);

  it("the two recoveries are one mechanism: a run with a lost invocation and a run with an unverified result each have exactly one applicable path", async () => {
    const w = await pair();
    const rt = await w.open("w");
    w.env.ledger.faults.read = "unavailable";
    const unverified = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(unverified.assessment.state).toBe("recorded-unverified");
    w.env.ledger.faults.read = undefined;
    w.env.ledger.faults.loseResponseAfterCommit = true;
    const lost = await rt.start(supplierInvoice(), { ...AUTO, invoiceNumber: "INV-9" }, "alice");
    w.env.ledger.faults.loseResponseAfterCommit = false;
    expect(lost.assessment.state).toBe("invocation-outcome-unknown");
    expect((await rt.reconcile(lost.id, "op")).reconciliations).toHaveLength(1); // looked up by key
    expect((await rt.reconcile(unverified.id, "op")).reconciliations).toHaveLength(0); // re-verified, no lookup
    expect((await ledgerState(w.dir)).rows).toHaveLength(2);
  }, T);
});
