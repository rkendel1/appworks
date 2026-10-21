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

/** The contract attribute (an AppWorks-namespaced convention, not an AppPort or recipe member) naming how an operation can be looked up again. */
export const RECONCILIATION_ATTRIBUTE = "org.appworks.reconciliation/1";

export interface ReconciliationDeclaration {
  /** The contract's capability that reports what became of an operation, by its durable operation key. */
  capability: string;
  version: number;
  /** The input field that carries the operation key (the idempotency key of the original invocation). */
  keyField: string;
  /**
   * The provider guarantees that when this lookup answers `absent` with `consistency: "strong"` and `fenced: true`, the
   * operation was not executed and will be refused if it arrives late. Without that guarantee absence proves nothing.
   */
  absenceConclusive: boolean;
}

export function reconciliationFor(manifest: AppPortManifest | undefined, capability: string, constraint: string | undefined): ReconciliationDeclaration | undefined {
  const entry = manifest?.capabilities.find((c) => c.name === capability);
  const version = entry?.versions.filter((v) => satisfiesVersionConstraint(v, constraint ?? "1")).sort((a, b) => b - a)[0];
  if (!entry || version === undefined) return undefined;
  const declared = (manifest?.attributes as Record<string, Record<string, { via?: { capability?: string; version?: number; keyField?: string }; absenceConclusive?: boolean }>> | undefined)?.[RECONCILIATION_ATTRIBUTE]?.[`${capability}@${version}`];
  if (!declared?.via?.capability || typeof declared.via.version !== "number" || !declared.via.keyField) return undefined;
  return { capability: declared.via.capability, version: declared.via.version, keyField: declared.via.keyField, absenceConclusive: declared.absenceConclusive === true };
}
