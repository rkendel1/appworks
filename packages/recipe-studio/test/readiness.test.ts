import { describe, expect, it } from "vitest";
import type { RecipeSource } from "@appport/recipe";
import { contractDigest } from "@appport/protocol";
import { applyEdits, assess, newRecipe, type StudioEnvironment } from "../src/index.js";
import { LEDGER_NAMES } from "../../recipe-runtime/test/accounting/environment.js";
import { BOOKS_NAMES, studioEnvironment, supplierInvoice, tempDir, useCleanup } from "./support.js";

useCleanup();
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

/** A recipe with no human task: look the invoice up, then end. Valid, and checkable end to end without any role. */
async function lookupRecipe(env: StudioEnvironment): Promise<RecipeSource> {
  const catalog = await env.gateway.catalog!();
  return applyEdits(newRecipe({ id: "org.example.recipes.lookup", name: "Lookup", objective: "Find out whether an invoice exists" }), [
    { op: "field", where: "inputs", name: "supplierId", schema: { type: "string", minLength: 1, "x-appport-concept": "https://vocab.example.org/finance#supplier-id" }, required: true },
    { op: "field", where: "inputs", name: "invoiceNumber", schema: { type: "string", minLength: 1, "x-appport-concept": "https://vocab.example.org/finance#invoice-number" }, required: true },
    { op: "addCapability", step: "check", contract: "org.example.accounting", capability: "invoice.duplicate", on: { success: "done", failure: "broken" } },
    { op: "step", step: { id: "done", kind: "end", outcome: "completed", output: [] } },
    { op: "step", step: { id: "broken", kind: "end", outcome: "failed" } },
    { op: "outcome", outcome: { description: "The lookup ran.", verify: [] } }
  ], { catalog }) as RecipeSource;
}

describe("readiness: what is established, and what is not", () => {
  it("a sound recipe checked against no environment is unassessed, never ready", async () => {
    const r = await assess(supplierInvoice(), undefined);
    expect(r).toMatchObject({ verdict: "unassessed", sourceOk: true, executable: false });
    expect(r.unresolved[0]!.subject).toBe("environment");
  });

  it("a recipe with source errors is invalid whatever the environment holds", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const broken = applyEdits(supplierInvoice(), [{ op: "removeStep", id: "validate-fields" }]); // the start step is gone
    const r = await assess(broken, studio);
    expect(r.verdict).toBe("invalid");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.every((f) => f.action.length > 0)).toBe(true);
    expect(r.dependencies).toEqual([]); // nothing about the environment is claimed for an invalid recipe
  });

  it("is ready when every checkable fact holds: contract, one provider, a grant, and permission to start", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const r = await assess(await lookupRecipe(studio), studio, { principal: "alice" });
    expect(r).toMatchObject({ verdict: "ready", findings: [], unresolved: [], environment: "env1" });
    expect(r.dependencies[0]).toMatchObject({ contractAvailable: true, providers: { state: "resolved", eligible: 1 }, binding: { provider: "com.example.ledger" }, authority: { state: "granted" } });
    expect(r.executable).toBe(false); // a verdict is not an execution
  });

  it("the supplier-invoice recipe is ready-with-unresolved, because nobody can check its approver role yet; it is not called ready", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const r = await assess(supplierInvoice(), studio, { principal: "alice" });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.verdict).toBe("ready-with-unresolved");
    expect(r.unresolved.map((u) => u.subject)).toEqual(["role role:ap-manager"]);
    expect(r.dependencies.map((d) => d.authority.state)).toEqual(["granted", "granted", "granted"]);
  });

  it("an environment that cannot report authority, or has none for starting, leaves those facts unresolved instead of assuming them", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1", { authority: null });
    const { access: _access, ...gateway } = studio.gateway;
    const blind: StudioEnvironment = { name: "blind", gateway };
    const r = await assess(await lookupRecipe(studio), blind, { principal: "alice" });
    expect(r.verdict).toBe("ready-with-unresolved");
    expect(r.unresolved.map((u) => u.subject).sort()).toEqual(["authority for invoice-duplicate", "who may start this recipe"]);
  });
});

