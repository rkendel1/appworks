/**
 * The page's own script, run against the real server with a minimal DOM (no browser, no screenshot): it fetches from the real API,
 * builds the card, switches tabs, shows readiness and makes a package. This is not a browser test: layout and styling are not
 * exercised, only that the page's logic works against the API it ships with and shows what the API says.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { studioEnvironment, studioServer, supplierInvoice, tempDir, useCleanup } from "./support.js";

useCleanup();

class Node_ {
  children: Array<Node_ | Text_> = [];
  attrs: Record<string, string> = {};
  handlers: Record<string, Array<(e: unknown) => unknown>> = {};
  className = "";
  value = "";
  nodeType = 1;
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: (e: unknown) => unknown) { (this.handlers[type] ??= []).push(fn); }
  append(...kids: Array<Node_ | Text_ | string>) { for (const k of kids) this.children.push(typeof k === "string" ? new Text_(k) : k); }
  replaceChildren(...kids: Array<Node_ | Text_>) { this.children = []; this.append(...kids); }
  set textContent(t: string) { this.children = t ? [new Text_(t)] : []; }
  get textContent(): string { return this.children.map((c) => c.textContent).join(""); }
  find(pred: (n: Node_) => boolean): Node_[] { return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => (c instanceof Node_ ? c.find(pred) : []))]; }
  async fire(type: string, event: unknown = {}) { for (const h of this.handlers[type] ?? []) await h(event); }
}
class Text_ { nodeType = 3; constructor(public textContent: string) {} }

async function boot(origin: string, answers: string[] = []) {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const byId: Record<string, Node_> = {};
  for (const m of html.matchAll(/<(\w+)[^>]*\sid="(\w+)"/g)) byId[m[2]!] = new Node_(m[1]!);
  const document = { getElementById: (id: string) => byId[id], createElement: (t: string) => new Node_(t), createTextNode: (t: string) => new Text_(String(t)) };
  const asked = [...answers];
  const sandbox = { document, fetch: (path: string, init?: RequestInit) => fetch(new URL(path, origin), init), prompt: () => asked.shift(), console, JSON, encodeURIComponent, Object, Array, Set, Number, String, Error, Promise };
  vm.runInNewContext(readFileSync(new URL("../ui/studio.js", import.meta.url), "utf8"), sandbox);
  const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { byId, settle, text: () => byId["main"]!.textContent, notice: () => byId["notice"]!.textContent };
}
const click = async (page: Awaited<ReturnType<typeof boot>>, label: string) => {
  const button = page.byId["main"]!.find((n) => n.tag === "button" && n.textContent === label)[0];
  expect(button, `button ${label}`).toBeDefined();
  await button!.fire("click");
};

describe("the page, against the real server", () => {
  it("lists recipes, draws the card with each step spanning its inputs, shows readiness and makes a package", async () => {
    const dir = tempDir();
    const e = await studioEnvironment(dir, "publisher-env");
    const studio = await studioServer(join(dir, "projects"), [e.studio]);
    studio.store.create("supplier-invoice", supplierInvoice(), { product: "product://example/supplier-invoice", version: "1.0.0" });
    const page = await boot(studio.origin);
    await page.settle(() => page.byId["project"]!.children.length > 1);
    expect(page.byId["environment"]!.textContent).toBe("publisher-env");
    await page.byId["project"]!.fire("change", { target: { value: "supplier-invoice" } });
    await page.settle(() => page.text().includes("Supplier invoice processing"));
    expect(page.notice()).toBe("");

    // The card: the title and purpose, what the environment must provide, the ingredients, and a cell per step with a row span.
    const text = page.text();
    expect(text).toContain("Supplier invoice processing");
    expect(text).toContain("Needs invoice.submit from org.example.accounting");
    expect(text).toContain("Someone in role:ap-manager must be available");
    const table = page.byId["main"]!.find((n) => n.tag === "table" && n.className === "card")[0]!;
    const cell = (step: string) => table.find((n) => n.tag === "td" && n.attrs["title"] === step)[0]!;
    expect(cell("check-duplicate").attrs["rowspan"]).toBe("2"); // supplierId and invoiceNumber
    expect(cell("needs-approval").attrs["rowspan"]).toBe("4"); // amount through purchaseOrder
    expect(cell("is-duplicate").attrs["rowspan"]).toBe("6"); // reads only an earlier result: spans every ingredient
    expect(text).toContain("submission-uncertain → uncertain");
    expect(text).not.toMatch(/com\.example\.ledger/); // the card is the portable recipe

    // Readiness: honest about what is unresolved, and where the environment-specific facts are.
    await click(page, "Readiness");
    await page.settle(() => page.text().includes("This environment"));
    expect(page.text()).toContain("ready-with-unresolved");
    expect(page.text()).toContain("role role:ap-manager");
    expect(page.text()).toContain("com.example.ledger");
    expect(page.text()).toContain("granted");
    expect(page.text()).toContain("Nothing here says the business outcome will occur");

    // Package: the digest, and the existing commands that carry it on.
    await click(page, "Package");
    await page.settle(() => page.byId["main"]!.find((n) => n.tag === "button" && n.textContent === "Make package").length > 0);
    await click(page, "Make package");
    await page.settle(() => page.text().includes("appworks package publish"));
    expect(page.text()).toMatch(/Package sha256:[0-9a-f]{64}/);
    expect(page.text()).toContain("executable: false");
    expect(page.text()).toContain("appworks recipe run --package");
    expect(page.text()).toContain("--product product://example/supplier-invoice --version 1.0.0");
  });

  it("edits through the page's own controls: a field, and a step from the catalog; a failure shows as a message, not a crash", async () => {
    const dir = tempDir();
    const e = await studioEnvironment(dir, "env");
    const studio = await studioServer(join(dir, "projects"), [e.studio]);
    const page = await boot(studio.origin, ["lookup", "org.example.recipes.lookup", "Lookup", "Find an invoice"]);
    await page.settle(() => page.byId["project"]!.children.length > 0);
    await page.byId["new"]!.fire("click");
    await page.settle(() => studio.store.list().length === 1);
    await page.settle(() => page.text().includes("Card") || page.byId["main"]!.children.length > 0);
    expect(studio.store.open("lookup").recipe).toMatchObject({ id: "org.example.recipes.lookup", name: "Lookup", objective: "Find an invoice" });

    await click(page, "Define");
    await page.settle(() => page.text().includes("Inputs"));
    const row = page.byId["main"]!.find((n) => n.tag === "div" && n.className === "panel" && n.textContent.startsWith("Inputs"))[0]!;
    const [name] = row.find((n) => n.tag === "input" && n.attrs["placeholder"] === "field name");
    name!.value = "supplierId";
    await name!.fire("change", { target: name });
    await row.find((n) => n.tag === "button" && n.textContent === "Add field")[0]!.fire("click");
    await page.settle(() => (studio.store.open("lookup").recipe as any).inputs.properties.supplierId !== undefined);
    expect((studio.store.open("lookup").recipe as any).inputs).toMatchObject({ required: ["supplierId"], properties: { supplierId: { type: "string" } } });

    // A bad edit is refused by the server and shown, and the page carries on.
    await click(page, "Steps");
    await page.settle(() => page.text().includes("Add a step from a capability"));
    await page.byId["main"]!.find((n) => n.tag === "button" && n.textContent === "Add")[0]!.fire("click");
    await page.settle(() => page.notice() !== "");
    expect(page.byId["notice"]!.className).toBe("bad");
    expect(page.text()).toContain("Add a step from a capability");
  });
});
