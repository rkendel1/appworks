// A recipe lock over real canonical resolution, using ONLY installed packages: the packed @appport/recipe tarball and the
// published AppPort packages from the registry (@appport/core, @appport/protocol, @appport/schema). Nothing is imported
// from either repository, and no resolution record is built by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANONICAL_CONTRACT_EXTENSION, INTEGRATION_EXTENSION, claimFor } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import {
  ApplicationDependencyResolver,
  ApplicationRegistry,
  CanonicalContractRegistry,
  CapabilityBinder,
  MemoryApplicationStateStore,
  MemoryAuthorizationGrantStore,
  defineApplication,
  defineCapability,
  durableAuthorizationPolicy,
  implementation,
  resolvedDependency
} from "@appport/core";
import { checkRecipeLock, createRecipeLock, createRecipePackage, validateRecipe } from "@appport/recipe";

const ok = (message) => console.log(`  ok  ${message}`);
const recipe = JSON.parse(readFileSync("recipe.json", "utf8"));
const step = (id) => recipe.steps.find((s) => s.id === id);
const CONTRACT = "org.example.accounting";

// A contract written for the example (a consumer-side fixture: org.example.accounting is not a published contract).
const entry = (name, d) => ({ name, versions: [1], latestVersion: 1, ...{ version: 1, ...d }, definitions: [{ version: 1, ...d }] });
const contract = {
  protocol: "appport/1",
  application: { id: CONTRACT, name: "Accounting (consumer fixture)", version: "1.0.0" },
  capabilities: [
    entry("invoice.duplicate", { kind: "request", inputSchema: step("check-duplicate").expects.input, outputSchema: step("check-duplicate").expects.output, authorization: ["accounting.invoice.read"], effect: "observation" }),
    entry("invoice.get", { kind: "request", inputSchema: { type: "object", required: ["invoiceId"], properties: { invoiceId: { type: "string" } } }, outputSchema: { type: "object", required: ["invoiceId", "invoiceNumber", "supplierId", "status"], properties: { invoiceId: { type: "string" }, invoiceNumber: { type: "string" }, supplierId: { type: "string" }, status: { type: "string", enum: ["submitted", "rejected"] } } }, authorization: ["accounting.invoice.read"], effect: "observation" }),
    entry("invoice.submit", { kind: "request", inputSchema: step("submit").expects.input, outputSchema: step("submit").expects.output, authorization: ["accounting.invoice.submit"], effect: "consequential", idempotency: "supported" })
  ],
  events: [],
  transports: [],
  extensions: [CANONICAL_CONTRACT_EXTENSION, INTEGRATION_EXTENSION],
  attributes: { [INTEGRATION_EXTENSION]: { capabilities: { "invoice.submit@1": {
    approval: { required: false },
    verify: [{ id: "invoice-recorded", kind: "state", via: { capability: "invoice.get", version: 1, input: { invoiceId: { $output: "/invoiceId" } } }, expect: [{ at: "/invoiceNumber", equals: { $input: "/invoiceNumber" } }] }],
    failures: [{ code: "TIMEOUT", retry: "after-verification", effect: "possible" }]
  } } } }
};

// A provider implementing it under its own names, with claims.
const def = (name) => contract.capabilities.find((c) => c.name === name);
const make = (local, canonical, extra = {}) => defineCapability({
  name: local, version: 1, input: fromJSONSchema(def(canonical).inputSchema), output: fromJSONSchema(def(canonical).outputSchema),
  authorization: [...def(canonical).authorization], effect: def(canonical).effect, ...(def(canonical).idempotency ? { idempotency: def(canonical).idempotency } : {}),
  fulfills: [claimFor(contract, canonical, 1)], handler: async () => ({ invoiceId: "inv-1", status: "submitted", duplicate: false }), ...extra
});
const capabilities = [
  make("ledger.duplicates", "invoice.duplicate"),
  make("ledger.read", "invoice.get"),
  make("ledger.post", "invoice.submit", { integration: { approval: { required: false }, verify: [{ id: "invoice-recorded", kind: "state", via: { capability: "ledger.read", version: 1, input: { invoiceId: { $output: "/invoiceId" } } }, expect: [{ at: "/invoiceNumber", equals: { $input: "/invoiceNumber" } }] }], failures: [{ code: "TIMEOUT", retry: "after-verification", effect: "possible" }] } })
];
const ledger = defineApplication({ identity: { id: "com.example.ledger", name: "Ledger", version: "1.0.0" }, provides: capabilities, implementations: Object.fromEntries(capabilities.map((c) => [`${c.name}@1`, implementation(c.handler)])) });

