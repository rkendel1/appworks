/**
 * The recipe runtime against a real AppPort environment and a persisted ledger (spec/runtime-1.md). Every test name states
 * the rule it checks. What actually happened is read from the ledger's own database, never from a capability response.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@appport/protocol";
import type { CapabilityStep, RecipeSource } from "@appport/recipe";
import { RecipeRuntime, RuntimeError, type RuntimeAuthority, type RuntimePoint } from "../src/index.js";
import { BOOKS_NAMES, accountingEnvironment, type ProviderSpec } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";

class SimulatedCrash extends Error {}

const AUTO = { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30", purchaseOrder: "PO-1" };
const LARGE = { ...AUTO, invoiceNumber: "INV-2", amount: 20000 };
const MANAGER = "alice";
const authority: RuntimeAuthority = { canStart: () => true, canAnswer: (principal, role) => principal === MANAGER && role === "role:ap-manager" };

let dir: string;
let clock: number;
const opened: RecipeRuntime[] = [];
const environments: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recipe-runtime-"));
  clock = Date.parse("2026-10-21T10:00:00Z");
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((r) => r.close().catch(() => undefined)));
  await Promise.all(environments.splice(0).map((e) => e.close().catch(() => undefined)));
  rmSync(dir, { recursive: true, force: true });
});

async function setup(options: { providers?: ProviderSpec[]; grant?: boolean; recipe?: RecipeSource } = {}) {
  const recipe = options.recipe ?? supplierInvoice();
  const env = await accountingEnvironment(dir, recipe, options.providers, options.grant === undefined ? {} : { grant: options.grant });
  environments.push(env);
  const open = async (hook?: (point: RuntimePoint, info: { run: string; step: string }) => void, worker = "worker-a") => {
    const runtime = await RecipeRuntime.open({ home: join(dir, "runtime"), gateway: env.gateway, authority, worker, leaseMs: 1000, now: () => clock, ...(hook ? { hook } : {}) });
    opened.push(runtime);
    return runtime;
  };
  return { recipe, env, open, rt: await open() };
}

const crashAt = (target: RuntimePoint, step: string) => (point: RuntimePoint, info: { step: string }) => {
  if (point === target && info.step === step) throw new SimulatedCrash(`${target} ${step}`);
};

/** Simulates process death: the crashed runtime is closed without tidying anything, and a new worker opens the same home. */
async function restart(s: Awaited<ReturnType<typeof setup>>, rt: RecipeRuntime, worker = "worker-b") {
  await rt.close();
  return s.open(undefined, worker);
}