describe("readiness: negative cases name the problem and what to do", () => {
  it("a capability the environment's contract does not have", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const recipe = applyEdits(supplierInvoice(), [{ op: "dependency", dependency: { ...supplierInvoice().requires[0]!, target: { contract: "org.example.accounting", capability: "invoice.teleport" } } }]);
    const r = await assess(recipe, studio);
    expect(r.verdict).toBe("blocked");
    const finding = r.findings.find((f) => f.code === "ENV_CAPABILITY_UNAVAILABLE")!;
    expect(finding).toMatchObject({ dependency: "find-duplicate", severity: "error", scope: "environment" });
    expect(finding.action).toMatch(/choose one it offers|revision/);
  });

  it("a contract the environment does not hold", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const recipe = applyEdits(supplierInvoice(), [{ op: "dependency", dependency: { ...supplierInvoice().requires[0]!, target: { contract: "org.example.shipping", capability: "parcel.track" } } }]);
    const r = await assess(recipe, studio);
    expect(r.verdict).toBe("blocked");
    expect(codes(r)).toContain("ENV_CONTRACT_UNAVAILABLE");
    expect(r.dependencies.find((d) => d.id === "find-duplicate")).toMatchObject({ contractAvailable: false });
  });

  it("a step that expects something the capability's declared contract does not give", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const recipe = await lookupRecipe(studio);
    expect((await assess(recipe, studio)).verdict).toBe("ready");
    // The recipe is self-consistent (nothing reads `duplicate`), but claims the capability answers with text where its contract says boolean.
    const wrong = structuredClone(recipe) as any;
    wrong.steps[0].expects.output.properties.duplicate.type = "string";
    const r = await assess(wrong, studio);
    expect(r.verdict).toBe("blocked");
    const f = r.findings.find((x) => x.code === "ENV_SCHEMA_INCOMPATIBLE");
    expect(f, JSON.stringify(codes(r))).toMatchObject({ scope: "environment", step: "check", severity: "error" });
    expect(f!.action).toMatch(/update the step's expected shapes/);
  });

  it("an input the capability's contract cannot accept from this recipe's data is a source error the author sees before any environment is asked", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const recipe = applyEdits(supplierInvoice(), [{ op: "field", where: "inputs", name: "amount", schema: { type: "string" }, required: true }]); // the contract says number
    const r = await assess(recipe, studio);
    expect(r.verdict).toBe("invalid");
    expect(r.findings.some((x) => x.scope === "source" && ["SCHEMA_MISMATCH", "EXPRESSION_TYPE", "MAPPING_INVALID"].includes(x.code))).toBe(true);
  });

  it("authority that has not been delegated: the recipe is blocked, the finding says who can fix it, and the Studio grants nothing", async () => {
    const { studio, env } = await studioEnvironment(tempDir(), "env1", { grant: false });
    const before = JSON.stringify(await Promise.all(Object.values({ a: "ledger.duplicates", b: "ledger.read", c: "ledger.post", d: "ledger.resolve" }).map((n) => env.grants.find({ consumerId: env.consumer.id, providerId: "com.example.ledger", capabilityName: n, capabilityVersion: 1 }))));
    const r = await assess(supplierInvoice(), studio, { principal: "alice" });
    expect(r.verdict).toBe("blocked");
    expect(r.findings.filter((f) => f.code === "ACCESS_DENIED")).toHaveLength(3);
    expect(r.findings.find((f) => f.code === "ACCESS_DENIED")!.action).toMatch(/environment's owner.*The Studio cannot/);
    expect(r.dependencies.every((d) => d.authority.state === "denied")).toBe(true);
    // asking changed nothing: still no grant for any capability, however many times it is asked
    await assess(supplierInvoice(), studio);
    const after = JSON.stringify(await Promise.all(Object.values({ a: "ledger.duplicates", b: "ledger.read", c: "ledger.post", d: "ledger.resolve" }).map((n) => env.grants.find({ consumerId: env.consumer.id, providerId: "com.example.ledger", capabilityName: n, capabilityVersion: 1 }))));
    expect(after).toBe(before);
    expect(after).not.toContain("granted");
  });

  it("a principal the environment does not let start the recipe", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1", { authority: { canStart: (p) => p === "alice", canAnswer: () => true } });
    expect((await assess(await lookupRecipe(studio), studio, { principal: "alice" })).verdict).toBe("ready");
    const r = await assess(await lookupRecipe(studio), studio, { principal: "mallory" });
    expect(r.verdict).toBe("blocked");
    expect(r.findings.find((f) => f.code === "RUNTIME_NOT_PERMITTED")).toMatchObject({ scope: "authority" });
  });

  it("a provider binding that cannot be resolved: none registered, or more than one", async () => {
    const none = await studioEnvironment(tempDir(), "none", { providers: [] });
    const a = await assess(supplierInvoice(), none.studio);
    expect(a.verdict).toBe("blocked");
    expect(codes(a)).toContain("ENV_NO_ELIGIBLE_PROVIDER");
    expect(a.dependencies.every((d) => d.providers.state === "none" && !d.binding)).toBe(true);

    const two = await studioEnvironment(tempDir(), "two", { providers: [{ id: "com.example.ledger", names: LEDGER_NAMES }, { id: "com.globex.books", names: BOOKS_NAMES }] });
    const b = await assess(supplierInvoice(), two.studio);
    expect(b.verdict).toBe("blocked");
    expect(codes(b)).toContain("PROVIDER_AMBIGUOUS");
    expect(b.findings.find((f) => f.code === "PROVIDER_AMBIGUOUS")!.action).toMatch(/does not choose/); // choosing is the environment's, not the Studio's
    expect(b.dependencies.every((d) => d.providers.state === "ambiguous" && !d.binding)).toBe(true);
  });

  it("a capability whose contract changed since the recipe was packaged", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const recipe = await lookupRecipe(studio);
    const snapshot = await studio.gateway.snapshot(recipe.requires);
    const { createRecipeLock } = await import("@appport/recipe");
    const previous = { digest: "sha256:" + "0".repeat(64), packagedAt: "2026-10-21T00:00:00Z", recipeDigest: "x", lock: createRecipeLock(recipe, { contracts: snapshot.contracts as never }) };
    expect((await assess(recipe, studio, { previous })).verdict).toBe("ready"); // unchanged contract: nothing to say

    // The same environment, its contract revised (the capability's output gained a field).
    const revised: StudioEnvironment = {
      ...studio,
      name: "env1-revised",
      gateway: {
        ...studio.gateway,
        async snapshot(requires) {
          const s = await studio.gateway.snapshot(requires);
          const manifest = structuredClone(s.contracts!["org.example.accounting"]!) as any;
          const cap = manifest.capabilities.find((c: any) => c.name === "invoice.duplicate");
          for (const v of cap.definitions ?? [cap]) v.outputSchema = { ...v.outputSchema, properties: { ...v.outputSchema.properties, confidence: { type: "number" } } };
          expect(contractDigest(manifest)).not.toBe(contractDigest(s.contracts!["org.example.accounting"]!));
          return { ...s, contracts: { ...s.contracts, "org.example.accounting": manifest } };
        }
      }
    };
    const r = await assess(recipe, revised, { previous });
    expect(r.verdict).toBe("blocked");
    expect(r.findings.find((f) => f.code === "CONTRACT_CHANGED")).toMatchObject({ scope: "environment", message: expect.stringContaining("invoice.duplicate") });
  });
});
