/**
 * The AppPort-backed gateway: resolution, authorization binding and invocation are `@appport/core`'s, called afresh for
 * every invocation (spec/runtime-1.md §6.1, §7). Nothing is cached between calls: a grant revoked, a contract revision
 * superseded or a provider retired is observed by the next invocation. In-process: the providers' capability
 * definitions are supplied by the host; a remote transport is a later gateway behind the same port.
 */
import {
  ApplicationDependencyResolver,
  CapabilityBinder,
  CapabilityInvoker,
  type AnyCapability,
  type ApplicationRegistry,
  type ApplicationState,
  type CanonicalContractRegistry,
  type RequirementManifestEntry
} from "@appport/core";
import {
  INTEGRATION_EXTENSION,
  satisfiesVersionConstraint,
  type AppPortManifest,
  type CapabilityIntegration,
  type Dependency,
  type JsonValue,
  type StateVerification
} from "@appport/protocol";
import type { RecipeEnvironment, RecipeSource } from "@appport/recipe";
import type { CapabilityGateway, GatewayRequest, GatewayResult } from "./gateway.js";

export interface AppPortGatewayOptions {
  registry: ApplicationRegistry;
  contracts: CanonicalContractRegistry;
  /** The runtime's own AppPort application: registered by the host, with `requires` from {@link consumerRequirements}. */
  consumer: ApplicationState;
  /** Decides, from durable grants, whether the consumer may use a provider's capability. */
  binder: CapabilityBinder;
  /** The executable capability a provider serves, in this process. */
  capabilityFor(application: string, name: string, version: number): AnyCapability | undefined;
  invoker?: CapabilityInvoker;
}

const target = (dependency: Dependency) => dependency.target as { contract: string; capability: string };

/** The first integer of a version constraint (`1`, `^1`, `>=2`): the major version a consumer declares. */
export const majorOf = (constraint: string | undefined): number => Number(/\d+/.exec(constraint ?? "1")?.[0] ?? 1);

/** The canonical requirements a recipe declares, as AppPort requirement entries, for registering the runtime as a consumer. */
export function consumerRequirements(recipe: Pick<RecipeSource, "requires">, extra: Array<{ contract: string; capability: string; version?: number }> = []): RequirementManifestEntry[] {
  // `extra`: capabilities the runtime itself uses beyond the recipe's dependencies, today the contract's reconciliation lookup (spec §6.5).
  // Declaring one is the consumer's request; it is used only if the environment also grants it.
  return [...recipe.requires.map((d) => ({
    name: target(d).capability,
    version: majorOf(d.versionConstraint),
    ...(d.versionConstraint ? { versionConstraint: d.versionConstraint } : {}),
    canonical: { contract: target(d).contract }
  })), ...extra.map((e) => ({ name: e.capability, version: e.version ?? 1, versionConstraint: String(e.version ?? 1), canonical: { contract: e.contract } }))] as RequirementManifestEntry[];
}

const failureMessage = (value: unknown): string => (value instanceof Error ? value.message : String(value)).slice(0, 500);

