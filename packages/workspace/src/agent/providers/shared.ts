/**
 * What the model-backed adapters share: the prompt (the request as JSON, nothing else), the tools (one per offered
 * action, plus asking a person and finishing), turning a tool call back into a contract decision, and classifying HTTP
 * failures. Provider message formats stay in each adapter.
 */
import { AgentError, redact, type AgentDecision, type AgentRequest } from "../contract.js";

export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export const ASK_TOOL = "ask_person";
export const FINISH_TOOL = "finish_run";

/** `workflow.request-approval@1` → `workflow__request-approval_v1`: provider tool names allow `[A-Za-z0-9_-]` only. */
export const toolName = (action: string) => action.replace(/\./g, "__").replace(/@(\d+)$/, "_v$1").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

export function systemPrompt(request: AgentRequest): string {
  return [
    "You are the decision-maker of an AppWorks agent run. AppWorks carries a software repository through a fixed, evidence-checked workflow; you choose the next step.",
    "Each turn you receive the run's task, the project's recorded state (context), the actions offered now, the history of your earlier decisions with what actually happened, and constraints. Respond by calling exactly one tool.",
    "Rules:",
    ...request.constraints.rules.map((r) => `- ${r}`)
  ].join("\n");
}

/** The whole request as one JSON document: stateless, and the history in it is authoritative. */
export function requestPrompt(request: AgentRequest): string {
  const { actions, ...rest } = request;
  return `${JSON.stringify({ ...rest, actions: actions.map((a) => ({ id: a.id, tool: toolName(a.id), sideEffect: a.sideEffect, ...(a.approval ? { approval: a.approval } : {}) })) }, null, 1)}\n\nCall exactly one tool.`;
}

export function toolsFor(request: AgentRequest): Tool[] {
  return [
    ...request.actions.map((a) => ({
      name: toolName(a.id),
      description: `${a.id}: ${a.description} Side effect: ${a.sideEffect}.${a.approval ? ` Requires a person's ${a.approval} approval of the current subject; without it the run pauses for that approval.` : ""}`.slice(0, 1024),
      schema: { type: "object", properties: { rationale: { type: "string", description: "why this action, from the evidence" }, arguments: a.input }, required: ["rationale", "arguments"], additionalProperties: false }
    })),
    {
      name: ASK_TOOL,
      description: "Ask a person a question only they can answer (a choice, missing information). The run pauses until they answer.",
      schema: { type: "object", properties: { question: { type: "string" }, rationale: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "rationale"], additionalProperties: false }
    },
    {
      name: FINISH_TOOL,
      description: "End the run: done (nothing more can be done without a person), blocked (the evidence shows the workflow cannot continue; list the blockers) or nothing-to-do.",
      schema: { type: "object", properties: { outcome: { type: "string", enum: ["done", "blocked", "nothing-to-do"] }, rationale: { type: "string" }, blockers: { type: "array", items: { type: "string" } } }, required: ["outcome", "rationale"], additionalProperties: false }
    }
  ];
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * A tool call → a contract decision. An unknown tool becomes an action decision naming it, so the orchestrator's
 * validation (not the adapter) rejects it, the same way for every provider.
 */
export function decisionFrom(request: AgentRequest, name: string, input: unknown): AgentDecision {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (name === FINISH_TOOL) return { kind: "finish", outcome: i.outcome as "done", rationale: text(i.rationale), ...(Array.isArray(i.blockers) ? { blockers: i.blockers.map(String) } : {}) };
  if (name === ASK_TOOL) return { kind: "ask", question: text(i.question), rationale: text(i.rationale), ...(Array.isArray(i.options) ? { options: i.options.map(String) } : {}) };
  const action = request.actions.find((a) => toolName(a.id) === name)?.id ?? name;
  return { kind: "action", action, arguments: (i.arguments ?? {}) as Record<string, unknown>, rationale: text(i.rationale) };
}

/** HTTP status → the contract's error kinds. */
export function fromStatus(status: number | undefined, message: string, headers: { get(name: string): string | null } | undefined, secrets: string[]): AgentError {
  const m = redact(message, secrets);
  if (status === 401 || status === 403) return new AgentError("authentication", `the provider refused the credential (${status}): ${m}`, { status });
  if (status === 429) {
    const ms = Number(headers?.get("retry-after-ms"));
    const s = Number(headers?.get("retry-after"));
    return new AgentError("rate-limited", `rate limited (429): ${m}`, { status, ...(Number.isFinite(ms) && ms > 0 ? { retryAfterMs: ms } : Number.isFinite(s) && s > 0 ? { retryAfterMs: s * 1000 } : {}) });
  }
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return new AgentError("transient", `the provider failed (${status}): ${m}`, { status });
  if (status === 400 || status === 404 || status === 413 || status === 422) return new AgentError("configuration", `the provider rejected the request (${status}): ${m}`, { status });
  return new AgentError("unknown", m, status ? { status } : {});
}
