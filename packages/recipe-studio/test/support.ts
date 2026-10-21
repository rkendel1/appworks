/** Shared fixtures: the supplier-invoice scenario and the real AppPort accounting environment the runtime tests use. */
import { join } from "node:path";
import type { RuntimeAuthority } from "@appport/recipe-runtime";
import { BOOKS_NAMES, accountingEnvironment, type ProviderSpec } from "../../recipe-runtime/test/accounting/environment.js";
import { supplierInvoice } from "../../recipe-runtime/test/accounting/contract.js";
import { full, onCleanup, tempDir, useCleanup } from "../../recipe-runtime/test/support.js";
import type { StudioEnvironment } from "../src/index.js";

export { AUTO, LARGE, full, onCleanup, tempDir, useCleanup } from "../../recipe-runtime/test/support.js";
export { BOOKS_NAMES, supplierInvoice };

/** An AppPort environment for the accounting contract, as the Studio sees it. */
export async function studioEnvironment(dir: string, name: string, options: { providers?: ProviderSpec[]; grant?: boolean; authority?: RuntimeAuthority | null } = {}) {
  const recipe = supplierInvoice();
  const env = await accountingEnvironment(join(dir, name), recipe, options.providers, options.grant === undefined ? {} : { grant: options.grant });
  onCleanup(() => env.close());
  const studio: StudioEnvironment = { name, gateway: env.gateway, ...(options.authority === null ? {} : { authority: options.authority ?? full }) };
  return { env, studio };
}

export { useCleanup as useStudioCleanup, tempDir as tempStudioDir };

import { applyEdits, newRecipe, type CatalogEntry, type RecipeEdit } from "../src/index.js";

const OWN = new Set(["id", "kind", "uses", "effect", "expects"]);

/**
 * The supplier-invoice recipe made from an empty one through Studio edits. A capability step's dependency, kind, effect and
 * expected shapes are *derived* from the environment's contract (`addCapability`); what the contract cannot know (routes, input
 * wiring beyond same-named fields, prose, extra verification) is the author's, and is the only thing taken from the example.
 * `derived` keeps each capability step as the catalog alone produced it, before the author's additions.
 */
export function supplierInvoiceFromEmpty(catalog: readonly CatalogEntry[]) {
  const example = supplierInvoice();
  let recipe: Record<string, any> = newRecipe({ id: example.id, name: example.name, objective: example.objective });
  const derived: Record<string, any> = {};
  const edits: RecipeEdit[] = [];
  const apply = (...next: RecipeEdit[]) => {
    edits.push(...next);
    recipe = applyEdits(recipe, next, { catalog });
  };
  apply({ op: "meta", description: example.description! });
  for (const where of ["inputs", "outputs"] as const) {
    const schema = example[where] as { properties: Record<string, any>; required?: string[] };
    for (const [name, s] of Object.entries(schema.properties)) apply({ op: "field", where, name, schema: s, required: (schema.required ?? []).includes(name) });
  }
  apply({ op: "outcome", outcome: example.outcome }, { op: "provenance", provenance: example.provenance! });
  const dependencyIds: Record<string, string> = {};
  for (const step of example.steps) {
    if (step.kind !== "capability") {
      apply({ op: "step", step });
      continue;
    }
    const dep = example.requires.find((d) => d.id === step.uses)!;
    const target = dep.target as { contract: string; capability: string };
    apply({ op: "addCapability", step: step.id, contract: target.contract, capability: target.capability, dependency: dep.id, purpose: dep.purpose!, on: step.on });
    derived[step.id] = structuredClone(recipe["steps"].find((s: any) => s.id === step.id));
    // The author's part: everything the contract does not determine.
    const own = Object.fromEntries(Object.entries(step).filter(([k]) => !OWN.has(k)));
    apply({ op: "step", step: { ...derived[step.id], ...own } });
    dependencyIds[dep.id] = step.id;
  }
  // A dependency no step invokes, used only to verify the outcome: declared directly.
  for (const dep of example.requires) if (!dependencyIds[dep.id]) apply({ op: "dependency", dependency: dep });
  /** `edits` are plain data: replaying them on `newRecipe(...)` (as the server does) gives `recipe`. */
  return { recipe, derived, example, edits, seed: { id: example.id, name: example.name, objective: example.objective } };
}

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createStudioServer, StudioStore } from "../src/index.js";
import { main as packageMain, type CliEnvironment as PackageCli } from "../../recipe-distribution/src/cli.js";
import { main as runMain, type CliEnvironment as RunCli } from "../../recipe-runtime/src/cli.js";
import type { InstallEnvironment } from "../../recipe-distribution/src/index.js";
import type { CapabilityGateway } from "../../recipe-runtime/src/index.js";

export const asInstallEnvironment = (gateway: CapabilityGateway): InstallEnvironment => ({ snapshot: (requires) => gateway.snapshot(requires), resolve: (requires) => gateway.resolve!(requires) });

/** A Studio server over a projects directory, and a client that sends what the page sends. */
export async function studioServer(root: string, environments: StudioEnvironment[]) {
  const store = new StudioStore(root);
  const app = createStudioServer({ store, environments, principal: "alice" });
  const origin = await app.listen();
  onCleanup(() => app.close());
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${origin}${path}`, { method, headers: { "content-type": "application/json", "x-appworks-request": "studio", ...headers }, ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { store, origin, call, close: () => app.close() };
}

export async function cli<T extends object>(main: (a: string[], io: { out(t: string): void; err(t: string): void }, e: T) => Promise<number>, args: string[], env: T) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (t) => out.push(t), err: (t) => err.push(t) }, env);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
export const distribution = (args: string[], gateway: CapabilityGateway | undefined) => cli(packageMain, args, (gateway ? { load: async () => ({ gateway: asInstallEnvironment(gateway) }) } : {}) as PackageCli);
export const runtime = (args: string[], gateway: CapabilityGateway) => cli(runMain, args, { load: async () => ({ gateway, authority: full }) } as RunCli);

/** Every file under a directory, as text. */
export function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = readFileSync(path, "utf8");
    }
  };
  walk(dir);
  return out;
}
