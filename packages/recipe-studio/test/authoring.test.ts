import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRecipe, type RecipeSource } from "@appport/recipe";
import { StudioError, StudioStore, applyEdits, inspectStep, newRecipe, recipeCard, recipeDigestOf, recipeBytes } from "../src/index.js";
import { studioEnvironment, supplierInvoice, supplierInvoiceFromEmpty, tempDir, useCleanup } from "./support.js";

useCleanup();

describe("projects: save and reopen without loss", () => {
  it("saves an incomplete, invalid draft as it is and reopens it identically, in a new process-equivalent store", () => {
    const root = tempDir();
    const store = new StudioStore(root);
    const draft = applyEdits(newRecipe({ id: "org.example.recipes.draft", name: "Draft", objective: "Not finished" }), [{ op: "field", where: "inputs", name: "amount", schema: { type: "number" }, required: true }]);
    expect(validateRecipe(draft).sourceOk).toBe(false); // no steps yet: the draft is invalid, and saving it is still allowed
    const saved = store.create("draft", draft, { product: "product://example/draft", version: "0.1.0" });

    const reopened = new StudioStore(root).open("draft");
    expect(reopened.recipe).toEqual(draft);
    expect(reopened.meta.release).toEqual({ product: "product://example/draft", version: "0.1.0" });
    expect(readFileSync(new StudioStore(root).recipePath("draft"), "utf8")).toBe(recipeBytes(draft)); // recipe.json is the canonical document, byte for byte
    expect(reopened.meta.revision).toBe(saved.meta.revision);
  });

  it("refuses to save over a revision the author was not looking at, and loses nothing", () => {
    const store = new StudioStore(tempDir());
    const first = store.create("a", newRecipe({ id: "org.example.recipes.a", name: "A", objective: "o" }));
    const second = store.save("a", applyEdits(first.recipe, [{ op: "meta", name: "A2" }]), first.meta.revision);
    expect(() => store.save("a", applyEdits(first.recipe, [{ op: "meta", name: "stale" }]), first.meta.revision)).toThrow(/revision/);
    expect((store.open("a").recipe as RecipeSource).name).toBe("A2");
    expect(second.meta.revision).toBe(first.meta.revision + 1);
  });

  it("an imported recipe is the same recipe, and importing records nothing but the recipe", () => {
    const root = tempDir();
    const store = new StudioStore(root);
    const text = readFileSync(new URL("../../../examples/supplier-invoice/recipe.json", import.meta.url), "utf8");
    store.import("imported", text);
    expect(recipeDigestOf(store.open("imported").recipe)).toBe(recipeDigestOf(supplierInvoice()));
    // what a project directory holds: the recipe and the Studio's own bookkeeping; no binding, grant, key, policy or lock
    expect(JSON.stringify(store.open("imported").meta)).not.toMatch(/resolution|grant|privateKey|policy|provider/i);
    expect(existsSync(join(root, "imported", "lock.json"))).toBe(false);
  });

  it("refuses names that could leave the projects directory, and a second project of the same name", () => {
    const store = new StudioStore(tempDir());
    expect(() => store.create("../escape", {})).toThrow(StudioError);
    store.create("ok", newRecipe({ id: "a.b", name: "n", objective: "o" }));
    expect(() => store.create("ok", {})).toThrow(/already exists/);
  });
});

describe("authoring: composing from the environment's capabilities", () => {
  it("makes the supplier-invoice recipe from an empty one; the contract's part is derived, the author's is added, and the result is the checked-in recipe", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const catalog = await studio.gateway.catalog!();
    const { recipe, derived, example } = supplierInvoiceFromEmpty(catalog);

    // What the catalog alone produced, before the author added anything, already agrees with the hand-written recipe on everything a contract determines.
    for (const [id, step] of Object.entries(derived)) {
      const written = example.steps.find((s) => s.id === id) as any;
      expect({ kind: step.kind, uses: step.uses, effect: step.effect, expects: step.expects }).toEqual({ kind: written.kind, uses: written.uses, effect: written.effect, expects: written.expects });
      expect(step.verify?.methods).toEqual(written.verify?.methods);
    }
    expect(derived["submit"].input).toEqual((example.steps.find((s) => s.id === "submit") as any).input); // every field name matches, so the suggested wiring is exactly what was written by hand
    expect(validateRecipe(recipe).sourceOk).toBe(true);
    expect(recipeDigestOf(recipe)).toBe(recipeDigestOf(example)); // member for member, the recipe that was checked in
  });

  it("derives a step's dependency, effect and declared verification from the contract, and suggests wiring only for same-named, compatible fields", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const catalog = await studio.gateway.catalog!();
    const base = applyEdits(newRecipe({ id: "org.example.recipes.x", name: "X", objective: "o" }), [
      { op: "field", where: "inputs", name: "supplierId", schema: { type: "string", "x-appport-concept": "https://vocab.example.org/finance#supplier-id" }, required: true },
      { op: "field", where: "inputs", name: "invoiceNumber", schema: { type: "string" }, required: true }, // same name and type, but no stated meaning
      { op: "field", where: "inputs", name: "amount", schema: { type: "string", "x-appport-concept": "https://vocab.example.org/finance#invoice-amount" }, required: true } // a string where the contract wants a number
    ]);
    const next = applyEdits(base, [{ op: "addCapability", step: "submit", contract: "org.example.accounting", capability: "invoice.submit", on: { success: "done", failure: "done", uncertain: "done" } }], { catalog });
    const step = next["steps"][0];
    expect(step).toMatchObject({ kind: "capability", effect: "consequential", verify: { methods: ["invoice-recorded"] }, uses: "invoice-submit" });
    expect(next["requires"][0]).toMatchObject({ relationship: "invokes", target: { contract: "org.example.accounting", capability: "invoice.submit" }, versionConstraint: "^1" });
    expect(step.input.map((r: any) => r.to)).toEqual(["/supplierId"]); // not wired, not guessed: `invoiceNumber` has no stated meaning, and `amount` is a string here and a number there
    expect(next["start"]).toBe("submit");
    expect(base["steps"]).toEqual([]); // an edit returns a new recipe
  });

  it("will not add a capability the environment does not hold", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const catalog = await studio.gateway.catalog!();
    const draft = newRecipe({ id: "a.b", name: "n", objective: "o" });
    expect(() => applyEdits(draft, [{ op: "addCapability", step: "s", contract: "org.example.shipping", capability: "x", on: { success: "a", failure: "b" } }], { catalog })).toThrow(/holds no active contract/);
    expect(() => applyEdits(draft, [{ op: "addCapability", step: "s", contract: "org.example.accounting", capability: "invoice.nope", on: { success: "a", failure: "b" } }], { catalog })).toThrow(/no capability/);
  });
});

