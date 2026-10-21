/**
 * A real AppPort environment for the accounting contract: AppPort's registries, resolver, binder with durable grants
 * and invoker (`@appport/core`), the contract registered and active, providers over persisted ledgers, and the runtime
 * registered as the consumer. Nothing here is a stand-in for AppPort; only the accounting application is test code.
 */
import { join } from "node:path";
import {
  ApplicationRegistry,
  CanonicalContractRegistry,
  CapabilityBinder,
  MemoryApplicationStateStore,
  MemoryAuthorizationGrantStore,
  defineApplication,
  durableAuthorizationPolicy,
  type ApplicationState
} from "@appport/core";
import type { RecipeSource } from "@appport/recipe";
import { consumerRequirements, createAppPortGateway } from "../../src/index.js";
import { CONTRACT, accountingContract } from "./contract.js";
import { Ledger } from "./ledger.js";
import { ledgerProvider, type ProviderNames } from "./provider.js";

export const CONSUMER = "org.appworks.recipe-runtime";
export const LEDGER_NAMES: ProviderNames = { duplicate: "ledger.duplicates", get: "ledger.read", submit: "ledger.post", resolve: "ledger.resolve" };
export const BOOKS_NAMES: ProviderNames = { duplicate: "books.lookup", get: "books.fetch", submit: "books.record", resolve: "books.resolve" };

type Provider = ReturnType<typeof ledgerProvider>;

export interface ProviderSpec {
  id: string;
  names: ProviderNames;
}

export async function accountingEnvironment(dir: string, recipe: RecipeSource, providers: ProviderSpec[] = [{ id: "com.example.ledger", names: LEDGER_NAMES }], options: { grant?: boolean } = {}) {
  const registry = new ApplicationRegistry(new MemoryApplicationStateStore());
  const contracts = new CanonicalContractRegistry();
  await contracts.register(accountingContract());
  await contracts.activate(CONTRACT);

  const ledgers: Record<string, Ledger> = {};
  const served: Record<string, Provider> = {};
  const register = async (app: ReturnType<typeof defineApplication>): Promise<ApplicationState> =>
    registry.activate((await registry.register({ identity: app.identity, manifest: app.manifest(), fingerprint: app.fingerprint(), verification: app.verify() })).id);
  for (const spec of providers) {
    ledgers[spec.id] = Ledger.open(join(dir, `ledger-${spec.id}`));
    served[spec.id] = ledgerProvider(spec.id, accountingContract(), ledgers[spec.id]!, spec.names);
    await register(served[spec.id]!.app);
  }
  const consumer = await register(defineApplication({ identity: { id: CONSUMER, name: "AppWorks recipe runtime", version: "1.0.0" }, provides: [], requires: consumerRequirements(recipe, [{ contract: CONTRACT, capability: "invoice.operation.resolve" }]) }));

  const grants = new MemoryAuthorizationGrantStore();
  const subject = (provider: string, capabilityName: string) => ({ consumerId: consumer.id, providerId: provider, capabilityName, capabilityVersion: 1 });
  /** Grants the runtime every capability a provider serves (the durable authority AppPort checks at each binding). */
  const grantAll = async (provider: string) => {
    for (const name of Object.values(served[provider]!.names)) await grants.grant(subject(provider, name));
  };
  if (options.grant !== false) for (const spec of providers) await grantAll(spec.id);

  const gateway = createAppPortGateway({
    registry,
    contracts,
    consumer,
    binder: new CapabilityBinder(durableAuthorizationPolicy(grants)),
    capabilityFor: (application, name, version) => served[application]?.capability(name, version)
  });

  return {
    gateway,
    registry,
    contracts,
    consumer,
    grants,
    grantAll,
    revoke: (provider: string, capability: keyof ProviderNames) => grants.revoke(subject(provider, served[provider]!.names[capability]), "revoked by test"),
    ledgers,
    ledger: ledgers[providers[0]?.id ?? ""] as Ledger,
    async close() {
      await Promise.all(Object.values(ledgers).map((l) => l.close()));
    }
  };
}
