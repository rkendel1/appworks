/**
 * Test fixtures for recipes. The accounting contract below is a TEST FIXTURE: it stands in for a canonical contract
 * that does not exist, so environment checks, locks and packages can be exercised. It is not published, and nothing
 * registers or implements it outside these tests. Registries, resolution and bindings are the real ones from the
 * installed `@appport/core` (a development dependency only: `@appport/recipe` itself does not depend on it).
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
import { fromJSONSchema } from "@appport/schema";
import {
  ApplicationDependencyResolver,
  ApplicationRegistry,
  CanonicalContractRegistry,
  MemoryApplicationStateStore,
  defineApplication,
  defineCapability,
  implementation,
  resolvedDependency,
  type RequirementManifestEntry,
  type ResolutionResult,
  type ResolvedDependency
} from "@appport/core";
import { claimFor } from "@appport/protocol";
import type { CapabilityStep, RecipeSource } from "../src/index.js";

export const CONTRACT = "org.example.accounting";

export { claimFor };
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

// ------------------------------------------------------------------ a real AppPort environment (installed @appport/core)

/**
 * A provider implementing the fixture contract under its own capability names, claiming each canonical capability with
 * AppPort's `claimFor`, and declaring the integration obligations the canonical `invoice.submit` requires. Every call to an
 * implementation is recorded in `calls`, so a test can prove a refused invocation never reached it.
 */
export function ledgerProvider(id: string, contract: AppPortManifest = accountingContract(), calls: string[] = []) {
  const def = (name: string) => contract.capabilities.find((c) => c.name === name)!;
  const make = (local: string, canonical: string, extra: Record<string, unknown> = {}) =>
    defineCapability({
      name: local,
      version: 1,
      input: fromJSONSchema(def(canonical).inputSchema as JSONSchema),
      output: fromJSONSchema(def(canonical).outputSchema as JSONSchema),
      authorization: [...def(canonical).authorization],
      effect: def(canonical).effect!,
      ...(def(canonical).idempotency ? { idempotency: def(canonical).idempotency } : {}),
      fulfills: [claimFor(contract, canonical, 1)],
      handler: async () => (calls.push(`${id}:${local}`), { invoiceId: "inv-1", status: "submitted", duplicate: false }) as never,
      ...extra
    } as never);
  const submit = make("ledger.post", "invoice.submit", {
    integration: {
      effects: [{ type: "https://vocab.example.org/finance#invoice-recorded" }],
      approval: { required: false },
      verify: [{ id: "invoice-recorded", kind: "state", via: { capability: "ledger.read", version: 1, input: { invoiceId: { $output: "/invoiceId" } } }, expect: [{ at: "/invoiceNumber", equals: { $input: "/invoiceNumber" } }] }],
      failures: [{ code: "TIMEOUT", retry: "after-verification", effect: "possible" }]
    }
  });
  const capabilities = [make("ledger.duplicates", "invoice.duplicate"), make("ledger.read", "invoice.get"), submit];
  const app = defineApplication({
    identity: { id, name: id, version: "1.0.0" },
    provides: capabilities as never,
    implementations: Object.fromEntries(capabilities.map((c) => [`${c.name}@${c.version}`, implementation(c.handler as never)]))
  });
  return { app, capabilities: Object.fromEntries(capabilities.map((c) => [c.name, c])) as Record<string, (typeof capabilities)[number]>, calls };
}

/** The canonical requirements a recipe declares, as AppPort requirement entries. */
export const requirementsOf = (recipe: RecipeSource): RequirementManifestEntry[] =>
  recipe.requires.map((d) => {
    const target = d.target as { contract: string; capability: string };
    return { name: target.capability, version: 1, versionConstraint: d.versionConstraint ?? "1", canonical: { contract: target.contract } };
  });

/** Registries holding the fixture contract (active) and, by default, one ledger provider. Everything is AppPort's own. */
export async function canonicalEnvironment(options: { providers?: string[] } = {}) {
  const registry = new ApplicationRegistry(new MemoryApplicationStateStore());
  const contracts = new CanonicalContractRegistry();
  await contracts.register(accountingContract());
  await contracts.activate(CONTRACT);
  const calls: string[] = [];
  const register = async (app: ReturnType<typeof defineApplication>) =>
    registry.activate((await registry.register({ identity: app.identity, manifest: app.manifest(), fingerprint: app.fingerprint(), verification: app.verify() })).id);
  const providers: Record<string, ReturnType<typeof ledgerProvider>> = {};
  for (const id of options.providers ?? ["com.example.ledger"]) {
    providers[id] = ledgerProvider(id, accountingContract(), calls);
    await register(providers[id]!.app);
  }
  const resolver = () => new ApplicationDependencyResolver(registry, { contracts });

  /** Resolves one declared dependency with the real resolver. */
  async function resolve(recipe: RecipeSource, dependencyId: string, provider?: string): Promise<ResolutionResult> {
    const index = recipe.requires.findIndex((d) => d.id === dependencyId);
    const requirement = requirementsOf(recipe)[index]!;
    return resolver().resolveRequirement({ ...requirement, ...(provider ? { provider: { applicationId: provider } } : {}) });
  }
  /** `resolvedDependency()` records for every dependency, from real resolutions. Throws when one does not resolve. */
  async function records(recipe: RecipeSource, provider?: string): Promise<Record<string, ResolvedDependency>> {
    const out: Record<string, ResolvedDependency> = {};
    for (const d of recipe.requires) {
      const result = await resolve(recipe, d.id, provider);
      if (result.kind !== "resolved") throw new Error(`${d.id} did not resolve: ${result.kind}${result.kind === "unresolved" ? ` (${result.reason})` : ""}`);
      out[d.id] = resolvedDependency(result);
    }
    return out;
  }
  /** What a lock or validation is checked against: the active contracts and current registrations. */
  async function snapshot() {
    const current = await contracts.get(CONTRACT);
    return {
      contracts: { [CONTRACT]: current?.status === "active" ? current.manifest : undefined },
      providers: Object.fromEntries((await registry.list()).map((s) => [s.id, { registrationId: s.registrationId, fingerprint: s.fingerprint, status: s.status }]))
    };
  }
  return { registry, contracts, register, resolver, resolve, records, snapshot, providers, calls };
}
