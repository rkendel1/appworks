/**
 * Shared helpers for the conformance tests: temporary homes, independent ledger reads, and a recovering runtime opened
 * in the test's own process over the on-disk state a worker process left behind.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { RecipeRuntime, type RuntimeAuthority, type RuntimeOptions } from "../src/index.js";
import { accountingEnvironment, LEDGER_NAMES, type ProviderSpec } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";
import { Ledger } from "./accounting/ledger.js";

export const AUTO = { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30", purchaseOrder: "PO-1" };
export const LARGE = { ...AUTO, invoiceNumber: "INV-2", amount: 20000 };
export const MANAGER = "alice";
export const full: RuntimeAuthority = { canStart: () => true, canAnswer: () => true, canReconcile: () => true };

export const PROVIDER_ID = "com.example.ledger";
export const ledgerPath = (dir: string, id = PROVIDER_ID) => join(dir, "env", `ledger-${id}`);

let dirs: string[] = [];
let closers: Array<() => Promise<unknown>> = [];

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "recipe-conformance-"));
  dirs.push(dir);
  return dir;
};
export const onCleanup = (fn: () => Promise<unknown>) => void closers.push(fn);

export function useCleanup() {
  beforeEach(() => {
    dirs = [];
    closers = [];
  });
  afterEach(async () => {
    await Promise.all(closers.reverse().map((c) => c().catch(() => undefined)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
}

/** What the accounting ledger holds now, read by a fresh handle straight from its own database. */
export async function ledgerState(dir: string, id = PROVIDER_ID) {
  const ledger = Ledger.open(ledgerPath(dir, id));
  try {
    return { rows: await ledger.invoices(), fenced: await ledger.fenced() };
  } finally {
    await ledger.close();
  }
}

/** A runtime and environment in this process over the home a worker process used. Time runs a minute ahead, so a dead worker's lease has expired. */
export async function recover(dir: string, options: { authority?: RuntimeAuthority; grant?: boolean; providers?: ProviderSpec[]; worker?: string; now?: () => number; hook?: RuntimeOptions["hook"]; leaseMs?: number } = {}) {
  const recipe = supplierInvoice();
  const env = await accountingEnvironment(join(dir, "env"), recipe, options.providers ?? [{ id: PROVIDER_ID, names: LEDGER_NAMES }], options.grant === false ? { grant: false } : {});
  onCleanup(() => env.close());
  const open = async (worker = options.worker ?? "recoverer", hook = options.hook) => {
    const rt = await RecipeRuntime.open({
      home: join(dir, "runtime"), gateway: env.gateway, authority: options.authority ?? full, worker, leaseMs: options.leaseMs ?? 1000,
      now: options.now ?? (() => Date.now() + 60_000), ...(hook ? { hook } : {})
    });
    onCleanup(() => rt.close());
    return rt;
  };
  return { env, rt: await open(), open };
}

export const submits = <T extends { stepId: string; purpose: string }>(view: { invocations: T[] }): T[] => view.invocations.filter((i) => i.stepId === "submit" && i.purpose === "step");
