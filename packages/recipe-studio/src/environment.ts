/**
 * The environment a recipe is assessed against: the same module the CLI takes as `--environment`, default-exporting
 * `({ home }) => ({ gateway, authority? })`. It is the operator's: where providers are, which grants exist, who may start a
 * recipe. The Studio reads it and never writes to it.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CapabilityGateway, RuntimeAuthority } from "@appport/recipe-runtime";

export interface StudioEnvironment {
  /** The label the author sees; not an identity. */
  name: string;
  gateway: CapabilityGateway;
  authority?: RuntimeAuthority;
  close?(): Promise<void> | void;
}

export type EnvironmentLoader = (context: { home: string }) => Promise<Omit<StudioEnvironment, "name">>;

export function moduleLoader(modulePath: string): EnvironmentLoader {
  return async (context) => {
    const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as { default?: (c: { home: string }) => Omit<StudioEnvironment, "name"> | Promise<Omit<StudioEnvironment, "name">> };
    if (typeof loaded.default !== "function") throw new Error(`${modulePath} must default-export a function returning { gateway, authority? }`);
    return loaded.default(context);
  };
}
