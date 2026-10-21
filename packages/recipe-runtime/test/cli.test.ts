/**
 * `appworks recipe run | status | resume` (spec §10), driven through `main` with an injected environment loader.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliEnvironment } from "../src/cli.js";
import { accountingEnvironment } from "./accounting/environment.js";
import { supplierInvoice } from "./accounting/contract.js";

let dir: string;
let closers: Array<() => Promise<void>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recipe-cli-"));
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
  rmSync(dir, { recursive: true, force: true });
});

const AUTO = { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30", purchaseOrder: "PO-1" };

async function cli(args: string[], env: CliEnvironment = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("appworks recipe", () => {
  it("runs a recipe to completion, reports its status from a separate invocation, and the ledger holds the invoice", async () => {
    const recipe = supplierInvoice();
    const recipeFile = join(dir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(recipe));
    const accounting = await accountingEnvironment(join(dir, "env"), recipe);
    closers.push(() => accounting.close());
    const environment: CliEnvironment = { load: async () => ({ gateway: accounting.gateway }) };
    const home = join(dir, "home");

    const run = await cli(["recipe", "run", recipeFile, "--input", JSON.stringify(AUTO), "--environment", "env.mjs", "--home", home, "--principal", "alice", "--json"], environment);
    expect(run.code).toBe(0);
    const view = JSON.parse(run.out);
    expect(view).toMatchObject({ status: "finished", outcome: "completed", output: { invoiceId: "inv-1", approval: "automatic" } });
    expect(await accounting.ledger.invoices()).toHaveLength(1);

    const status = await cli(["recipe", "status", view.id, "--home", home]); // no environment needed to read state
    expect(status.code).toBe(0);
    expect(status.out).toContain("finished / completed");
    expect(status.out).toContain("verify submit/invoice-recorded (contract): confirmed");
  });

  it("exits with the outcome: 20 while a task is pending, 10 rejected, 12 uncertain; and refuses a run without an environment or an invalid recipe", async () => {
    const recipe = supplierInvoice();
    const recipeFile = join(dir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(recipe));
    const accounting = await accountingEnvironment(join(dir, "env"), recipe);
    closers.push(() => accounting.close());
    const environment: CliEnvironment = { load: async () => ({ gateway: accounting.gateway }) };
    const base = ["recipe", "run", recipeFile, "--environment", "env.mjs", "--home", join(dir, "home")];

    const waiting = await cli([...base, "--input", JSON.stringify({ ...AUTO, invoiceNumber: "INV-2", amount: 20000 })], environment);
    expect(waiting.code).toBe(20);
    expect(waiting.out).toContain("task request-approval for role:ap-manager (approval): pending");

    expect((await cli([...base, "--input", JSON.stringify({ ...AUTO, amount: 0 })], environment)).code).toBe(10);

    accounting.ledger.faults.loseResponseAfterCommit = true;
    const uncertain = await cli([...base, "--input", JSON.stringify({ ...AUTO, invoiceNumber: "INV-7" })], environment);
    expect(uncertain.code).toBe(12);
    expect(uncertain.out).toContain("uncertain");
    expect(accounting.ledger.attempts.filter((a) => a === "s1/INV-7")).toHaveLength(1);

    expect((await cli(["recipe", "run", recipeFile, "--input", "{}", "--home", join(dir, "home")], environment)).code).toBe(2);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, JSON.stringify({ format: "appport.recipe/1" }));
    const refused = await cli(["recipe", "run", broken, "--input", "{}", "--environment", "env.mjs", "--home", join(dir, "home")], environment);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("RECIPE_INVALID");
  });
});

describe("appworks recipe answer | expire | reconcile", () => {
  it("answers and expires tasks, and reconciles an uncertain run, from separate invocations", async () => {
    const recipe = supplierInvoice();
    const recipeFile = join(dir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(recipe));
    const accounting = await accountingEnvironment(join(dir, "env"), recipe);
    closers.push(() => accounting.close());
    const environment: CliEnvironment = { load: async () => ({ gateway: accounting.gateway }) };
    const common = ["--environment", "env.mjs", "--home", join(dir, "home"), "--json"];
    const start = async (n: string, amount: number) => JSON.parse((await cli(["recipe", "run", recipeFile, "--input", JSON.stringify({ ...AUTO, invoiceNumber: n, amount }), ...common], environment)).out);

    const approve = await start("INV-A", 20000);
    expect((await cli(["recipe", "answer", approve.id, "request-approval", "--response", '{"decision":"approved"}', ...common], environment)).code).toBe(0);
    const expire = await start("INV-B", 20000);
    expect((await cli(["recipe", "expire", expire.id, "request-approval", ...common], environment)).code).toBe(11);
    expect((await cli(["recipe", "answer", expire.id, "request-approval", "--response", '{"decision":"approved"}', ...common], environment)).err).toContain("TASK_NOT_PENDING");
    expect((await cli(["recipe", "answer", expire.id, ...common], environment)).code).toBe(2);

    accounting.ledger.faults.loseResponseAfterCommit = true;
    const lost = await start("INV-C", 120);
    expect(lost.outcome).toBe("uncertain");
    accounting.ledger.faults.loseResponseAfterCommit = false;
    const reconciled = await cli(["recipe", "reconcile", lost.id, ...common], environment);
    expect(reconciled.code).toBe(0);
    expect(JSON.parse(reconciled.out)).toMatchObject({ outcome: "completed", reconciliations: [{ resolution: "confirmed-completed" }] });
    expect((await accounting.ledger.invoices()).filter((i) => i.invoiceNumber === "INV-C")).toHaveLength(1);
    expect((await cli(["recipe", "reconcile", lost.id, ...common], environment)).err).toContain("NOT_RECONCILABLE");
    expect((await cli(["recipe", "status", lost.id, "--home", join(dir, "home")])).out).toContain("reconcile submit: confirmed-completed");
  });
});

describe("appworks recipe status | reconcile for a recorded result whose verification is unresolved", () => {
  it("tells it apart from an unknown outcome and from success, and re-verifies without invoking", async () => {
    const recipe = supplierInvoice();
    const recipeFile = join(dir, "recipe.json");
    writeFileSync(recipeFile, JSON.stringify(recipe));
    const accounting = await accountingEnvironment(join(dir, "env"), recipe);
    closers.push(() => accounting.close());
    const environment: CliEnvironment = { load: async () => ({ gateway: accounting.gateway }) };
    const home = join(dir, "home");
    const common = ["--environment", "env.mjs", "--home", home];

    accounting.ledger.faults.read = "unavailable";
    const run = await cli(["recipe", "run", recipeFile, "--input", JSON.stringify(AUTO), ...common, "--json"], environment);
    expect(run.code).toBe(12);
    const id = JSON.parse(run.out).id;
    const status = await cli(["recipe", "status", id, "--home", home]);
    expect(status.out).toContain("assessment: recorded-unverified");
    expect(status.out).toContain("the provider's result is recorded and the operation will not be repeated");
    expect(status.out).toContain("nothing is established"); // the evidence line says why
    expect(status.out).toContain("next: recipe reconcile re-verifies without invoking anything");
    expect(status.out).toContain("finished / uncertain"); // not reported as failed, and not as succeeded
    expect(status.out).not.toContain("/ failed");
    expect(status.out).not.toContain("assessment: failed");
    expect(status.out).not.toContain("assessment: verified");

    const still = await cli(["recipe", "reconcile", id, ...common], environment);
    expect(still.code).toBe(12); // evidence still cannot exist: unresolved, not failed
    expect(still.out).toContain("verification recoveries so far: 1");

    accounting.ledger.faults.read = undefined;
    const done = await cli(["recipe", "reconcile", id, ...common], environment);
    expect(done.code).toBe(0);
    expect(done.out).toContain("assessment: verified");
    expect((await accounting.ledger.invoices())).toHaveLength(1);
    expect(accounting.ledger.attempts).toEqual(["s1/INV-1"]); // one submit, ever
  });
});