describe("a valid recipe executes against actual capabilities (§3, §5, §6)", () => {
  it("runs the automatic path to a verified completion, with the effect in the ledger's own database", async () => {
    const { rt, env } = await setup();
    const run = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ status: "finished", outcome: "completed", endStep: "submitted", output: { invoiceId: "inv-1", status: "submitted", approval: "automatic" } });

    const rows = await env.ledger.invoices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "inv-1", supplierId: "s1", invoiceNumber: "INV-1", status: "submitted" });

    expect(run.steps.map((s) => s.stepId)).toEqual(["check-duplicate", "is-duplicate", "needs-approval", "submit", "submitted", "validate-fields"].sort());
    const submit = run.invocations.find((i) => i.stepId === "submit" && i.purpose === "step")!;
    expect(submit).toMatchObject({ effect: "consequential", status: "succeeded", provider: { application: "com.example.ledger", capability: { name: "ledger.post", version: 1 } } });
    // Verified three ways: the contract's method, the recipe's additional method, and the final outcome.
    expect(run.verifications.map((v) => `${v.stepId}:${v.methodId}:${v.source}:${v.result}`).sort()).toEqual([
      "outcome:ledger-holds-invoice:outcome:confirmed",
      "submit:invoice-number-recorded:recipe:confirmed",
      "submit:invoice-recorded:contract:confirmed"
    ]);
  });

  it("rejects a non-positive amount and a duplicate without invoking the submit capability", async () => {
    const { rt, env } = await setup();
    expect(await rt.start(supplierInvoice(), { ...AUTO, amount: 0 }, "alice")).toMatchObject({ outcome: "rejected", endStep: "reject-invalid" });
    expect(await rt.start(supplierInvoice(), AUTO, "alice")).toMatchObject({ outcome: "completed" });
    const second = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(second).toMatchObject({ outcome: "rejected", endStep: "reject-duplicate" });
    expect(second.invocations.filter((i) => i.stepId === "submit")).toEqual([]);
    expect(await env.ledger.invoices()).toHaveLength(1);
    expect(env.ledger.attempts).toEqual(["s1/INV-1"]);
  });

  it("derives a stable, request-bound idempotency key, hands it to the provider, and uses a different one for another request", async () => {
    const { rt, env } = await setup();
    const first = await rt.start(supplierInvoice(), AUTO, "alice");
    const second = await rt.start(supplierInvoice(), { ...AUTO, invoiceNumber: "INV-9" }, "alice");
    const key = (r: typeof first) => r.invocations.find((i) => i.stepId === "submit" && i.purpose === "step")!.idempotencyKey;
    expect(key(first)).toMatch(/^wf1-[0-9a-f]{64}$/);
    expect(key(first)).not.toBe(key(second));
    const expected = "wf1-" + digestOf({ run: first.id, step: "submit", ordinal: 1, target: { contract: "org.example.accounting", capability: "invoice.submit" }, input: { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30", purchaseOrder: "PO-1" } } as never).replace("sha256:", "");
    expect(key(first)).toBe(expected);
    expect((await env.ledger.invoices()).find((r) => r.invoiceNumber === "INV-1")!.idempotencyKey).toBe(key(first));
  });
});

describe("an invalid recipe never starts (§4)", () => {
  const recordsAfter = async (rt: RecipeRuntime) => (await rt.runs()).length;

  it("refuses a recipe that does not validate, one the environment cannot run, one outside the supported subset, and invalid input; writes nothing and calls nothing", async () => {
    const { rt, env } = await setup();
    const broken = supplierInvoice() as unknown as Record<string, unknown>;
    delete broken["start"];
    await expect(rt.start(broken, AUTO, "alice")).rejects.toMatchObject({ code: "RECIPE_INVALID" });

    const unsupported = supplierInvoice();
    (unsupported.steps.find((s) => s.id === "submit") as CapabilityStep).preconditions = [{ id: "p", via: { uses: "get-invoice", input: {} }, require: "not-found" }];
    // Valid recipe source, outside what this slice executes (§12): refused whole, not run partly.
    await expect(rt.start(unsupported, AUTO, "alice")).rejects.toMatchObject({ code: "RECIPE_UNSUPPORTED", details: { unsupported: [expect.stringContaining("preconditions")] } });
    const rules = supplierInvoice();
    (rules.steps.find((s) => s.id === "submit") as CapabilityStep).input.push({ op: "unit", from: "/input/amount", to: "/amount", fromUnit: "EUR", toUnit: "EUR" } as never);
    await expect(rt.start(rules, AUTO, "alice")).rejects.toBeInstanceOf(RuntimeError);

    await expect(rt.start(supplierInvoice(), { ...AUTO, currency: "XXX" }, "alice")).rejects.toMatchObject({ code: "INPUT_INVALID" });

    expect(await recordsAfter(rt)).toBe(0);
    expect(env.ledger.attempts).toEqual([]);
  });

  it("refuses to start in an environment with no eligible provider for the recipe's dependencies, and when the authority refuses the principal", async () => {
    const { rt: none } = await setup({ providers: [] });
    await expect(none.start(supplierInvoice(), AUTO, "alice")).rejects.toMatchObject({ code: "RECIPE_INVALID" });
    expect(await recordsAfter(none)).toBe(0);
    await none.close();

    const denying = await RecipeRuntime.open({ home: join(dir, "denied"), gateway: (await accountingEnvironment(join(dir, "denied-env"), supplierInvoice())).gateway, authority: { canStart: () => false, canAnswer: () => false } });
    opened.push(denying);
    await expect(denying.start(supplierInvoice(), AUTO, "mallory")).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    expect(await recordsAfter(denying)).toBe(0);
  });
});

describe("human tasks: approval, rejection and no answer (§9)", () => {
  it("waits for approval without submitting, enforces who may answer, and submits once approved", async () => {
    const { rt, env } = await setup();
    const waiting = await rt.start(supplierInvoice(), LARGE, "alice");
    expect(waiting).toMatchObject({ status: "waiting", currentStep: "request-approval" });
    expect(waiting.tasks).toEqual([expect.objectContaining({ stepId: "request-approval", role: "role:ap-manager", approval: true, status: "pending" })]);
    expect(env.ledger.attempts).toEqual([]); // the duplicate check ran; nothing was submitted

    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "approved" }, "mallory")).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "maybe" }, MANAGER)).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    const done = await rt.answerTask(waiting.id, "request-approval", { decision: "approved", comment: "ok by AP" }, MANAGER);
    expect(done).toMatchObject({ outcome: "completed", endStep: "submitted-approved", output: { approval: "approved" } });
    expect(done.tasks[0]).toMatchObject({ status: "answered", answeredBy: MANAGER, response: { decision: "approved", comment: "ok by AP" } });
    expect((await env.ledger.invoices())[0]).toMatchObject({ invoiceNumber: "INV-2", approvalNote: "ok by AP" });
    await expect(rt.answerTask(waiting.id, "request-approval", { decision: "approved" }, MANAGER)).rejects.toMatchObject({ code: "TASK_NOT_PENDING" });
  });

  it("ends rejected when the approver rejects, and failed when the task is never answered; neither submits", async () => {
    const { rt, env } = await setup();
    const a = await rt.start(supplierInvoice(), LARGE, "alice");
    expect(await rt.answerTask(a.id, "request-approval", { decision: "rejected" }, MANAGER)).toMatchObject({ outcome: "rejected", endStep: "rejected-by-approver" });
    const b = await rt.start(supplierInvoice(), { ...LARGE, invoiceNumber: "INV-3" }, "alice");
    expect(await rt.expireTask(b.id, "request-approval", MANAGER)).toMatchObject({ outcome: "failed", endStep: "approval-unanswered" });
    expect(env.ledger.attempts).toEqual([]);
    expect(await env.ledger.invoices()).toEqual([]);
  });
});

