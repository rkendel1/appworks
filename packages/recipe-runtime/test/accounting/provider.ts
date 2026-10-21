/**
 * A provider of the accounting contract over a {@link Ledger}. Its capabilities carry their own names (`names`), so two
 * providers can fulfil the same canonical capabilities differently and a recipe cannot tell which it reached.
 */
import { defineApplication, defineCapability, implementation, type AnyCapability } from "@appport/core";
import { claimFor, type AppPortManifest, type JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import type { Ledger } from "./ledger.js";

export interface ProviderNames {
  duplicate: string;
  get: string;
  submit: string;
}

export function ledgerProvider(id: string, contract: AppPortManifest, ledger: Ledger, names: ProviderNames) {
  const def = (name: string) => contract.capabilities.find((c) => c.name === name)!;
  const view = (row: { id: string; invoiceNumber: string; supplierId: string; status: string }) => ({ invoiceId: row.id, invoiceNumber: row.invoiceNumber, supplierId: row.supplierId, status: row.status });
  const make = (local: string, canonical: string, handler: (input: never, context: { idempotencyKey?: string }) => Promise<unknown>, extra: Record<string, unknown> = {}) =>
    defineCapability({
      name: local,
      version: 1,
      input: fromJSONSchema(def(canonical).inputSchema as JSONSchema),
      output: fromJSONSchema(def(canonical).outputSchema as JSONSchema),
      authorization: [...def(canonical).authorization],
      effect: def(canonical).effect!,
      ...(def(canonical).idempotency ? { idempotency: def(canonical).idempotency } : {}),
      fulfills: [claimFor(contract, canonical, 1)],
      handler: handler as never,
      ...extra
    } as never);

  const duplicates = make(names.duplicate, "invoice.duplicate", async (input: { supplierId: string; invoiceNumber: string }) => {
    const found = await ledger.find(input.supplierId, input.invoiceNumber);
    return found ? { duplicate: true, invoiceId: found.id } : { duplicate: false };
  });
  const read = make(names.get, "invoice.get", async (input: { invoiceId: string }) => {
    const row = await ledger.get(input.invoiceId);
    if (!row) throw new Error(`no invoice ${input.invoiceId}`);
    return view(row);
  });
  const submit = make(
    names.submit,
    "invoice.submit",
    async (input: never, context) => view(await ledger.submit(input, context.idempotencyKey ?? "no-key")),
    {
      integration: {
        effects: [{ type: "https://vocab.example.org/finance#invoice-recorded" }],
        approval: { required: false },
        verify: [{ id: "invoice-recorded", kind: "state", via: { capability: names.get, version: 1, input: { invoiceId: { $output: "/invoiceId" } } }, expect: [{ at: "/invoiceNumber", equals: { $input: "/invoiceNumber" } }] }],
        failures: [{ code: "TIMEOUT", retry: "after-verification", effect: "possible" }]
      }
    }
  );
  const capabilities = [duplicates, read, submit];
  const app = defineApplication({
    identity: { id, name: id, version: "1.0.0" },
    provides: capabilities as never,
    implementations: Object.fromEntries(capabilities.map((c) => [`${c.name}@${c.version}`, implementation(c.handler as never)]))
  });
  const byName = new Map<string, AnyCapability>(capabilities.map((c) => [`${c.name}@${c.version}`, c as AnyCapability]));
  return { app, names, capability: (name: string, version: number) => byName.get(`${name}@${version}`) };
}
