/**
 * Recipe locks and authorization against the real, installed AppPort implementation (`@appport/core` 1.3.0).
 *
 * Every resolution here comes from AppPort's `ApplicationDependencyResolver` and `resolvedDependency()`; every binding from
 * its `CapabilityBinder` and durable authorization grants; every invocation from its `CapabilityInvoker`. No resolution
 * record is constructed by hand. Where a record is altered, it is to show the alteration is refused.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import {
  CapabilityBinder,
  CapabilityInvoker,
  MemoryAuthorizationGrantStore,
  defineApplication,
  defineCapability,
  durableAuthorizationPolicy,
  implementation,
  resolvedDependency,
  type ApplicationState,
  type AuthorizedCapabilityBinding,
  type ResolvedDependency,
  type ResolvedRequirement
} from "@appport/core";
import { RecipeLockError, checkRecipeLock, createRecipeLock, portableLock, substituteProvider, validateRecipe, type RecipeSource, type ResolvedDependencyRecord } from "../src/index.js";
import { CONTRACT, accountingContract, canonicalEnvironment, claimFor, example, ledgerProvider, requirementsOf } from "./fixtures.js";

// Compile-time: AppPort's own record satisfies what a lock reads.
const _assignable = (record: ResolvedDependency): ResolvedDependencyRecord => record;
void _assignable;

type Env = Awaited<ReturnType<typeof canonicalEnvironment>>;
let env: Env;
let recipe: RecipeSource;
beforeEach(async () => {
  env = await canonicalEnvironment();
  recipe = example();
});
const resolved = async (dependencyId: string, provider?: string): Promise<ResolvedRequirement> => {
  const result = await env.resolve(recipe, dependencyId, provider);
  if (result.kind !== "resolved") throw new Error(`${dependencyId}: ${result.kind}`);
  return result;
};

describe("a recipe lock built from real AppPort resolution", () => {
  it("contract → claim → discovery → resolution → resolvedDependency() → lock, with canonical identity and provider resolution kept apart", async () => {
    // 1–2. The contract is registered and active; the provider is registered with valid claims (canonicalEnvironment).
    const contract = (await env.contracts.get(CONTRACT))!;
    expect(contract.status).toBe("active");
    const provider = (await env.registry.get("com.example.ledger"))!;

    // 3. Discovery finds the provider's own capability as an eligible candidate.
    const discovery = await env.resolver().discoverCanonical({ contract: CONTRACT, capability: "invoice.submit", versionConstraint: "^1" });
    expect(discovery.kind === "discovered" && discovery.eligible.map((c) => [c.provider.id, c.capability.name, c.evaluation.status])).toEqual([["com.example.ledger", "ledger.post", "valid"]]);

    // 4–5. Resolution, and the real record.
    const result = await resolved("submit-invoice");
    const record = resolvedDependency(result);
    expect(record.target).toMatchObject({ kind: "canonical", contract: CONTRACT, contractDigest: contract.digest, capability: "invoice.submit", version: 1 });

    // 6. The lock, from the records.
    const lock = createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    const entry = lock.dependencies.find((d) => d.id === "submit-invoice")!;

    // 7. Portable canonical identity and environment-specific resolution are separate parts.
    expect(entry.canonical).toEqual({ contract: CONTRACT, contractDigest: contract.digest, capability: "invoice.submit", version: 1, capabilityDigest: claimFor(accountingContract(), "invoice.submit", 1).digest });
    expect(entry.resolution).toEqual({
      provider: { application: "com.example.ledger", capability: { name: "ledger.post", version: 1 } },
      registration: { registrationId: provider.registrationId, fingerprint: provider.fingerprint, revision: provider.revision },
      contractRevision: contract.revision,
      fulfillment: { claim: digestOf(record.fulfillment!.claim), status: "valid", compatible: true }
    });
    expect(portableLock(lock).dependencies.find((d) => d.id === "submit-invoice")).toEqual({ id: "submit-invoice", declared: entry.declared, canonical: entry.canonical });
    expect(checkRecipeLock(lock, recipe, await env.snapshot())).toEqual({ ok: true, findings: [] });
    // With the real contract and providers, the recipe is valid in this environment too.
    expect(validateRecipe(recipe, { contracts: (await env.snapshot()).contracts }).findings).toEqual([]);
  });

  it("refuses resolution evidence tied to a different contract revision", async () => {
    const before = await env.records(recipe);
    // Revise only invoice.duplicate: invoice.submit keeps its capability digest, the contract digest changes.
    const revised = accountingContract();
    (revised.capabilities[0] as { description?: string }).description = "Find duplicates (reworded)";
    await env.contracts.register(revised);
    expect(before["submit-invoice"]!.target.kind === "canonical" && before["submit-invoice"]!.target.capabilityDigest).toBe(claimFor(revised, "invoice.submit", 1).digest);
    const current = (await env.snapshot()).contracts;
    expect(() => createRecipeLock(recipe, { contracts: current, resolutions: before })).toThrow(/evaluated a different contract revision/);
  });

  it("requires revalidation when the canonical contract changes, without invalidating the recipe source", async () => {
    const lock = createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    await env.contracts.register(accountingContract({ description: "Record a supplier invoice (clarified)" }));
    const findings = checkRecipeLock(lock, recipe, await env.snapshot()).findings;
    expect(findings.filter((f) => f.code === "LOCK_CAPABILITY_CHANGED").map((f) => f.path)).toEqual(["/dependencies/2/canonical/capabilityDigest"]);
    expect(findings.filter((f) => f.code === "LOCK_CONTRACT_CHANGED")).toHaveLength(3);
    expect(new Set(findings.map((f) => f.action))).toEqual(new Set(["revalidate"]));
    expect(validateRecipe(recipe).sourceOk).toBe(true);
    // And AppPort itself now reports the old claims as stale: nothing can be re-resolved until the provider re-claims.
    const again = await env.resolve(recipe, "submit-invoice");
    expect(again.kind === "unresolved" && again.evaluations?.map((e) => e.status)).toEqual(["stale"]);
  });

  it("requires re-resolution when the provider registration changes, and refuses stale fulfillment evidence", async () => {
    const lock = createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    // The provider re-registers a new revision of its contract.
    const next = ledgerProvider("com.example.ledger");
    await env.registry.register({ identity: { ...next.app.identity, version: "1.0.1" }, manifest: { ...next.app.manifest(), application: { ...next.app.manifest().application, version: "1.0.1" } }, fingerprint: "re-registered", verification: next.app.verify() });
    const check = checkRecipeLock(lock, recipe, await env.snapshot());
    expect(check.findings.map((f) => [f.code, f.action, f.scope])).toEqual(Array(3).fill(["LOCK_PROVIDER_CHANGED", "re-resolve", "environment"]));
    expect(validateRecipe(recipe).sourceOk).toBe(true);
    // Fulfillment evidence is stale once the contract moves on: a lock entry claiming otherwise is refused.
    const tampered = structuredClone(lock);
    (tampered.dependencies[2]!.resolution!.fulfillment as { status: string }).status = "stale";
    expect(checkRecipeLock(tampered, recipe).findings.map((f) => [f.code, f.action])).toEqual([["LOCK_FULFILLMENT_INELIGIBLE", "re-resolve"]]);
    // And a record whose fulfillment is not valid is never locked.
    const record = structuredClone((await env.records(recipe))["submit-invoice"]!) as { fulfillment: { status: string } };
    record.fulfillment.status = "stale";
    const current = (await env.snapshot()).contracts;
    expect(() => createRecipeLock(recipe, { contracts: current, resolutions: { "submit-invoice": record as never } })).toThrow(/only a valid fulfillment can satisfy/);
  });

  it("substitutes a provider only with a valid fulfillment of the same canonical capability and revision", async () => {
    const lock = createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    const globex = ledgerProvider("com.globex.ledger", accountingContract(), env.calls);
    await env.register(globex.app);
    // Two eligible providers are ambiguous: AppPort picks neither.
    expect((await env.resolve(recipe, "submit-invoice")).kind).toBe("ambiguous");
    // An explicit substitution, from a real resolution pinned to the other provider.
    const replacement = resolvedDependency(await resolved("submit-invoice", "com.globex.ledger"));
    const substituted = substituteProvider(lock, "submit-invoice", replacement);
    expect(substituted.dependencies.find((d) => d.id === "submit-invoice")?.resolution?.provider.application).toBe("com.globex.ledger");
    expect(substituted.dependencies.find((d) => d.id === "get-invoice")?.resolution?.provider.application).toBe("com.example.ledger");
    // Not with a resolution of another canonical capability.
    const other = resolvedDependency(await resolved("get-invoice", "com.globex.ledger"));
    expect(() => substituteProvider(lock, "submit-invoice", other)).toThrow(/not org.example.accounting invoice.submit@1/);
    // Not with one made against a different contract revision.
    await env.contracts.register(accountingContract({ description: "Record a supplier invoice (clarified)" }));
    // Same revision as the lock: consistent with it, and the lock itself now reports that its revision is no longer current…
    const consistent = substituteProvider(lock, "submit-invoice", replacement);
    expect(checkRecipeLock(consistent, recipe, await env.snapshot()).findings.map((f) => f.code)).toContain("LOCK_CONTRACT_CHANGED");
    const relocked = createRecipeLock(recipe, { contracts: { [CONTRACT]: accountingContract({ description: "Record a supplier invoice (clarified)" }) } });
    expect(() => substituteProvider(relocked, "submit-invoice", replacement)).toThrow(RecipeLockError); // …but not with a lock of the new revision
    // Not with a fulfillment that is not valid.
    const stale = structuredClone(replacement) as { fulfillment: { status: string } };
    stale.fulfillment.status = "invalid";
    expect(() => substituteProvider(lock, "submit-invoice", stale as never)).toThrow(/only a valid fulfillment/);
  });

  it("a provider without a valid claim yields no record to lock: the resolver refuses it, and nothing falls back to its name", async () => {
    const strict = await canonicalEnvironment({ providers: [] });
    // Same name, same schemas, same permission as the canonical capability, and no claim.
    const def = accountingContract().capabilities.find((c) => c.name === "invoice.submit")!;
    const sameName = defineCapability({
      name: "invoice.submit", version: 1, effect: "consequential", authorization: [...def.authorization],
      input: fromJSONSchema(def.inputSchema as never), output: fromJSONSchema(def.outputSchema as never),
      handler: async () => ({ invoiceId: "x", status: "submitted" }) as never
    } as never);
    await strict.register(defineApplication({ identity: { id: "com.example.lookalike", name: "Lookalike", version: "1.0.0" }, provides: [sameName], implementations: { "invoice.submit@1": implementation(sameName.handler as never) } }));
    expect((await strict.resolver().resolveRequirement({ name: "invoice.submit", version: 1 })).kind).toBe("resolved"); // by name, it is there
    const result = await strict.resolve(recipe, "submit-invoice");
    expect(result.kind).toBe("unresolved");
    await expect(strict.records(recipe)).rejects.toThrow(/did not resolve/);
  });
});

describe("authorization through the real binder: a claim, a lock or a canonical name grants nothing", () => {
  const invoker = new CapabilityInvoker();
  const context = (binding: AuthorizedCapabilityBinding) => ({
    requestId: `req-${Math.random()}`, traceId: "trace", capability: { ...binding.capability }, authorization: { permissions: [] }, metadata: {},
    signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {} }, extensions: {}, emit: async () => {}, services: {}
  });
  let consumer: ApplicationState;
  let grants: MemoryAuthorizationGrantStore;
  let binder: CapabilityBinder;
  beforeEach(async () => {
    consumer = await env.register(defineApplication({ identity: { id: "com.example.payables", name: "Payables", version: "1.0.0" }, provides: [], requires: requirementsOf(recipe) }));
    grants = new MemoryAuthorizationGrantStore();
    binder = new CapabilityBinder(durableAuthorizationPolicy(grants));
  });
  const submit = () => env.providers["com.example.ledger"]!.capabilities["ledger.post"]!;
  const input = { supplierId: "s1", invoiceNumber: "INV-1", amount: 120, currency: "EUR", dueDate: "2026-11-30" };

  it("a valid claim and a lock grant nothing; a grant for the canonical name is not a grant for the provider's capability", async () => {
    const result = await resolved("submit-invoice");
    createRecipeLock(recipe, { contracts: (await env.snapshot()).contracts, resolutions: await env.records(recipe) });
    const none = await binder.bindResolution(consumer, result);
    expect(none.kind === "denied" && none.authorization.reason).toBe("policy_denied");
    await grants.grant({ consumerId: consumer.id, providerId: "com.example.ledger", capabilityName: "invoice.submit", capabilityVersion: 1 });
    const canonicalName = await binder.bindResolution(consumer, result);
    expect(canonicalName.kind === "denied" && canonicalName.authorization.message).toMatch(/com\.example\.ledger::ledger\.post@1/);
  });

  it("the provider-capability grant permits invocation when every other check passes", async () => {
    await grants.grant({ consumerId: consumer.id, providerId: "com.example.ledger", capabilityName: "ledger.post", capabilityVersion: 1 });
    const bound = await binder.bindResolution(consumer, await resolved("submit-invoice"));
    if (bound.kind !== "authorized") throw new Error("expected a binding");
    expect(bound.binding.capability).toEqual({ name: "ledger.post", version: 1 });
    expect(bound.binding.canonical).toMatchObject({ contract: CONTRACT, capability: "invoice.submit", requiredAuthority: ["accounting.invoice.submit"], enforcedAuthority: ["accounting.invoice.submit"] });
    expect((await invoker.invoke({ binding: bound.binding, input }, submit() as never, context(bound.binding) as never)).kind).toBe("success");
    expect(env.calls).toEqual(["com.example.ledger:ledger.post"]);
  });

  it("forged, mismatched and stale canonical evidence is refused, and a stale binding never reaches the implementation", async () => {
    await grants.grant({ consumerId: consumer.id, providerId: "com.example.ledger", capabilityName: "ledger.post", capabilityVersion: 1 });
    const result = await resolved("submit-invoice");
    const forged = await binder.bindResolution(consumer, { ...result });
    const mismatched = await binder.bindResolution(consumer, { ...result, canonical: { ...result.canonical!, provider: { ...result.canonical!.provider, capability: { name: "ledger.read", version: 1 } } } });
    expect([forged, mismatched].map((r) => r.kind === "denied" && r.authorization.reason)).toEqual(["provider_not_authorized", "provider_not_authorized"]);

    const bound = await binder.bindResolution(consumer, result);
    if (bound.kind !== "authorized") throw new Error("expected a binding");
    await env.contracts.register(accountingContract({ description: "Record a supplier invoice (clarified)" }));
    const refused = await invoker.invoke({ binding: bound.binding, input }, submit() as never, context(bound.binding) as never);
    expect(refused.kind === "failed" && refused.error.reason).toMatch(/revision 1 was evaluated; it is now revision 2/);
    expect(env.calls).toEqual([]);
    expect((await binder.bindResolution(consumer, result)).kind).toBe("denied");
  });

  it("name-based resolution and binding behave as before, and canonical and name-only declarations never match", async () => {
    // A name-only requirement on a provider's own capability resolves by name, with no canonical evidence.
    const nameOnly = await env.resolver().resolveRequirement({ name: "ledger.post", version: 1 });
    expect(nameOnly.kind === "resolved" && nameOnly.canonical).toBeUndefined();
    const plainConsumer = await env.register(defineApplication({ identity: { id: "com.example.plain", name: "Plain", version: "1.0.0" }, provides: [], requires: [{ name: "ledger.post", version: 1 }] }));
    const seen: object[] = [];
    const plainBinder = new CapabilityBinder({ evaluate: (c) => (seen.push(c), { kind: "authorized" }) });
    const plain = await plainBinder.bindResolution(plainConsumer, nameOnly as ResolvedRequirement);
    expect(plain.kind).toBe("authorized");
    expect(Object.keys(seen[0]!).sort()).toEqual(["capabilityName", "capabilityVersion", "consumer", "provider"]);
    // A canonical resolution is not covered by a name-only declaration, nor the reverse.
    expect((await plainBinder.bindResolution(plainConsumer, await resolved("submit-invoice"))).kind).toBe("denied");
    expect((await plainBinder.bindResolution(consumer, nameOnly as ResolvedRequirement)).kind).toBe("denied");
    // And a canonical requirement never resolves to a same-named capability by name.
    expect((await env.resolver().resolveRequirement({ name: "ledger.post", version: 1, canonical: { contract: CONTRACT } })).kind).toBe("unresolved");
  });
});