describe("authorization is checked at invocation time (§7)", () => {
  it("a grant revoked while the run waits is observed by the next invocation, and the provider is never entered", async () => {
    const { rt, env } = await setup();
    const waiting = await rt.start(supplierInvoice(), LARGE, "alice");
    await env.revoke("com.example.ledger", "submit");
    const done = await rt.answerTask(waiting.id, "request-approval", { decision: "approved" }, MANAGER);
    expect(done).toMatchObject({ outcome: "failed", endStep: "submission-failed" });
    const submit = done.invocations.find((i) => i.stepId === "submit-approved")!;
    expect(submit).toMatchObject({ status: "failed", classification: "pre-effect", error: { code: "DENIED" } });
    expect(env.ledger.attempts).toEqual([]);
  });

  it("without any grant nothing runs, however valid the recipe and however eligible the provider (a lock or a claim grants nothing)", async () => {
    const { rt, env } = await setup({ grant: false });
    const run = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ outcome: "failed", endStep: "lookup-failed" });
    expect(run.invocations[0]).toMatchObject({ classification: "pre-effect", error: { code: "DENIED" } });
    expect(env.ledger.attempts).toEqual([]);
  });
});

describe("state survives process restart (§8)", () => {
  it("a run waiting for a task is intact in a new process, which can answer it", async () => {
    const s = await setup();
    const waiting = await s.rt.start(supplierInvoice(), LARGE, "alice");
    const rt2 = await restart(s, s.rt);
    expect(await rt2.status(waiting.id)).toMatchObject({ status: "waiting", currentStep: "request-approval" });
    expect(await rt2.answerTask(waiting.id, "request-approval", { decision: "approved" }, MANAGER)).toMatchObject({ outcome: "completed" });
    expect(await s.env.ledger.invoices()).toHaveLength(1);
  });

  it("a worker that dies between steps is replaced after its lease expires, and continues without repeating a step", async () => {
    const s = await setup();
    const doomed = await s.open(crashAt("step:committed", "check-duplicate"), "worker-doomed");
    await expect(doomed.start(supplierInvoice(), AUTO, "alice")).rejects.toBeInstanceOf(SimulatedCrash);
    const [{ id }] = await doomed.runs();
    const rt2 = await restart(s, doomed);

    await expect(rt2.resume(id!)).rejects.toMatchObject({ code: "RUN_LEASED" }); // the dead worker's lease has not run out
    clock += 5_000;
    expect((await rt2.status(id!)).interrupted).toBe(true);
    const done = await rt2.resume(id!);
    expect(done).toMatchObject({ outcome: "completed" });
    expect(done.invocations.filter((i) => i.stepId === "check-duplicate")).toHaveLength(1);
    expect(await s.env.ledger.invoices()).toHaveLength(1);
  });

  it("a recovered observation whose outcome was lost is invoked again; the abandoned attempt stays in the record", async () => {
    const s = await setup();
    const doomed = await s.open(crashAt("invoke:returned", "check-duplicate"), "worker-doomed");
    await expect(doomed.start(supplierInvoice(), AUTO, "alice")).rejects.toBeInstanceOf(SimulatedCrash);
    const [{ id }] = await doomed.runs();
    const rt2 = await restart(s, doomed);
    clock += 5_000;
    const done = await rt2.resume(id!);
    expect(done).toMatchObject({ outcome: "completed" });
    expect(done.invocations.filter((i) => i.stepId === "check-duplicate").map((i) => `${i.status}`)).toEqual(["abandoned", "succeeded"]);
  });
});

