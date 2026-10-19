/**
 * Test fixtures for recipes. The accounting contract below is a TEST FIXTURE: it stands in for a canonical contract
 * that does not exist, so environment checks, locks and packages can be exercised. It is not published, and nothing
 * registers or implements it outside these tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INTEGRATION_EXTENSION,
  capabilityDigest,
  type AppPortManifest,
  type CapabilityIntegration,
  type CapabilityVersionEntry,
  type JSONSchema
} from "@appport/protocol";
import { CANONICAL_CONTRACT_EXTENSION, type CapabilityStep, type RecipeSource } from "../src/index.js";

export const CONTRACT = "org.example.accounting";

/**
 * A fulfillment claim on a capability of the fixture contract, as AppPort's `claimFor` builds one (AppPort
 * `spec/fulfillment-1.md` §3). Built from the published `capabilityDigest` because published AppPort predates `claimFor`.
 */
export const claimFor = (contract: AppPortManifest, capability: string, version: number) => ({
  contract: contract.application.id,
  capability,
  version,
  digest: capabilityDigest(contract, capability, version)!
});
const EXAMPLE = fileURLToPath(new URL("../../../examples/supplier-invoice/recipe.json", import.meta.url));

/** A fresh copy of the supplier-invoice example. */
export const example = (): RecipeSource => JSON.parse(readFileSync(EXAMPLE, "utf8")) as RecipeSource;

export const step = <T = CapabilityStep>(recipe: RecipeSource, id: string): T => recipe.steps.find((s) => s.id === id) as T;

const probeOutput: JSONSchema = {
  type: "object",
  required: ["invoiceId", "invoiceNumber", "supplierId", "status"],
  properties: {
    invoiceId: { type: "string" },
    invoiceNumber: { type: "string" },
    supplierId: { type: "string" },
    status: { type: "string", enum: ["submitted", "rejected"] }
  }
};

/** The test-fixture canonical contract the example recipe is written against. */
export function accountingContract(options: { description?: string; approval?: CapabilityIntegration["approval"]; verifyId?: string; submitInput?: JSONSchema } = {}): AppPortManifest {
  const recipe = example();
  const submit = step(recipe, "submit");
  const duplicate = step(recipe, "check-duplicate");
  const entry = (name: string, definition: Omit<CapabilityVersionEntry, "version">) => {
    const d = { version: 1, ...definition };
    return { name, versions: [1], latestVersion: 1, ...d, definitions: [d] };
  };
  const integration: CapabilityIntegration = {
    effects: [{ type: "https://vocab.example.org/finance#invoice-recorded" }],
    approval: options.approval ?? { required: false },
    verify: [{
      id: options.verifyId ?? "invoice-recorded",
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
      entry("invoice.get", { kind: "request", inputSchema: { type: "object", required: ["invoiceId"], properties: { invoiceId: { type: "string" } } }, outputSchema: probeOutput, authorization: ["accounting.invoice.read"], effect: "observation" }),
      entry("invoice.submit", {
        ...(options.description ? { description: options.description } : {}),
        kind: "request",
        inputSchema: options.submitInput ?? submit.expects.input,
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