const registry = new ApplicationRegistry(new MemoryApplicationStateStore());
const contracts = new CanonicalContractRegistry();
const register = async (app) => registry.activate((await registry.register({ identity: app.identity, manifest: app.manifest(), fingerprint: app.fingerprint(), verification: app.verify() })).id);
await contracts.register(contract);
await contracts.activate(CONTRACT);
await register(ledger);
const resolver = new ApplicationDependencyResolver(registry, { contracts });
const requirements = recipe.requires.map((d) => ({ name: d.target.capability, version: 1, versionConstraint: d.versionConstraint, canonical: { contract: d.target.contract } }));

const results = {};
for (const [i, d] of recipe.requires.entries()) {
  const result = await resolver.resolveRequirement(requirements[i]);
  assert.equal(result.kind, "resolved", `${d.id} resolves`);
  results[d.id] = result;
}
const snapshot = async () => ({
  contracts: { [CONTRACT]: (await contracts.get(CONTRACT)).manifest },
  providers: Object.fromEntries((await registry.list()).map((s) => [s.id, { registrationId: s.registrationId, fingerprint: s.fingerprint, status: s.status }]))
});
const lock = createRecipeLock(recipe, { contracts: (await snapshot()).contracts, resolutions: Object.fromEntries(Object.entries(results).map(([id, r]) => [id, resolvedDependency(r)])) });
assert.deepEqual(lock.dependencies.find((d) => d.id === "submit-invoice").resolution.provider, { application: "com.example.ledger", capability: { name: "ledger.post", version: 1 } });
assert.deepEqual(checkRecipeLock(lock, recipe, await snapshot()), { ok: true, findings: [] });
assert.deepEqual(validateRecipe(recipe, { contracts: (await snapshot()).contracts }).findings, []);
assert.ok(createRecipePackage(recipe, lock).lock.dependencies.every((d) => !("resolution" in d)));
ok("a recipe lock is built from real resolvedDependency() records of the published @appport/core, and its package carries none");

const consumer = await register(defineApplication({ identity: { id: "com.example.payables", name: "Payables", version: "1.0.0" }, provides: [], requires: requirements }));
const grants = new MemoryAuthorizationGrantStore();
const binder = new CapabilityBinder(durableAuthorizationPolicy(grants));
assert.equal((await binder.bindResolution(consumer, results["submit-invoice"])).kind, "denied");
await grants.grant({ consumerId: consumer.id, providerId: "com.example.ledger", capabilityName: "invoice.submit", capabilityVersion: 1 });
assert.equal((await binder.bindResolution(consumer, results["submit-invoice"])).kind, "denied");
await grants.grant({ consumerId: consumer.id, providerId: "com.example.ledger", capabilityName: "ledger.post", capabilityVersion: 1 });
assert.equal((await binder.bindResolution(consumer, results["submit-invoice"])).kind, "authorized");
assert.equal((await binder.bindResolution(consumer, { ...results["submit-invoice"] })).kind, "denied");
ok("the lock grants nothing: binding needs a grant for the provider's capability, not the canonical name, and forged evidence is refused");

await contracts.register({ ...contract, application: { ...contract.application, version: "1.0.1" } });
const stale = checkRecipeLock(lock, recipe, await snapshot());
assert.ok(stale.findings.every((f) => f.action === "revalidate") && stale.findings.some((f) => f.code === "LOCK_CONTRACT_CHANGED"));
assert.equal(validateRecipe(recipe).sourceOk, true);
ok("a revised contract requires revalidation of the lock; the recipe source stays valid");

console.log("\nCanonical recipe-lock consumer passed against the installed packages");