describe("a successful submission is verified against independently persisted state (§6.4)", () => {
  it("is not reported as success when the ledger's own state contradicts the response", async () => {
    const s = await setup();
    // After the provider answers and before the runtime verifies, someone changes the stored row.
    const rt = await s.open(undefined, "worker-x");
    await rt.close();
    let tampered = false;
    const tampering = await s.open((point, info) => {
      if (point === "invoke:returned" && info.step === "submit" && !tampered) {
        tampered = true;
        return s.env.ledger.tamper("inv-1", { invoiceNumber: "SOMETHING-ELSE" });
      }
    }, "worker-y");
    const run = await tampering.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ outcome: "failed", endStep: "submission-failed" });
    expect(run.verifications.find((v) => v.methodId === "invoice-recorded")).toMatchObject({ result: "contradicted" });
    expect(run.output).toBeUndefined();
  });

  it("is not reported as success when verification cannot be performed: the run is uncertain, not completed", async () => {
    const s = await setup();
    const rt = await s.open(undefined, "worker-x");
    await rt.close();
    const blind = await s.open((point, info) => {
      if (point === "invoke:returned" && info.step === "submit") return s.env.revoke("com.example.ledger", "get") as unknown as void;
    }, "worker-y");
    const run = await blind.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ outcome: "uncertain", endStep: "submission-uncertain" });
    expect(run.verifications.every((v) => v.result === "inconclusive")).toBe(true);
    expect(await s.env.ledger.invoices()).toHaveLength(1); // the effect happened; the runtime does not claim to know it
  });
});