describe("preview: the recipe card and step inspection", () => {
  const card = recipeCard(supplierInvoice());

  it("lays the inputs out as ingredients, with how each is prepared", () => {
    expect(card.rows.map((r) => r.name)).toEqual(["supplierId", "invoiceNumber", "amount", "currency", "dueDate", "purchaseOrder"]);
    expect(card.rows.find((r) => r.name === "currency")).toMatchObject({ required: true, prep: expect.stringContaining("one of EUR, USD, GBP") });
    expect(card.rows.find((r) => r.name === "purchaseOrder")?.required).toBe(false);
  });

  it("makes each step a column spanning exactly the inputs it consumes; a step that reads only earlier results spans all", () => {
    const span = (id: string) => {
      const c = card.columns.find((x) => x.step === id)!;
      return [c.from, c.to];
    };
    expect(span("check-duplicate")).toEqual([0, 1]);
    expect(span("validate-fields")).toEqual([2, 2]);
    expect(span("needs-approval")).toEqual([2, 5]);
    expect(span("is-duplicate")).toEqual([0, 5]);
    expect(card.columns.map((c) => c.step).slice(0, 4)).toEqual(["validate-fields", "check-duplicate", "is-duplicate", "needs-approval"]); // the order things happen in
    expect(card.columns.some((c) => c.kind === "end")).toBe(false);
  });

  it("states what the environment must provide and where each run can end, and names no provider", () => {
    expect(card.setup.join("\n")).toContain("invoice.submit from org.example.accounting");
    expect(card.setup.join("\n")).toContain("role:ap-manager");
    expect(card.finish.ends.find((e) => e.step === "submission-uncertain")?.outcome).toBe("uncertain");
    expect(JSON.stringify(card)).not.toMatch(/com\.example\.ledger|com\.globex/);
  });

  it("inspects a step: what it needs and which of it is mapped, what it produces, and the authority its contract declares", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const catalog = await studio.gateway.catalog!();
    const submit = inspectStep(supplierInvoice(), "submit", catalog)!;
    expect(submit.needs?.find((f) => f.name === "purchaseOrder")).toMatchObject({ mapped: true, from: "/input/purchaseOrder", required: false });
    expect(submit.produces?.map((f) => f.name)).toContain("invoiceId");
    expect(submit.declaredAuthority).toMatchObject({ effect: "consequential", scopes: ["accounting.invoice.submit"], approvalRequiredByContract: true, contractKnown: true });
    expect(submit.routes.map((r) => r.label)).toEqual(["on.success", "on.failure", "on.uncertain"]);
    expect(inspectStep(supplierInvoice(), "request-approval", catalog)).toMatchObject({ kind: "task", assignee: "role:ap-manager" });
    expect(inspectStep(supplierInvoice(), "nope", catalog)).toBeUndefined();
  });

  it("an unmapped required field is visible in the inspection and named by validation, with a way forward", async () => {
    const { studio } = await studioEnvironment(tempDir(), "env1");
    const catalog = await studio.gateway.catalog!();
    const recipe = applyEdits(newRecipe({ id: "org.example.recipes.y", name: "Y", objective: "o" }), [{ op: "addCapability", step: "check", contract: "org.example.accounting", capability: "invoice.duplicate", on: { success: "done", failure: "done" } }], { catalog });
    expect(inspectStep(recipe as RecipeSource, "check", catalog)!.needs!.every((f) => !f.mapped)).toBe(true);
    expect(validateRecipe(recipe).findings.some((f) => f.code === "MAPPING_INCOMPLETE")).toBe(true);
  });
});
