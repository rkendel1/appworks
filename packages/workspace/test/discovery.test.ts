import { describe, expect, it } from "vitest";
import { createApplication, createServer, defineCapability, permissionAuthorizer, s } from "@appport/sdk";
import { serve } from "@appport/sdk/node";
import { CANONICAL_CONTRACT_EXTENSION, claimFor, fulfillmentAttributes, type AppPortManifest } from "@appport/protocol";
import { discoverCapabilities } from "../src/index.js";

/** A real AppPort application, served over HTTP with public discovery, that counts invocations. */
async function application(options: { claimAgainst?: AppPortManifest } = {}) {
  let invoked = 0;
  const get = defineCapability({
    name: "note.get",
    version: 1,
    description: "Read a note.",
    input: s.object({ name: s.string() }),
    output: s.object({ name: s.string(), body: s.string() }),
    effect: "observation",
    authorization: ["notes.read"],
    handler: async ({ name }: { name: string }) => {
      invoked++;
      return { name, body: "" };
    }
  });
  const declaration = options.claimAgainst ? fulfillmentAttributes({ capabilities: { "note.get@1": [claimFor(options.claimAgainst, "note.get", 1)] } }) : undefined;
  const app = createApplication({ application: { id: "com.example.notes", name: "Notes", version: "1.0.0" }, capabilities: [get], authorizer: permissionAuthorizer(), ...(declaration ? { extensions: declaration.extensions, attributes: declaration.attributes } : {}) } as never);
  const server = createServer({ application: app, publication: { public: true, applicationDescription: true, capabilities: [{ name: "note.get", version: 1 }] } } as never);
  const running = await serve({ server, host: "127.0.0.1", port: 0, websocket: false } as never);
  const url = (running as { url: string }).url.replace(/\/$/, "");
  // The authoritative manifest, as any client reads it.
  const manifest = async () => {
    const wellKnown = (await (await fetch(`${url}/.well-known/appport`)).json()) as { manifest: string };
    return (await (await fetch(new URL(wellKnown.manifest, url))).json()) as AppPortManifest;
  };
  return { url, close: () => (running as { close(): Promise<void> }).close(), invocations: () => invoked, manifest };
}

describe("discovery through AppPort's client", () => {
  it("discovers advertised capabilities with their interfaces, sends no credential and invokes nothing", async () => {
    const app = await application();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    try {
      const record = await discoverCapabilities({
        endpoint: app.url,
        integrationPresent: true,
        fetch: async (url, init) => {
          seen.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
          return fetch(url, init);
        }
      });
      expect(record.outcome).toBe("discovered");
      expect(record.application).toEqual({ id: "com.example.notes", name: "Notes", version: "1.0.0" });
      expect(record.capabilities).toEqual([
        expect.objectContaining({ name: "note.get", version: 1, status: "verified", effect: "observation", input: { properties: ["name"], required: ["name"] }, output: { properties: ["body", "name"] }, claims: [] })
      ]);
      expect(record.established).toEqual({ publisherTrust: false, authorization: false, approval: false, invoked: false });
      expect(app.invocations()).toBe(0);
      expect(seen.every((r) => r.authorization === null)).toBe(true);
      expect(seen.every((r) => r.url.startsWith(app.url))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("evaluates a published fulfillment claim against a canonical contract it has, and never calls an unevaluated one valid", async () => {
    const contractApp = await application();
    const own = await contractApp.manifest();
    await contractApp.close();
    // A canonical contract with the same capability, under another application id.
    const contract = { ...own, application: { ...own.application, id: "org.example.contracts" }, extensions: [CANONICAL_CONTRACT_EXTENSION] } as AppPortManifest;
    const app = await application({ claimAgainst: contract });
    try {
      const unevaluated = await discoverCapabilities({ endpoint: app.url, integrationPresent: true });
      expect(unevaluated.capabilities[0]!.claims.map((c) => c.evaluation)).toEqual(["not-evaluated"]);
      const evaluated = await discoverCapabilities({ endpoint: app.url, integrationPresent: true, canonical: [contract] });
      expect(evaluated.capabilities[0]!.claims[0]!.claim.contract).toBe("org.example.contracts");
      expect(["valid", "invalid"]).toContain(evaluated.capabilities[0]!.claims[0]!.evaluation);
      expect(app.invocations()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("reports an unreachable endpoint, a missing endpoint and a missing integration as different outcomes", async () => {
    const unreachable = await discoverCapabilities({ endpoint: "http://127.0.0.1:9", integrationPresent: true, timeoutMs: 2_000 });
    expect(unreachable.outcome).toBe("unavailable");
    expect(unreachable.reasons.join()).toMatch(/transport/);
    expect((await discoverCapabilities({ integrationPresent: true })).outcome).toBe("unavailable");
    expect((await discoverCapabilities({ integrationPresent: false })).outcome).toBe("no-integration");
  });
});
