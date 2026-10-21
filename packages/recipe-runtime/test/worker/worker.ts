/**
 * A recipe-runtime worker run as its own OS process (see spawn.ts). It builds the accounting environment over the same
 * on-disk ledger and runtime home as its parent, optionally kills itself with SIGKILL at a named point, and prints its
 * result as one `RESULT <json>` line. A SIGKILL is a real process death: no handler runs, no connection closes, no
 * transaction is completed. It is what the in-process `SimulatedCrash` of runtime.test.ts only approximates.
 */
import { join } from "node:path";
import { RecipeRuntime, type RuntimePoint } from "../../src/index.js";
import { accountingEnvironment, BOOKS_NAMES, LEDGER_NAMES } from "../accounting/environment.js";
import { supplierInvoice } from "../accounting/contract.js";

export interface WorkerSpec {
  dir: string;
  command: "start" | "resume" | "reconcile" | "answer" | "expire";
  input?: unknown;
  runId?: string;
  step?: string;
  response?: unknown;
  principal?: string;
  worker: string;
  leaseMs?: number;
  /** Die at this runtime point (optionally only for this step). */
  killAt?: { point: RuntimePoint; step?: string };
  /** Die inside the provider: before or after its write commits. */
  ledgerKillAt?: "before-commit" | "after-commit";
  /** Make the ledger's lookup eventually consistent. */
  eventual?: boolean;
  provider?: "ledger" | "books";
}

const spec = JSON.parse(process.env["WORKER_SPEC"]!) as WorkerSpec;
const recipe = supplierInvoice();
const provider = spec.provider === "books" ? { id: "com.globex.books", names: BOOKS_NAMES } : { id: "com.example.ledger", names: LEDGER_NAMES };
const env = await accountingEnvironment(join(spec.dir, "env"), recipe, [provider]);
if (spec.ledgerKillAt) env.ledger.faults.killAt = spec.ledgerKillAt;
if (spec.eventual) env.ledger.faults.consistency = "eventual";

const runtime = await RecipeRuntime.open({
  home: join(spec.dir, "runtime"),
  gateway: env.gateway,
  authority: { canStart: () => true, canAnswer: () => true, canReconcile: () => true },
  worker: spec.worker,
  leaseMs: spec.leaseMs ?? 500,
  hook: (point, info) => {
    if (spec.killAt && spec.killAt.point === point && (!spec.killAt.step || spec.killAt.step === info.step)) process.kill(process.pid, "SIGKILL");
  }
});
try {
  const principal = spec.principal ?? "alice";
  const view =
    spec.command === "start" ? await runtime.start(recipe, spec.input, principal)
    : spec.command === "resume" ? await runtime.resume(spec.runId!)
    : spec.command === "reconcile" ? await runtime.reconcile(spec.runId!, principal)
    : spec.command === "answer" ? await runtime.answerTask(spec.runId!, spec.step!, spec.response, principal)
    : await runtime.expireTask(spec.runId!, spec.step!, principal);
  process.stdout.write(`RESULT ${JSON.stringify({ ok: true, view })}\n`);
} catch (error) {
  const e = error as { code?: string; message: string };
  process.stdout.write(`RESULT ${JSON.stringify({ ok: false, code: e.code ?? "ERROR", message: e.message })}\n`);
} finally {
  await runtime.close();
  await env.close();
}
