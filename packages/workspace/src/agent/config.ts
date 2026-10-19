/**
 * Selecting the agent, from configuration only. The provider is named explicitly (`APPWORKS_AGENT_PROVIDER`, or an
 * explicit override from the command line); it is never inferred from whichever key happens to be set, and a
 * misconfigured or failing provider is never replaced by another one. Keys are read from the environment at the
 * moment the adapter is made and kept only in that adapter; they are returned separately as values to scrub, and never
 * appear in the configuration that is shown or recorded.
 *
 *   APPWORKS_AGENT_PROVIDER     anthropic | openai | deterministic
 *   APPWORKS_AGENT_MODEL        the model (required for anthropic and openai)
 *   ANTHROPIC_API_KEY, OPENAI_API_KEY             the provider's key
 *   ANTHROPIC_BASE_URL, OPENAI_BASE_URL           optional endpoint override
 *   APPWORKS_AGENT_TIMEOUT_MS   one decision's bound (default 120000)
 *   APPWORKS_AGENT_MAX_TURNS    decisions per run (default 40)
 *   APPWORKS_AGENT_MAX_RETRIES  retries of a decision after a retryable failure (default 2)
 *   APPWORKS_AGENT_MAX_TOKENS   output tokens per decision (default 2048)
 */
import { WorkspaceError } from "../model.js";
import type { AgentAdapter } from "./contract.js";
import { anthropicAgent } from "./providers/anthropic.js";
import { deterministicAgent } from "./providers/deterministic.js";
import { openaiAgent } from "./providers/openai.js";
import { DEFAULT_LIMITS, type RunLimits } from "./runner.js";

export const PROVIDERS = ["anthropic", "openai", "deterministic"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The configuration as it may be shown and recorded: no key, only whether one is set. */
export interface AgentConfig {
  provider: Provider;
  model?: string;
  baseURL?: string;
  maxTokens: number;
  limits: RunLimits;
  key?: { variable: string; set: boolean };
}

const KEY: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
const BASE: Record<string, string> = { anthropic: "ANTHROPIC_BASE_URL", openai: "OPENAI_BASE_URL" };

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new WorkspaceError("AGENT_MISCONFIGURED", `${name} must be a positive integer`);
  return n;
}

/** Reads and checks the agent configuration. Refuses clearly; never falls back to another provider. */
export function agentConfig(env: NodeJS.ProcessEnv, override: { provider?: string; model?: string } = {}): AgentConfig {
  const provider = (override.provider ?? env.APPWORKS_AGENT_PROVIDER ?? "").trim();
  if (!provider) throw new WorkspaceError("AGENT_NOT_CONFIGURED", `no agent is configured: set APPWORKS_AGENT_PROVIDER to one of ${PROVIDERS.join(", ")} (or pass --agent)`);
  if (provider === "stack-agent") throw new WorkspaceError("AGENT_UNAVAILABLE", "stack-agent has no AppWorks adapter yet; it will plug in behind the appworks.agent/1 contract. Choose one of " + PROVIDERS.join(", "));
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new WorkspaceError("AGENT_MISCONFIGURED", `unknown agent provider ${provider}; choose one of ${PROVIDERS.join(", ")}`);
  const limits: RunLimits = {
    maxTurns: positive(env, "APPWORKS_AGENT_MAX_TURNS", DEFAULT_LIMITS.maxTurns),
    decisionTimeoutMs: positive(env, "APPWORKS_AGENT_TIMEOUT_MS", DEFAULT_LIMITS.decisionTimeoutMs),
    maxRetries: env.APPWORKS_AGENT_MAX_RETRIES === "0" ? 0 : positive(env, "APPWORKS_AGENT_MAX_RETRIES", DEFAULT_LIMITS.maxRetries),
    maxInvalid: DEFAULT_LIMITS.maxInvalid
  };
  const maxTokens = positive(env, "APPWORKS_AGENT_MAX_TOKENS", 2048);
  if (provider === "deterministic") return { provider, maxTokens, limits };
  const model = (override.model ?? env.APPWORKS_AGENT_MODEL ?? "").trim();
  if (!model) throw new WorkspaceError("AGENT_MISCONFIGURED", `the ${provider} agent needs a model: set APPWORKS_AGENT_MODEL (or pass --model)`);
  const baseURL = env[BASE[provider]!]?.trim();
  if (baseURL && !/^https?:\/\/[^\s@]+$/.test(baseURL)) throw new WorkspaceError("AGENT_MISCONFIGURED", `${BASE[provider]} is not an http(s) URL without credentials`);
  return { provider: provider as Provider, model, ...(baseURL ? { baseURL } : {}), maxTokens, limits, key: { variable: KEY[provider]!, set: Boolean(env[KEY[provider]!]) } };
}

/**
 * Makes the configured adapter. A missing key is refused here, naming the variable (never a value). Returns the
 * adapter and the values every record and log must be scrubbed of.
 */
export function createAgent(config: AgentConfig, env: NodeJS.ProcessEnv, deps: { fetch?: typeof globalThis.fetch } = {}): { agent: AgentAdapter; secrets: string[] } {
  if (config.provider === "deterministic") return { agent: deterministicAgent(), secrets: [] };
  const variable = KEY[config.provider]!;
  const apiKey = env[variable];
  if (!apiKey) throw new WorkspaceError("AGENT_MISCONFIGURED", `the ${config.provider} agent needs ${variable}; it is not set (it is read from the environment or .env.local, and never stored)`);
  const options = { apiKey, model: config.model!, maxTokens: config.maxTokens, ...(config.baseURL ? { baseURL: config.baseURL } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) };
  return { agent: config.provider === "anthropic" ? anthropicAgent(options) : openaiAgent(options), secrets: [apiKey] };
}
