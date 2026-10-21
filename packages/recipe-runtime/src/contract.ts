/**
 * What a canonical contract declares about verifying one of its capabilities (`appport.integration/1`), read from the
 * contract manifest the gateway reports. The runtime executes the declared state methods and never weakens them.
 */
import { INTEGRATION_EXTENSION, satisfiesVersionConstraint, type AppPortManifest, type CapabilityIntegration, type StateVerification } from "@appport/protocol";

export function declaredStateMethods(manifest: AppPortManifest | undefined, capability: string, constraint: string | undefined): StateVerification[] {
  const entry = manifest?.capabilities.find((c) => c.name === capability);
  const version = entry?.versions.filter((v) => satisfiesVersionConstraint(v, constraint ?? "1")).sort((a, b) => b - a)[0];
  if (!entry || version === undefined) return [];
  const integration = (manifest?.attributes as Record<string, { capabilities?: Record<string, CapabilityIntegration> }> | undefined)?.[INTEGRATION_EXTENSION];
  return (integration?.capabilities?.[`${capability}@${version}`]?.verify ?? []).filter((m): m is StateVerification => m.kind === "state");
}
