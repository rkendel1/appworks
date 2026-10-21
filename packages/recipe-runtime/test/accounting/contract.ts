/**
 * The canonical accounting contract the supplier-invoice example is written against. It is the example's illustrative
 * `org.example.accounting`: registered in an AppPort contract registry by the tests, published nowhere. Its schemas are
 * the ones the example recipe declares in `expects`, so the recipe and the contract agree by construction.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_CONTRACT_EXTENSION,
  INTEGRATION_EXTENSION,
  type AppPortManifest,
  type CapabilityIntegration,
  type CapabilityVersionEntry,
  type JSONSchema
} from "@appport/protocol";
import type { CapabilityStep, RecipeSource } from "@appport/recipe";

export const CONTRACT = "org.example.accounting";

const EXAMPLE = fileURLToPath(new URL("../../../../examples/supplier-invoice/recipe.json", import.meta.url));

/** A fresh copy of the checked-in supplier-invoice recipe. */
export const supplierInvoice = (): RecipeSource => JSON.parse(readFileSync(EXAMPLE, "utf8")) as RecipeSource;

const stepOf = (recipe: RecipeSource, id: string) => recipe.steps.find((s) => s.id === id) as CapabilityStep;

const invoiceOutput: JSONSchema = {
  type: "object",
  required: ["invoiceId", "invoiceNumber", "supplierId", "status"],
  properties: { invoiceId: { type: "string" }, invoiceNumber: { type: "string" }, supplierId: { type: "string" }, status: { type: "string", enum: ["submitted", "rejected"] } }
};

export function accountingContract(): AppPortManifest {
  const recipe = supplierInvoice();
  const submit = stepOf(recipe, "submit");
  const duplicate = stepOf(recipe, "check-duplicate");
  const entry = (name: string, definition: Omit<CapabilityVersionEntry, "version">) => {
    const d = { version: 1, ...definition };
    return { name, versions: [1], latestVersion: 1, ...d, definitions: [d] };
  };
  const integration: CapabilityIntegration = {
    effects: [{ type: "https://vocab.example.org/finance#invoice-recorded" }],
    approval: { required: false },
    verify: [{
      id: "invoice-recorded",
      kind: "state",
      via: { capability: "invoice.get", version: 1, input: { invoiceId: { $output: "/invoiceId" } } },
      expect: [{ at: "/invoiceNumber", equals: { $input: "/invoiceNumber" } }]
    }],
    failures: [{ code: "TIMEOUT", retry: "after-verification", effect: "possible" }]
  };
  return {
    protocol: "appport/1",
    application: { id: CONTRACT, name: "Accounting capabilities (test fixture)", version: "1.0.0" },
    capabilities: [
      entry("invoice.duplicate", { kind: "request", inputSchema: duplicate.expects.input, outputSchema: duplicate.expects.output, authorization: ["accounting.invoice.read"], effect: "observation" }),
      entry("invoice.get", { kind: "request", inputSchema: { type: "object", required: ["invoiceId"], properties: { invoiceId: { type: "string" } } }, outputSchema: invoiceOutput, authorization: ["accounting.invoice.read"], effect: "observation" }),
      entry("invoice.submit", {
        kind: "request",
        inputSchema: submit.expects.input,
        outputSchema: submit.expects.output,
        authorization: ["accounting.invoice.submit"],
        authorizationContract: { required: true, scopes: ["accounting.invoice.submit"] },
        effect: "consequential",
        idempotency: "supported"
      })
    ],
    events: [],
    transports: [],
    extensions: [CANONICAL_CONTRACT_EXTENSION, INTEGRATION_EXTENSION],
    attributes: { [INTEGRATION_EXTENSION]: { capabilities: { "invoice.submit@1": integration } } as never }
  };
}

export { invoiceOutput };
