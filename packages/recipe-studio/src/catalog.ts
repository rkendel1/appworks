/**
 * The capability catalog: what the environment's active canonical contracts offer a recipe to compose, read from AppPort's
 * registry through the gateway. Descriptive only. A capability appearing here says nothing about whether any provider fulfils
 * it or whether the consumer is authorized to use it: readiness (`readiness.ts`) reports those.
 */
import { INTEGRATION_EXTENSION, contractDigest, findCapabilityVersion, type AppPortManifest, type CapabilityIntegration, type JSONSchema } from "@appport/protocol";

export interface CatalogEntry {
  contract: string;
  manifest: AppPortManifest;
}

export interface FieldSummary {
  name: string;
  type: string;
  required: boolean;
  concept?: string;
}

export interface CatalogVersion {
  version: number;
  description?: string;
  effect: string;
  /** What invoking this capability requires of the caller, as the contract declares it. A declaration, not a grant. */
  authorization: string[];
  idempotency?: string;
  input: JSONSchema;
  output: JSONSchema;
  inputFields: FieldSummary[];
  outputFields: FieldSummary[];
  /** The state-verification methods the contract declares for it; a recipe step must list every one. */
  verifyMethods: string[];
}

export interface CatalogCapability {
  contract: string;
  contractDigest: string;
  capability: string;
  versions: CatalogVersion[];
}

export function fieldsOf(schema: JSONSchema | undefined): FieldSummary[] {
  const properties = (schema?.properties ?? {}) as Record<string, JSONSchema>;
  const required = new Set((schema?.required ?? []) as string[]);
  return Object.entries(properties).map(([name, s]) => {
    const type = Array.isArray(s.type) ? s.type.join("|") : (s.type as string | undefined) ?? (s.enum ? "enum" : "any");
    const concept = (s as Record<string, unknown>)["x-appport-concept"];
    return { name, type, required: required.has(name), ...(typeof concept === "string" ? { concept } : {}) };
  });
}

export function verifyMethodsOf(manifest: AppPortManifest, capability: string, version: number): string[] {
  const integration = (manifest.attributes as Record<string, { capabilities?: Record<string, CapabilityIntegration> }> | undefined)?.[INTEGRATION_EXTENSION];
  return (integration?.capabilities?.[`${capability}@${version}`]?.verify ?? []).filter((m) => m.kind === "state").map((m) => m.id);
}

export function describeCatalog(entries: readonly CatalogEntry[]): CatalogCapability[] {
  return entries.flatMap(({ contract, manifest }) =>
    manifest.capabilities.map((c) => ({
      contract,
      contractDigest: contractDigest(manifest),
      capability: c.name,
      versions: [...(c.versions ?? [])].sort((a, b) => a - b).flatMap((version) => {
        const def = findCapabilityVersion(manifest, c.name, version);
        if (!def) return [];
        return [{
          version,
          ...(def.description ? { description: def.description } : {}),
          effect: def.effect ?? "unknown",
          authorization: [...def.authorization],
          ...(def.idempotency ? { idempotency: def.idempotency } : {}),
          input: def.inputSchema,
          output: def.outputSchema,
          inputFields: fieldsOf(def.inputSchema),
          outputFields: fieldsOf(def.outputSchema),
          verifyMethods: verifyMethodsOf(manifest, c.name, version)
        }];
      })
    }))
  );
}
