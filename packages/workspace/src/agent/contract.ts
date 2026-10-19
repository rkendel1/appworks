/**
 * The AppWorks agent contract (`appworks.agent/1`): the only thing the workflow knows about an agent.
 *
 * An agent is asked for ONE decision at a time: given the task, a compact view of the project's durable state, the
 * actions it may request now (each with a JSON Schema), the evidence so far and the history of its earlier decisions
 * and their actual results, it answers with exactly one of: request an action, ask a human, or finish. It does not
 * execute anything. AppWorks validates the decision against the request, enforces authority and approval, executes the
 * action through its own workflow, records the result, and asks again with the result in the history. A multi-turn
 * tool loop is therefore the orchestrator's; an agent that keeps state of its own may use it, but must accept that the
 * history in the request is authoritative.
 *
 * Nothing an agent returns is evidence. It cannot mark a stage complete, grant or consume an approval, or report that
 * an operation succeeded: only the workflow's own execution results and recorded evidence do that.
 *
 * Provider SDKs, message formats, tool-call objects, usage types and exceptions stay inside each adapter; adapters
 * translate them into these types and into `AgentError`.
 */
import { fromJSONSchema } from "@appport/schema";

export const AGENT_CONTRACT = "appworks.agent/1";
export const REQUEST_FORMAT = "appworks.agent-request/1";
export const RESPONSE_FORMAT = "appworks.agent-response/1";

export interface AgentIdentity {
  /** The configured provider name, e.g. `anthropic`, `openai`, `deterministic`, `fake`. */
  provider: string;
  /** The adapter implementation and its version, e.g. `appworks-anthropic@1`. */
  implementation: string;
  /** The model, where the provider has one. Never a credential. */
  model?: string;
}

/** What an implementation supports beyond the common contract. Optional features are declared, never assumed. */
export interface AgentCapabilities {
  /** Keeps state of its own between decisions (it still receives the full history). */
  statefulSessions: boolean;
  /** Honors `AbortSignal` mid-decision (every adapter honors it between decisions). */
  cancellation: boolean;
  /** Reports token usage. */
  usage: boolean;
  /** Runs in process (true) or calls a remote service (false). */
  local: boolean;
  /** Uses a language model (false for rule-based agents). */
  model: boolean;
}

/**
 * What running an action can affect. `none`: reads only. `workspace-state`: records in the workspace. `external-read`:
 * reads from outside (a repository host, a running application). `executes-target-code`: runs reviewed code against the
 * isolated checkout or worktree. `isolated-write`: writes an isolated worktree. `local-commit`: commits in it.
 */
export type SideEffect = "none" | "workspace-state" | "external-read" | "executes-target-code" | "isolated-write" | "local-commit";

/** An action the agent may request in this turn. */
export interface ActionSpec {
  /** Versioned identifier, e.g. `workflow.assess@1`. */
  id: string;
  description: string;
  /** JSON Schema (2020-12 subset) of its arguments: an object. */
  input: Record<string, unknown>;
  sideEffect: SideEffect;
  /** The approval its execution needs, if any; requesting it without one pauses the run for that approval. */
  approval?: string;
}

export interface HistoryEntry {
  turn: number;
  decision: AgentDecision | null;
  /** What actually happened. `invalid`: the decision was rejected before anything ran. */
  result: ActionOutcome;
}

/**
 * What actually happened in a turn, as AppWorks recorded it. `invalid`: the decision was rejected before anything ran.
 * `class` says what kind of information `data` is: a workflow record (evidence the workflow produced), an observation
 * of the pinned source or the workspace (read-only, not evidence for any stage), or a human answer.
 */
export interface ActionOutcome {
  status: "succeeded" | "failed" | "refused" | "invalid" | "interrupted" | "paused" | "answered";
  summary: string;
  code?: string;
  class?: "workflow-record" | "source-observation" | "workspace-read" | "human-answer" | "none";
  evidence?: string[];
  data?: unknown;
}

export interface AgentRequest {
  format: typeof REQUEST_FORMAT;
  run: string;
  turn: number;
  task: string;
  /** Compact durable state: the workflow stage, its condition, the evidence summaries. Never credentials. */
  context: Record<string, unknown>;
  actions: ActionSpec[];
  history: HistoryEntry[];
  constraints: { remainingTurns: number; deadline?: string; rules: string[] };
}