export function createAppPortGateway(options: AppPortGatewayOptions): CapabilityGateway {
  const invoker = options.invoker ?? new CapabilityInvoker();
  const resolver = () => new ApplicationDependencyResolver(options.registry, { contracts: options.contracts });

  /** The highest major version of the contract's capability that the dependency's constraint accepts. */
  async function versionOf(dependency: Dependency): Promise<{ manifest: AppPortManifest; version: number } | undefined> {
    const record = await options.contracts.get(target(dependency).contract);
    if (!record || record.status !== "active") return undefined;
    const entry = record.manifest.capabilities.find((c) => c.name === target(dependency).capability);
    const constraint = dependency.versionConstraint ?? String(majorOf(undefined));
    const version = entry?.versions.filter((v) => satisfiesVersionConstraint(v, constraint)).sort((a, b) => b - a)[0];
    return version === undefined ? undefined : { manifest: record.manifest, version };
  }

  return {
    async snapshot(requires): Promise<RecipeEnvironment> {
      const contracts: Record<string, AppPortManifest | undefined> = {};
      const providers: Record<string, { eligible: number }> = {};
      for (const d of requires) {
        const record = await options.contracts.get(target(d).contract);
        contracts[target(d).contract] = record?.status === "active" ? record.manifest : undefined;
        const found = await resolver().discoverCanonical({ contract: target(d).contract, capability: target(d).capability, versionConstraint: d.versionConstraint ?? "1" });
        providers[d.id] = { eligible: found.kind === "discovered" ? found.eligible.length : 0 };
      }
      return { contracts, providers };
    },

    async invoke(request: GatewayRequest): Promise<GatewayResult> {
      const { dependency } = request;
      const chosen = await versionOf(dependency);
      if (!chosen) return { kind: "unresolved", reason: `contract ${target(dependency).contract} has no active version of ${target(dependency).capability} accepted by ${dependency.versionConstraint ?? "1"}` };
      const resolution = await resolver().resolveRequirement({
        name: target(dependency).capability,
        version: chosen.version,
        ...(dependency.versionConstraint ? { versionConstraint: dependency.versionConstraint } : {}),
        canonical: { contract: target(dependency).contract },
        ...((dependency.target as { provider?: string }).provider ? { provider: { applicationId: (dependency.target as { provider: string }).provider } } : {})
      } as never);
      if (resolution.kind !== "resolved") return { kind: "unresolved", reason: resolution.kind === "ambiguous" ? "more than one eligible provider" : resolution.reason };

      // Authorization is decided now, from the durable grant, for this consumer, this provider and this capability.
      const bound = await options.binder.bindResolution(options.consumer, resolution);
      if (bound.kind === "denied") return { kind: "denied", reason: bound.authorization.reason, message: bound.authorization.message };

      const { binding } = bound;
      const definition = options.capabilityFor(binding.provider.id, binding.capability.name, binding.capability.version);
      if (!definition) return { kind: "rejected", code: "PROVIDER_UNAVAILABLE", message: `${binding.provider.id} serves no executable ${binding.capability.name}@${binding.capability.version} here` };

      const context = {
        requestId: request.requestId,
        traceId: request.requestId,
        capability: { ...binding.capability },
        authorization: { permissions: [] },
        metadata: {},
        idempotencyKey: request.idempotencyKey,
        signal: request.signal ?? new AbortController().signal,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        extensions: {},
        emit: async () => {},
        services: {}
      };
      const result = await invoker.invoke({ binding, input: request.input, caller: { requestId: request.requestId } }, definition as never, context as never);
      const provider = {
        application: binding.provider.id,
        capability: { ...binding.capability },
        registrationId: binding.provider.registrationId,
        fingerprint: binding.provider.fingerprint
      };
      switch (result.kind) {
        case "success": {
          const integration = (chosen.manifest.attributes as Record<string, { capabilities?: Record<string, CapabilityIntegration> }> | undefined)?.[INTEGRATION_EXTENSION];
          const declared = integration?.capabilities?.[`${target(dependency).capability}@${chosen.version}`]?.verify ?? [];
          return {
            kind: "success",
            output: result.output as JsonValue,
            provider,
            canonical: { contract: target(dependency).contract, capability: target(dependency).capability, version: chosen.version },
            verification: declared.filter((m): m is StateVerification => m.kind === "state")
          };
        }
        case "failed": {
          // Stopped by AppPort before the implementation ran: nothing can have happened.
          if (result.error.kind === "invalid_binding" || result.error.kind === "invalid_context" || result.error.kind === "invalid_input") return { kind: "rejected", code: result.error.kind, message: failureMessage((result.error as { reason?: string }).reason ?? result.error.kind) };
          return { kind: "failed", code: result.error.kind, message: failureMessage((result.error as { reason?: string }).reason ?? result.error.kind) };
        }
        case "cancelled":
        case "timed_out":
          return { kind: "failed", code: result.kind, message: failureMessage(result.reason ?? result.kind) };
      }
    }
  };
}
