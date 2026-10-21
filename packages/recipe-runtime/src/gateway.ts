/**
 * The runtime's only route to capabilities (spec/runtime-1.md §6.1). A gateway resolves a recipe dependency to an
 * eligible provider, has AppPort authorize the binding at this moment, invokes, and reports one of five results. The
 * runtime depends on this port; `createAppPortGateway` is the implementation over `@appport/core`.
 */
import type { Dependency, JsonValue, StateVerification } from "@appport/protocol";
import type { RecipeEnvironment } from "@appport/recipe";

export interface GatewayRequest {
  /** The recipe's declared dependency: its canonical target and version constraint say what to resolve. */
  dependency: Dependency;
  input: JsonValue;
  /** Stable for the logical call (spec §6.2); handed to the provider. */
  idempotencyKey: string;
  requestId: string;
  signal?: AbortSignal;
}

export interface ProviderIdentity {
  application: string;
  capability: { name: string; version: number };
  registrationId?: string;
  fingerprint?: string;
}

export type GatewayResult =
  | { kind: "success"; output: JsonValue; provider: ProviderIdentity; canonical: { contract: string; capability: string; version: number }; verification: readonly StateVerification[] }
  /** Authorization refused the binding. The provider's implementation was not entered. */
  | { kind: "denied"; reason: string; message: string }
  /** No single eligible provider. The provider's implementation was not entered. */
  | { kind: "unresolved"; reason: string }
  /** Refused before the provider ran: invalid input, or a stale or invalid binding. */
  | { kind: "rejected"; code: string; message: string }
  /** The provider ran, or may have, and returned no output. Whether it committed is unknown. */
  | { kind: "failed"; code: string; message: string };

export interface CapabilityGateway {
  /** What `validateRecipe` needs to check the recipe against this environment: active contracts and eligible providers. */
  snapshot(requires: readonly Dependency[]): Promise<RecipeEnvironment>;
  invoke(request: GatewayRequest): Promise<GatewayResult>;
}

/** Who may start a recipe and answer its tasks. Distinct from the consumer's AppPort grant, which gates each invocation. */
export interface RuntimeAuthority {
  canStart(principal: string, recipeId: string): boolean | Promise<boolean>;
  canAnswer(principal: string, role: string): boolean | Promise<boolean>;
  /** Who may reconcile an uncertain run. Absent means nobody: reconciling is a decision about a possible effect. */
  canReconcile?(principal: string, recipeId: string): boolean | Promise<boolean>;
}

/** Permits everything. For local use and tests; a deployment supplies its own. */
export const permissiveAuthority: RuntimeAuthority = { canStart: () => true, canAnswer: () => true, canReconcile: () => true };

/** A gateway for read-only commands: it reports no environment and refuses every invocation. */
export const unavailableGateway: CapabilityGateway = {
  async snapshot() {
    return {};
  },
  async invoke() {
    return { kind: "unresolved", reason: "no environment is attached to this command" };
  }
};
