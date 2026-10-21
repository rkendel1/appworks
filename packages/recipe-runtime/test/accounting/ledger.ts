/**
 * A small accounting ledger with real persisted state: its own FeltDB database, which the runtime never writes and the
 * tests read directly to check what actually happened, independently of any capability response.
 */
import { createFeltDB } from "@feltdb/core";

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
  submittedAt: string;
}

export class Ledger {
  /** Faults a test may inject. `loseResponseAfterCommit`: the write commits, then the call fails as a lost connection would. */
  faults = { loseResponseAfterCommit: false };
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

  /** Records an invoice. The same idempotency key returns the invoice it recorded; a second invoice with the same supplier and number is `rejected`. */
  async submit(input: Omit<InvoiceRow, "id" | "status" | "idempotencyKey" | "submittedAt">, idempotencyKey: string): Promise<InvoiceRow> {
    this.attempts.push(`${input.supplierId}/${input.invoiceNumber}`);
    const all = await this.invoices();
    const replay = all.find((i) => i.idempotencyKey === idempotencyKey);
    if (replay) return replay;
    const existing = all.find((i) => i.supplierId === input.supplierId && i.invoiceNumber === input.invoiceNumber);
    if (existing) return { ...existing, status: "rejected" };
    const row: InvoiceRow = { ...input, id: `inv-${all.length + 1}`, status: "submitted", idempotencyKey, submittedAt: new Date().toISOString() };
    await this.db.collection("invoices").put(row as never, row.id);
    if (this.faults.loseResponseAfterCommit) throw new Error("connection reset by peer");
    return row;
  }
}