export type AgentDecision =
  | { kind: "action"; action: string; arguments: Record<string, unknown>; rationale: string; expectation?: string }
  | { kind: "ask"; question: string; rationale: string; options?: string[] }
  | { kind: "finish"; outcome: "done" | "blocked" | "nothing-to-do"; rationale: string; blockers?: string[] };

export interface AgentResponse {
  format: typeof RESPONSE_FORMAT;
  decision: AgentDecision;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** The provider's own identifier for this call, for correlation only. */
  providerRef?: string;
}

export interface DecideOptions {
  signal?: AbortSignal;
  /** Bound on this one decision. */
  timeoutMs?: number;
}

export interface AgentAdapter {
  readonly identity: AgentIdentity;
  readonly capabilities: AgentCapabilities;
  decide(request: AgentRequest, options?: DecideOptions): Promise<AgentResponse>;
  /** Releases resources (sessions, processes). Optional. */
  close?(): Promise<void>;
}

/**
 * Every adapter failure, normalized. `retryable` is the adapter's guidance; the orchestrator's retry policy is bounded
 * and never retries a permanent failure, and never switches to another provider.
 */
export type AgentErrorKind = "invalid-output" | "timeout" | "rate-limited" | "transient" | "authentication" | "configuration" | "cancelled" | "refused" | "unknown";
const RETRYABLE: Record<AgentErrorKind, boolean> = { "invalid-output": true, timeout: true, "rate-limited": true, transient: true, authentication: false, configuration: false, cancelled: false, refused: false, unknown: false };

export class AgentError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: AgentErrorKind,
    message: string,
    readonly options: { retryAfterMs?: number; status?: number } = {}
  ) {
    super(message);
    this.name = "AgentError";
    this.retryable = RETRYABLE[kind];
  }
}

/** Text that must never reach a model, a log or a record: anything that looks like a credential is removed. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]");
}

export interface DecisionProblem {
  code: "RESPONSE_FORMAT" | "DECISION_KIND" | "ACTION_UNKNOWN" | "ARGUMENTS_INVALID" | "FIELD_MISSING";
  message: string;
}

/**
 * Validates a response against the request it answers, deterministically, before anything is executed: the format,
 * the decision's shape, that a requested action is one offered in this turn, and that its arguments satisfy the
 * action's schema. A response that fails is never executed.
 */
export function validateResponse(response: unknown, request: AgentRequest): DecisionProblem[] {
  const r = response as AgentResponse;
  if (!r || typeof r !== "object" || r.format !== RESPONSE_FORMAT || !r.decision || typeof r.decision !== "object") return [{ code: "RESPONSE_FORMAT", message: `not an ${RESPONSE_FORMAT} response` }];
  const d = r.decision as AgentDecision & Record<string, unknown>;
  const text = (k: string) => typeof d[k] === "string" && (d[k] as string).trim().length > 0;
  if (!text("rationale")) return [{ code: "FIELD_MISSING", message: "a decision states its rationale" }];
  if (d.kind === "ask") return text("question") ? [] : [{ code: "FIELD_MISSING", message: "a question is required" }];
  if (d.kind === "finish") return ["done", "blocked", "nothing-to-do"].includes(d.outcome as string) ? [] : [{ code: "FIELD_MISSING", message: "finish states an outcome: done, blocked or nothing-to-do" }];
  if (d.kind !== "action") return [{ code: "DECISION_KIND", message: `unknown decision kind ${String((d as { kind?: unknown }).kind)}` }];
  const spec = request.actions.find((a) => a.id === d.action);
  if (!spec) return [{ code: "ACTION_UNKNOWN", message: `${String(d.action)} is not one of the actions offered in this turn: ${request.actions.map((a) => a.id).join(", ")}` }];
  if (!d.arguments || typeof d.arguments !== "object" || Array.isArray(d.arguments)) return [{ code: "ARGUMENTS_INVALID", message: "arguments are an object" }];
  const checked = fromJSONSchema(spec.input as never).validate(d.arguments);
  if (!checked.ok) return [{ code: "ARGUMENTS_INVALID", message: `${spec.id}: ${checked.issues.map((i: { path?: unknown; message: string }) => `${Array.isArray(i.path) && i.path.length ? i.path.join(".") + ": " : ""}${i.message}`).join("; ")}` }];
  return [];
}
