import { describe, expect, it } from "vitest";
import { CANONICAL_CONTRACT_EXTENSION, claimFor, fulfillmentAttributes, type AppPortManifest } from "@appport/protocol";
import { application } from "./application.js";
import { discoverCapabilities } from "../src/index.js";

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
