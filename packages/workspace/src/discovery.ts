/**
 * Capability discovery, through AppPort's own client: `@appport/client`'s `discoverApplication` (the public discovery
 * path: `/.well-known/appport`, the public description and the authoritative manifest). AppWorks keeps no registry of
 * its own. The manifest discovery verified against is captured from the same fetch, so the fulfillment claims and
 * schemas read from it are the ones discovery checked, not a second, unverified read.
 *
 * Discovery grants nothing. It sends no credential, invokes no capability, and its result says so (`established`, all
 * false). A discovered capability is evidence that an application advertises an interface, never permission to call it.
 */
import { discoverApplication, type PublicDiscoveryResult } from "@appport/client";
import { claimsFor, evaluateFulfillment, getFulfillment, type AppPortManifest, type FulfillmentClaim } from "@appport/protocol";

export interface DiscoveredCapabilityRecord {
  name: string;
  version: number;
  status: "verified" | "unresolved";
  reasons: string[];
  effect?: string;
  authorization?: unknown;
  /** Input and output property names from the authoritative manifest, when it verified. */
  input?: { properties: string[]; required: string[] };
  output?: { properties: string[] };
  /** The declared schemas themselves (records made before they were kept have none: comparisons with them are unknown). */
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** Fulfillment claims this capability publishes, each with its evaluation when the canonical contract is at hand. */
  claims: Array<{ claim: FulfillmentClaim; evaluation: "valid" | "invalid" | "not-evaluated"; findings: string[] }>;
}

export interface DiscoveryRecord {
  format: "appworks.discovery/1";
  /** `discovered`: discovery verified the published references. `no-integration`: inspection found no AppPort
   * integration, so there is nothing to discover. `unavailable`: no endpoint, or discovery could not complete. */
  outcome: "discovered" | "no-integration" | "unavailable";
  endpoint?: string;
  at: string;
  state?: PublicDiscoveryResult["state"];
  reasons: string[];
  application?: { id: string; name: string; version: string };
  contractDigest?: string;
  capabilities: DiscoveredCapabilityRecord[];
  notPublishedCount?: number;
  established: { publisherTrust: false; authorization: false; approval: false; invoked: false };
  note: string;
}

const NOTHING_ESTABLISHED = { publisherTrust: false, authorization: false, approval: false, invoked: false } as const;

const shape = (schema: unknown) => {
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  return { properties: Object.keys(s.properties ?? {}).sort(), required: [...(s.required ?? [])].sort() };
};

/**
 * Discovers what the application at `endpoint` advertises. `canonical` contracts (by `application.id`) let claims be
 * evaluated; without one a claim is recorded as `not-evaluated`, never as valid.
 */
export async function discoverCapabilities(input: { endpoint?: string; integrationPresent: boolean; canonical?: AppPortManifest[]; fetch?: typeof globalThis.fetch; now?: () => Date; timeoutMs?: number }): Promise<DiscoveryRecord> {
  const at = (input.now ?? (() => new Date()))().toISOString();
  if (!input.integrationPresent && !input.endpoint)
    return { format: "appworks.discovery/1", outcome: "no-integration", at, reasons: ["integration.absent"], capabilities: [], established: NOTHING_ESTABLISHED, note: "Inspection found no AppPort integration in the pinned revision, and no endpoint was given: there are no existing AppPort capabilities to discover." };
  if (!input.endpoint)
    return { format: "appworks.discovery/1", outcome: "unavailable", at, reasons: ["endpoint.absent"], capabilities: [], established: NOTHING_ESTABLISHED, note: "The revision has an AppPort integration, but no running endpoint was given. Discovery did not run; nothing about its capabilities is known." };

  let manifest: AppPortManifest | undefined;
  const base = input.fetch ?? globalThis.fetch;
  // Captures the authoritative manifest from discovery's own request (a clone of the response it validated).
  const capturing: typeof globalThis.fetch = async (url, init) => {
    const response = await base(url, init);
    if (response.ok && !String(url).includes("/.well-known/")) {
      try {
        const body = (await response.clone().json()) as { capabilities?: Array<{ definitions?: unknown }>; application?: unknown };
        // The manifest is the document whose capabilities carry definitions (the public description lists references).
        if (body && typeof body === "object" && body.application && Array.isArray(body.capabilities) && body.capabilities.every((c) => Array.isArray(c?.definitions))) manifest = body as unknown as AppPortManifest;
      } catch {
        /* discovery reports the malformed document itself */
      }
    }
    return response;
  };
  const result = await discoverApplication({ origin: input.endpoint, fetch: capturing, timeoutMs: input.timeoutMs ?? 10_000 });
  const ok = result.state === "reference-verified";
  const capabilities: DiscoveredCapabilityRecord[] = result.capabilities.map((c) => {
    const definition = ok && manifest ? manifest.capabilities.find((x) => x.name === c.name)?.definitions?.find((d) => d.version === c.version) : undefined;
    const claims = ok && manifest && getFulfillment(manifest)
      ? Object.entries(getFulfillment(manifest)!.capabilities)
          .filter(([key]) => key === `${c.name}@${c.version}`)
          .flatMap(([, list]) => list)
          .map((claim) => {
            const canonical = input.canonical?.find((m) => m.application.id === claim.contract);
            if (!canonical) return { claim, evaluation: "not-evaluated" as const, findings: ["the canonical contract is not available to this workspace"] };
            const found = claimsFor(manifest!, { contract: claim.contract, capability: claim.capability, version: claim.version }).find((x) => x.capability.name === c.name && x.capability.version === c.version);
            if (!found) return { claim, evaluation: "invalid" as const, findings: ["claim.undeclared"] };
            const evaluation = evaluateFulfillment({ canonical, provider: manifest!, capability: found.capability, claim: found.claim });
            return { claim, evaluation: evaluation.status === "valid" ? ("valid" as const) : ("invalid" as const), findings: evaluation.findings.map((f) => `${(f as { code?: string }).code ?? "finding"}`) };
          })
      : [];
    return {
      name: c.name,
      version: c.version,
      status: c.status,
      reasons: c.reasons,
      ...(c.declared ? { effect: c.declared.effect, authorization: c.declared.authorization } : {}),
      ...(definition ? { input: shape(definition.inputSchema), output: { properties: shape(definition.outputSchema).properties }, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema } : {}),
      claims
    };
  });
  return {
    format: "appworks.discovery/1",
    outcome: ok ? "discovered" : "unavailable",
    endpoint: input.endpoint,
    at,
    state: result.state,
    reasons: result.reasons,
    ...(result.application ? { application: result.application } : {}),
    ...(result.contract ? { contractDigest: result.contract.digest } : {}),
    capabilities,
    ...(result.notPublishedCount !== undefined ? { notPublishedCount: result.notPublishedCount } : {}),
    established: NOTHING_ESTABLISHED,
    note: ok ? `${result.note} No capability was invoked; no credential was sent.` : `Discovery did not verify (${result.state}: ${result.reasons.join(", ") || "no reason given"}). Nothing about the application's capabilities is established.`
  };
}
