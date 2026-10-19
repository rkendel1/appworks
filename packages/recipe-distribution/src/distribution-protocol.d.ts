/**
 * Types for the parts of `@distribution-protocol/protocol` 1.0.0 this adapter calls. The package ships JavaScript
 * without declarations; these were written from its published source (`src/index.mjs` and the modules it re-exports)
 * and cover only what is used. They are internal: no public declaration of this package refers to them.
 */
declare module "@distribution-protocol/protocol" {
  export const PROTOCOL_ID: "distribution/1";
  export interface ManifestError { path: string; message: string; code?: string }
  export function validateManifest(manifest: unknown): ManifestError[];
  export function digestOfBytes(bytes: Uint8Array | string): string;
  export function verifyRelease(release: unknown, options?: { expectedPublicKey?: unknown }): { valid: boolean; reason: string | null; keyId: string | null };
  export function verifyArtifactBytes(bytes: Uint8Array, artifact: { digest: string }): boolean;
  export const BindingOutcome: Readonly<{ VERIFIED: "VERIFIED"; MISSING: "BINDING_MISSING"; MISMATCH: "BINDING_MISMATCH"; UNAUTHENTICATED: "RELEASE_UNAUTHENTICATED"; INVALID_REQUEST: "INVALID_BINDING_REQUEST" }>;
  export function checkArtifactBinding(params: { release: unknown; artifactId: string; scheme: string; expected: string }): {
    outcome: string;
    ok: boolean;
    scheme: string;
    expected: string;
    actual: string | null;
    reason: string | null;
  };
  export function verifyAcquisitionTrust(params: { release: unknown; documents: unknown[]; policy: unknown }): { outcome: string; reason: string | null };
  export const TrustOutcome: Readonly<{ VALID: "VALID" } & Record<string, string>>;
  // Used by this package's tests only.
  export function generatePublisherKeypair(): { publicKey: unknown; privateKey: unknown };
  export function signRelease(manifest: unknown, privateKey: unknown, options?: { keyId?: string }): { type: string; manifest: any; signature: Record<string, string> };
  export function createTrustPolicy(input?: { publishers?: unknown[]; keys?: Record<string, unknown[]>; documents?: Record<string, unknown[]> }): unknown;
}
