/**
 * A small accounting ledger with real persisted state: its own FeltDB database, which the runtime never writes and the
 * tests read directly to check what actually happened, independently of any capability response.
 */
import { createFeltDB } from "@feltdb/core";
import { canonicalize, type JsonValue } from "@appport/protocol";

export interface InvoiceRow {
  id: string;
  supplierId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  dueDate: string;
  purchaseOrder?: string;
  approvalNote?: string;
  status: "submitted" | "rejected";
  idempotencyKey: string;
  inputDigest: string;
  submittedAt: string;
}

/** A key reused for a different request, or fenced: refused, never executed. */
export class OperationRefused extends Error {}

export class Ledger {
  /** Faults a test may inject. `loseResponseAfterCommit`: the write commits, then the call fails as a lost connection would. */
  faults: { loseResponseAfterCommit: boolean; consistency: "strong" | "eventual"; killAt?: "before-commit" | "after-commit" } = { loseResponseAfterCommit: false, consistency: "strong" };
  /** Every submit that reached the ledger, committed or not. A second one for the same invoice is a resubmission. */
  attempts: string[] = [];

  private constructor(private readonly db: ReturnType<typeof createFeltDB>) {}

  static open(path: string): Ledger {
    return new Ledger(createFeltDB({ namespace: "ledger", mode: "local", path }));
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** What is in the ledger now, read straight from the database. */
  async invoices(): Promise<InvoiceRow[]> {
    return (await this.db.collection("invoices").find({})) as unknown as InvoiceRow[];
  }

  async find(supplierId: string, invoiceNumber: string): Promise<InvoiceRow | undefined> {
    return (await this.invoices()).find((i) => i.supplierId === supplierId && i.invoiceNumber === invoiceNumber);
  }

  async get(id: string): Promise<InvoiceRow | undefined> {
    return ((await this.db.collection("invoices").get(id)) ?? undefined) as unknown as InvoiceRow | undefined;
  }

  /** Changes a stored row behind the application's back, as another system or an operator might. */
  async tamper(id: string, patch: Partial<InvoiceRow>): Promise<void> {
    const row = await this.get(id);
    await this.db.collection("invoices").put({ ...row, ...patch } as never, id);
  }

  /** What `resolve` has fenced: operation keys the ledger will never execute. */
  async fenced(): Promise<string[]> {
    return ((await this.db.collection("fences").find({})) as unknown as Array<{ id: string }>).map((f) => f.id);
  }

  /**
   * Reports what became of the submit that carried `key`. An unknown key is fenced before the answer is given, so a late
   * arrival of that submit is refused; with `consistency: "eventual"` it answers `absent` without that guarantee.
   */
  async resolve(key: string): Promise<{ state: "recorded"; output: { invoiceId: string; status: string }; consistency: "strong" } | { state: "absent"; consistency: "strong" | "eventual"; fenced: boolean }> {
    const row = (await this.invoices()).find((i) => i.idempotencyKey === key);
    if (row) return { state: "recorded", output: { invoiceId: row.id, status: row.status }, consistency: "strong" };
    if (this.faults.consistency === "eventual") return { state: "absent", consistency: "eventual", fenced: false };
    await this.db.collection("fences").put({ at: new Date().toISOString() } as never, key);
    return { state: "absent", consistency: "strong", fenced: true };
  }

  /** Records an invoice. The same idempotency key returns the invoice it recorded; a second invoice with the same supplier and number is `rejected`. */
  async submit(input: Omit<InvoiceRow, "id" | "status" | "idempotencyKey" | "inputDigest" | "submittedAt">, idempotencyKey: string): Promise<InvoiceRow> {
    this.attempts.push(`${input.supplierId}/${input.invoiceNumber}`);
    if ((await this.fenced()).includes(idempotencyKey)) throw new OperationRefused(`operation ${idempotencyKey} was fenced by a resolution and will not be executed`);
    const inputDigest = canonicalize(input as unknown as JsonValue);
    const all = await this.invoices();
    const replay = all.find((i) => i.idempotencyKey === idempotencyKey);
    // The same key with other input is a different request pretending to be a retry: refused, not replayed.
    if (replay && replay.inputDigest !== inputDigest) throw new OperationRefused(`idempotency key ${idempotencyKey} was used for a different request`);
    if (replay) return replay;
    const existing = all.find((i) => i.supplierId === input.supplierId && i.invoiceNumber === input.invoiceNumber);
    if (existing) return { ...existing, status: "rejected" };
    const row: InvoiceRow = { ...input, id: `inv-${all.length + 1}`, status: "submitted", idempotencyKey, inputDigest, submittedAt: new Date().toISOString() };
    if (this.faults.killAt === "before-commit") process.kill(process.pid, "SIGKILL");
    await this.db.collection("invoices").put(row as never, row.id);
    if (this.faults.killAt === "after-commit") process.kill(process.pid, "SIGKILL");
    if (this.faults.loseResponseAfterCommit) throw new Error("connection reset by peer");
    return row;
  }
}