describe("a lost response after a consequential write is uncertain and is never resubmitted (§6.3)", () => {
  it("records the invocation as uncertain and ends the run uncertain, although the ledger did commit", async () => {
    const { rt, env } = await setup();
    env.ledger.faults.loseResponseAfterCommit = true;
    const run = await rt.start(supplierInvoice(), AUTO, "alice");
    expect(run).toMatchObject({ status: "finished", outcome: "uncertain", endStep: "submission-uncertain" });
    expect(run.invocations.find((i) => i.stepId === "submit")).toMatchObject({ status: "uncertain", classification: "effect-unknown", error: { code: "implementation_failure" } });
    expect(await env.ledger.invoices()).toHaveLength(1); // committed
    expect(env.ledger.attempts).toEqual(["s1/INV-1"]);
  });

  it("restarting the uncertain run, in the same or a new process, submits nothing", async () => {
    const s = await setup();
    s.env.ledger.faults.loseResponseAfterCommit = true;
    const run = await s.rt.start(supplierInvoice(), AUTO, "alice");
    s.env.ledger.faults.loseResponseAfterCommit = false;
    expect(await s.rt.resume(run.id)).toMatchObject({ outcome: "uncertain" });
    const rt2 = await restart(s, s.rt);
    clock += 60_000;
    expect(await rt2.resume(run.id)).toMatchObject({ outcome: "uncertain" });
    expect(s.env.ledger.attempts).toEqual(["s1/INV-1"]);
    expect(await s.env.ledger.invoices()).toHaveLength(1);
  });

  it("a worker that dies after the provider committed but before the outcome was recorded leaves an intent; the successor marks it uncertain and never calls again", async () => {
    const s = await setup();
    const doomed = await s.open(crashAt("invoke:returned", "submit"), "worker-doomed");
    await expect(doomed.start(supplierInvoice(), AUTO, "alice")).rejects.toBeInstanceOf(SimulatedCrash);
    const [{ id }] = await doomed.runs();
    expect((await s.env.ledger.invoices())).toHaveLength(1); // the effect happened
    const rt2 = await restart(s, doomed);
    clock += 5_000;
    const done = await rt2.resume(id!);
    expect(done).toMatchObject({ outcome: "uncertain", endStep: "submission-uncertain" });
    expect(done.invocations.find((i) => i.stepId === "submit")).toMatchObject({ status: "uncertain", cause: "outcome-not-recorded" });
    expect(s.env.ledger.attempts).toEqual(["s1/INV-1"]);
  });

  it("even a worker that dies before the call was made is not retried: whether anything was sent is not known, so the run is uncertain and nothing is submitted", async () => {
    const s = await setup();
    const doomed = await s.open(crashAt("invoke:intent-recorded", "submit"), "worker-doomed");
    await expect(doomed.start(supplierInvoice(), AUTO, "alice")).rejects.toBeInstanceOf(SimulatedCrash);
    const [{ id }] = await doomed.runs();
    const rt2 = await restart(s, doomed);
    clock += 5_000;
    expect(await rt2.resume(id!)).toMatchObject({ outcome: "uncertain" });
    expect(s.env.ledger.attempts).toEqual([]);
    expect(await s.env.ledger.invoices()).toEqual([]);
  });
});

describe("a different provider fulfils the same canonical contract without any recipe change (§1)", () => {
  it("runs the identical recipe, byte for byte, against a provider with other capability names and its own storage", async () => {
    const before = JSON.stringify(supplierInvoice());
    const a = await setup();
    const runA = await a.rt.start(supplierInvoice(), AUTO, "alice");
    await a.rt.close();
    await a.env.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "recipe-runtime-"));

    const b = await setup({ providers: [{ id: "com.globex.books", names: BOOKS_NAMES }] });
    const runB = await b.rt.start(supplierInvoice(), AUTO, "alice");

    expect(JSON.stringify(supplierInvoice())).toBe(before);
    expect(runA.recipeDigest).toBe(runB.recipeDigest);
    expect(runA.outcome).toBe("completed");
    expect(runB.outcome).toBe("completed");
    expect(runA.invocations.find((i) => i.stepId === "submit")!.provider).toMatchObject({ application: "com.example.ledger", capability: { name: "ledger.post" } });
    expect(runB.invocations.find((i) => i.stepId === "submit")!.provider).toMatchObject({ application: "com.globex.books", capability: { name: "books.record" } });
    expect(await b.env.ledgers["com.globex.books"]!.invoices()).toHaveLength(1);
  });
});

describe("boundaries", () => {
  it("has no dependency on, and imports nothing from, @appport/workspace", () => {
    const root = new URL("..", import.meta.url).pathname;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })).not.toContain("@appport/workspace");
    const walk = (d: string): string[] => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? (e === "node_modules" || e === "dist" ? [] : walk(join(d, e))) : [join(d, e)]));
    for (const file of walk(root).filter((f) => f.endsWith(".ts"))) expect(readFileSync(file, "utf8"), file).not.toMatch(/(?:from|import|require)\s*\(?\s*["']@appport\/workspace|["'](?:\.\.\/)+workspace\//);
  });
});
