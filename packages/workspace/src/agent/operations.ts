/**
 * The agent's domain operations, shared by the CLI and the web API exactly as `perform` is for workflow actions:
 * start, stop and resume a run, and the one agent view both render.
 */
import { WorkspaceError, type Principal } from "../model.js";
import type { Workspace } from "../workflow.js";
import { agentConfig, createAgent, type AgentConfig } from "./config.js";
import type { AgentAdapter } from "./contract.js";
import { AgentRuntime, DEFAULT_LIMITS, type AgentRunRecord, type AgentRuntimeOptions, type AgentTurnRecord, type RunLimits } from "./runner.js";

export interface AgentService {
  runtime: AgentRuntime;
  /** The configured agent, or why there is none. Never a credential. */
  configured(): { config: AgentConfig; implementation: string } | { error: { code: string; message: string } };
  /** Makes the configured agent (or the one an explicit override names), with the configured run limits. */
  make(override?: { provider?: string; model?: string }): { agent: AgentAdapter; limits: RunLimits };
}

const KEY_VARIABLES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const IMPLEMENTATION: Record<string, string> = { anthropic: "appworks-anthropic@1", openai: "appworks-openai@1", deterministic: "appworks-deterministic@1" };

/**
 * The agent service of a workspace, configured from `env` (the process environment, plus `.env.local` if loaded).
 * `agent` (tests) supplies the adapter instead of the configuration.
 */
export function agentService(ws: Workspace, env: NodeJS.ProcessEnv, options: AgentRuntimeOptions & { fetch?: typeof globalThis.fetch; agent?: () => AgentAdapter } = {}): AgentService {
  const secrets = KEY_VARIABLES.map((k) => env[k]).filter((v): v is string => Boolean(v));
  const runtime = new AgentRuntime(ws, { ...options, secrets: [...secrets, ...(options.secrets ?? [])] });
  return {
    runtime,
    make(override = {}) {
      if (options.agent && !override.provider) return { agent: options.agent(), limits: DEFAULT_LIMITS };
      const config = agentConfig(env, override);
      return { agent: createAgent(config, env, options.fetch ? { fetch: options.fetch } : {}).agent, limits: config.limits };
    },
    configured() {
      if (options.agent) {
        const identity = options.agent().identity;
        return { config: { provider: identity.provider as AgentConfig["provider"], ...(identity.model ? { model: identity.model } : {}), maxTokens: 0, limits: DEFAULT_LIMITS }, implementation: identity.implementation };
      }
      try {
        const config = agentConfig(env);
        return { config, implementation: IMPLEMENTATION[config.provider]! };
      } catch (error) {
        const e = error instanceof WorkspaceError ? error : new WorkspaceError("AGENT_MISCONFIGURED", (error as Error).message);
        return { error: { code: e.code, message: e.message } };
      }
    }
  };
}

export interface AgentView {
  format: "appworks.agent-view/1";
  project: string;
  configured: { provider: string; model?: string; implementation: string; limits: AgentConfig["limits"]; key?: { variable: string; set: boolean } } | { error: { code: string; message: string } };
  runs: Array<Pick<AgentRunRecord, "id" | "status" | "agent" | "startedAt" | "startedBy" | "turns" | "finishedAt"> & { interrupted: boolean }>;
  current?: { run: AgentRunRecord & { interrupted: boolean }; turns: AgentTurnRecord[] };
  note: string;
}

export async function agentView(service: AgentService, principal: Principal, projectId: string): Promise<AgentView> {
  const runs = await service.runtime.runs(principal, projectId);
  const latest = runs[0];
  const configured = service.configured();
  const { __version: _v, ...run } = (latest ?? {}) as AgentRunRecord & { interrupted: boolean };
  return {
    format: "appworks.agent-view/1",
    project: projectId,
    configured: "error" in configured ? configured : { provider: configured.config.provider, ...(configured.config.model ? { model: configured.config.model } : {}), implementation: configured.implementation, limits: configured.config.limits, ...(configured.config.key ? { key: configured.config.key } : {}) },
    runs: runs.map((r) => ({ id: r.id, status: r.status, agent: r.agent, startedAt: r.startedAt, startedBy: r.startedBy, turns: r.turns, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), interrupted: r.interrupted })),
    ...(latest ? { current: { run: run as AgentRunRecord & { interrupted: boolean }, turns: (await service.runtime.turns(principal, latest.id)).map(({ __version: _t, ...t }) => t) } } : {}),
    note: "The agent proposes; AppWorks validates and executes every action through the workflow, its authority and its approvals. An agent's rationale and its claimed outcome are not evidence: the workflow's records are."
  };
}

export const AGENT_ACTIONS = ["start", "stop", "resume"] as const;

export type AgentPerformed = { kind: "started"; run: string; done: Promise<AgentRunRecord> } | { kind: "done"; result: AgentRunRecord };

export async function performAgent(service: AgentService, principal: Principal, projectId: string, action: string, input: Record<string, unknown> = {}): Promise<AgentPerformed> {
  const text = (k: string) => (typeof input[k] === "string" && input[k] ? (input[k] as string) : undefined);
  const flag = (k: string) => input[k] === true || input[k] === "true";
  const override = { ...(text("agent") ? { provider: text("agent")! } : {}), ...(text("model") ? { model: text("model")! } : {}) };
  const runFor = async () => {
    if (text("run")) return text("run")!;
    const latest = (await service.runtime.runs(principal, projectId))[0];
    if (!latest) throw new WorkspaceError("NOT_FOUND", `project ${projectId} has no agent run`);
    return latest.id;
  };
  switch (action) {
    case "start": {
      const maxTurns = text("maxTurns") ?? text("max-turns") ?? (typeof input.maxTurns === "number" ? String(input.maxTurns) : undefined);
      if (maxTurns !== undefined && !/^[1-9]\d{0,3}$/.test(maxTurns)) throw new WorkspaceError("INVALID_INPUT", "maxTurns is a positive integer");
      const { agent, limits } = service.make(override);
      const started = await service.runtime.start(principal, projectId, { agent, ...(flag("endToEnd") || flag("end-to-end") ? { endToEnd: true } : {}), ...(text("task") ? { task: text("task")! } : {}), limits: { ...limits, ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}) } });
      return { kind: "started", ...started };
    }
    case "resume": {
      const runId = await runFor();
      const run = await service.runtime.run(principal, runId);
      if (run.projectId !== projectId) throw new WorkspaceError("NOT_FOUND", `${runId} is not an agent run of ${projectId}`);
      const started = await service.runtime.resume(principal, runId, { agent: service.make(override).agent, ...(text("answer") ? { answer: text("answer")! } : {}), switchAgent: flag("switchAgent") || flag("switch-agent"), ...(flag("endToEnd") || flag("end-to-end") ? { endToEnd: true } : {}) });
      return { kind: "started", ...started };
    }
    case "stop": {
      const runId = await runFor();
      const run = await service.runtime.run(principal, runId);
      if (run.projectId !== projectId) throw new WorkspaceError("NOT_FOUND", `${runId} is not an agent run of ${projectId}`);
      return { kind: "done", result: await service.runtime.stop(principal, runId, text("reason") ?? "stopped") };
    }
    default:
      throw new WorkspaceError("INVALID_INPUT", `unknown agent action ${action}; agent actions are ${AGENT_ACTIONS.join(", ")}`);
  }
}
