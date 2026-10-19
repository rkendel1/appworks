/**
 * One conformance suite for every agent adapter. The model-backed adapters run against a fake HTTP layer (each SDK's
 * own `fetch` option), so CI needs no credential; the live checks at the end run only when a key and a model are set.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentError, agentConfig, anthropicAgent, createAgent, deterministicAgent, openaiAgent, REQUEST_FORMAT, RESPONSE_FORMAT, scriptedAgent, toolName, validateResponse, WorkspaceError, type AgentAdapter, type AgentRequest } from "../src/index.js";

const KEY = "sk-test-CONFORMANCEKEY0123456789abcdef";

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    format: REQUEST_FORMAT,
    run: "prj_x.agent.1",
    turn: 2,
    task: "carry the project",
    context: { project: { stage: "capabilities-discovered" }, advisor: { summary: "assess next", actions: [{ action: "assess", reason: "static assessment" }] } },
    actions: [
      { id: "workflow.assess@1", description: "Assess.", input: { type: "object", properties: {}, additionalProperties: false }, sideEffect: "workspace-state" },
      { id: "workflow.select@1", description: "Select.", input: { type: "object", properties: { candidate: { type: "string", enum: ["c1"] }, rationale: { type: "string", minLength: 1 } }, required: ["candidate", "rationale"], additionalProperties: false }, sideEffect: "workspace-state" },
      { id: "workflow.execute@1", description: "Execute.", input: { type: "object", properties: {}, additionalProperties: false }, sideEffect: "executes-target-code", approval: "generate-files" }
    ],
    history: [{ turn: 1, decision: { kind: "action", action: "workflow.discover@1", arguments: {}, rationale: "first" }, result: { status: "succeeded", class: "workflow-record", summary: "discover succeeded: RESULT-MARKER-42", evidence: ["prj_x.discover.1"] } }],
    constraints: { remainingTurns: 7, rules: ["one decision"] },
    ...overrides
  };
}

type Reply = { tool?: string; input?: unknown; rawArguments?: string; text?: string; status?: number; headers?: Record<string, string>; hang?: boolean };
interface Http {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; body: string; headers: Headers }>;
}

/** A fake HTTP layer speaking either provider's wire format. */
function http(provider: "anthropic" | "openai", reply: Reply): Http {
  const calls: Http["calls"] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
    if (reply.hang)
      return new Promise((_, reject) => {
        const s = init?.signal;
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (s?.aborted) abort();
        s?.addEventListener("abort", abort, { once: true });
      });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...reply.headers } });
    if (reply.status && reply.status >= 400) return json(reply.status, provider === "anthropic" ? { type: "error", error: { type: "error", message: `failure ${reply.status}` } } : { error: { message: `failure ${reply.status}`, type: "error" } });
    if (provider === "anthropic")
      return json(200, { id: "msg_1", type: "message", role: "assistant", model: "m", content: reply.tool ? [{ type: "tool_use", id: "toolu_1", name: reply.tool, input: reply.input ?? {} }] : [{ type: "text", text: reply.text ?? "I think we should assess." }], stop_reason: reply.tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 12, output_tokens: 7 } });
    return json(200, { id: "resp_1", object: "response", created_at: 0, status: "completed", model: "m", output: reply.tool ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: reply.tool, arguments: reply.rawArguments ?? JSON.stringify(reply.input ?? {}), status: "completed" }] : [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply.text ?? "assess", annotations: [] }] }], usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }, parallel_tool_calls: false, tool_choice: "required", tools: [] });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const make = (provider: "anthropic" | "openai", h: Http): AgentAdapter => (provider === "anthropic" ? anthropicAgent({ apiKey: KEY, model: "test-model", fetch: h.fetch }) : openaiAgent({ apiKey: KEY, model: "test-model", fetch: h.fetch }));

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (error) => error);
  expect(e).toBeInstanceOf(AgentError);
  return e as AgentError;
};

for (const provider of ["anthropic", "openai"] as const) {
  describe(`the ${provider} adapter conforms to appworks.agent/1`, () => {
    it("valid output: a forced tool call becomes a contract decision, with usage, from one request", async () => {
      const h = http(provider, { tool: toolName("workflow.select@1"), input: { rationale: "best evidence", arguments: { candidate: "c1", rationale: "reviewed" } } });
      const req = request();
      const response = await make(provider, h).decide(req);
      expect(response.format).toBe(RESPONSE_FORMAT);
      expect(response.decision).toEqual({ kind: "action", action: "workflow.select@1", arguments: { candidate: "c1", rationale: "reviewed" }, rationale: "best evidence" });
      expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
      expect(validateResponse(response, req)).toEqual([]);
      expect(h.calls).toHaveLength(1);
      const body = JSON.parse(h.calls[0]!.body);
      expect(body.model).toBe("test-model");
      if (provider === "anthropic") expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
      else expect([body.tool_choice, body.store, body.parallel_tool_calls]).toEqual(["required", false, false]);
      expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["workflow__assess_v1", "workflow__select_v1", "workflow__execute_v1", "ask_person", "finish_run"]);
      // The key is a header, never in the body; the request goes only to the provider's endpoint.
      expect(h.calls[0]!.body).not.toContain(KEY);
      expect(h.calls[0]!.url).toMatch(provider === "anthropic" ? /^https:\/\/api\.anthropic\.com\/v1\/messages/ : /^https:\/\/api\.openai\.com\/v1\/responses/);
    });

    it("finish and ask map to their decisions", async () => {
      expect((await make(provider, http(provider, { tool: "finish_run", input: { outcome: "blocked", rationale: "no candidate", blockers: ["NO_PLAN"] } })).decide(request())).decision).toEqual({ kind: "finish", outcome: "blocked", rationale: "no candidate", blockers: ["NO_PLAN"] });
      expect((await make(provider, http(provider, { tool: "ask_person", input: { question: "which origin?", rationale: "unknown" } })).decide(request())).decision).toEqual({ kind: "ask", question: "which origin?", rationale: "unknown" });
    });

    it("invalid output: an answer without a tool call, or unreadable arguments, is invalid-output", async () => {
      expect((await failure(make(provider, http(provider, { text: "let's assess" })).decide(request()))).kind).toBe("invalid-output");
      if (provider === "openai") expect((await failure(make(provider, http(provider, { tool: "workflow__assess_v1", rawArguments: "{not json" })).decide(request()))).kind).toBe("invalid-output");
    });

    it("unknown action and invalid arguments are returned as decided and rejected by validation, the same for every provider", async () => {
      const req = request();
      const unknown = await make(provider, http(provider, { tool: "shell_exec", input: { rationale: "x", arguments: { cmd: "ls" } } })).decide(req);
      expect(validateResponse(unknown, req).map((p) => p.code)).toEqual(["ACTION_UNKNOWN"]);
      const invalid = await make(provider, http(provider, { tool: toolName("workflow.select@1"), input: { rationale: "x", arguments: { candidate: "c9" } } })).decide(req);
      expect(validateResponse(invalid, req).map((p) => p.code)).toEqual(["ARGUMENTS_INVALID"]);
    });

    it("timeout, rate limit, authentication, transient and request failures are normalized, and the SDK never retries", async () => {
      const t0 = Date.now();
      expect((await failure(make(provider, http(provider, { hang: true })).decide(request(), { timeoutMs: 100 }))).kind).toBe("timeout");
      expect(Date.now() - t0).toBeLessThan(3_000);
      const limited = http(provider, { status: 429, headers: { "retry-after": "2" } });
      const rl = await failure(make(provider, limited).decide(request()));
      expect([rl.kind, rl.retryable, rl.options.retryAfterMs]).toEqual(["rate-limited", true, 2_000]);
      expect(limited.calls).toHaveLength(1);
      const auth = await failure(make(provider, http(provider, { status: 401 })).decide(request()));
      expect([auth.kind, auth.retryable]).toEqual(["authentication", false]);
      expect(auth.message).not.toContain(KEY);
      expect((await failure(make(provider, http(provider, { status: 503 })).decide(request()))).kind).toBe("transient");
      expect((await failure(make(provider, http(provider, { status: 400 })).decide(request()))).kind).toBe("configuration");
    });

    it("cancellation aborts the request in flight", async () => {
      const controller = new AbortController();
      const pending = make(provider, http(provider, { hang: true })).decide(request(), { signal: controller.signal, timeoutMs: 10_000 });
      setTimeout(() => controller.abort(), 50);
      expect((await failure(pending)).kind).toBe("cancelled");
    });

    it("tool-result continuation: the recorded result of the previous action is in the next request, with the bounds", async () => {
      const h = http(provider, { tool: "workflow__assess_v1", input: { rationale: "next", arguments: {} } });
      await make(provider, h).decide(request());
      const body = h.calls[0]!.body;
      expect(body).toContain("RESULT-MARKER-42");
      expect(body).toContain("remainingTurns");
      expect(body).toContain("one decision");
    });
  });
}

describe("the deterministic and scripted adapters conform to appworks.agent/1", () => {
  it("decide valid, offered actions from the advisor, without a model, a network or side effects", async () => {
    const req = request({ history: [] });
    const r = await deterministicAgent().decide(req);
    expect(r.decision).toMatchObject({ kind: "action", action: "workflow.assess@1", arguments: {} });
    expect(validateResponse(r, req)).toEqual([]);
    expect(deterministicAgent().capabilities).toMatchObject({ model: false, local: true });
  });

  it("continue from a recorded result: a failed action is a blocker, never retried blindly", async () => {
    const req = request({ history: [{ turn: 1, decision: { kind: "action", action: "workflow.assess@1", arguments: {}, rationale: "x" }, result: { status: "failed", code: "ASSESSMENT_FAILED", summary: "assess ran and failed" } }] });
    expect((await deterministicAgent().decide(req)).decision).toMatchObject({ kind: "finish", outcome: "blocked", blockers: [expect.stringMatching(/ASSESSMENT_FAILED/)] });
  });

  it("scripted: honors cancellation, and reports usage", async () => {
    const controller = new AbortController();
    const pending = scriptedAgent([{ kind: "finish", outcome: "done", rationale: "x" }], { delayMs: 5_000 }).decide(request(), { signal: controller.signal });
    controller.abort();
    expect((await failure(pending)).kind).toBe("cancelled");
    expect((await scriptedAgent([{ kind: "finish", outcome: "done", rationale: "x" }]).decide(request())).usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("agent configuration", () => {
  it("needs an explicit provider and never picks one from whichever key is set", () => {
    expect(() => agentConfig({ OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY })).toThrow(expect.objectContaining({ code: "AGENT_NOT_CONFIGURED" }));
    expect(() => agentConfig({ APPWORKS_AGENT_PROVIDER: "gemini" })).toThrow(expect.objectContaining({ code: "AGENT_MISCONFIGURED" }));
    expect(() => agentConfig({ APPWORKS_AGENT_PROVIDER: "stack-agent" })).toThrow(expect.objectContaining({ code: "AGENT_UNAVAILABLE" }));
    expect(() => agentConfig({ APPWORKS_AGENT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY })).toThrow(/APPWORKS_AGENT_MODEL/);
    expect(() => agentConfig({ APPWORKS_AGENT_PROVIDER: "openai", APPWORKS_AGENT_MODEL: "m", APPWORKS_AGENT_MAX_TURNS: "lots" })).toThrow(/APPWORKS_AGENT_MAX_TURNS/);
  });

  it("refuses a missing key by its variable's name, and keeps every key out of the configuration it shows", () => {
    const missing = agentConfig({ APPWORKS_AGENT_PROVIDER: "openai", APPWORKS_AGENT_MODEL: "m", ANTHROPIC_API_KEY: KEY });
    expect(missing.key).toEqual({ variable: "OPENAI_API_KEY", set: false });
    let error: unknown;
    try {
      createAgent(missing, { ANTHROPIC_API_KEY: KEY });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toMatch(/OPENAI_API_KEY/);
    const env = { APPWORKS_AGENT_PROVIDER: "anthropic", APPWORKS_AGENT_MODEL: "m", ANTHROPIC_API_KEY: KEY, APPWORKS_AGENT_TIMEOUT_MS: "5000", APPWORKS_AGENT_MAX_TURNS: "12" };
    const config = agentConfig(env);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(config).toMatchObject({ provider: "anthropic", model: "m", limits: { maxTurns: 12, decisionTimeoutMs: 5_000 }, key: { variable: "ANTHROPIC_API_KEY", set: true } });
    const made = createAgent(config, env);
    expect(made.agent.identity).toEqual({ provider: "anthropic", implementation: "appworks-anthropic@1", model: "m" });
    expect(made.secrets).toEqual([KEY]);
    expect(createAgent(agentConfig({ APPWORKS_AGENT_PROVIDER: "deterministic" }), {}).agent.identity.provider).toBe("deterministic");
  });
});

// Live checks: only with a key and a model (from the environment or the repository's .env.local, never printed).
const root = join(import.meta.dirname, "..", "..", "..");
const local = existsSync(join(root, ".env.local")) ? (parseEnv(readFileSync(join(root, ".env.local"), "utf8")) as Record<string, string>) : {};
const live = { ...local, ...process.env };
for (const [provider, keyVar, modelVar] of [["anthropic", "ANTHROPIC_API_KEY", "APPWORKS_LIVE_ANTHROPIC_MODEL"], ["openai", "OPENAI_API_KEY", "APPWORKS_LIVE_OPENAI_MODEL"]] as const) {
  describe.skipIf(!live[keyVar] || !live[modelVar])(`live ${provider} (${modelVar})`, () => {
    it("makes one valid decision against the real provider", async () => {
      const config = agentConfig({ ...live, APPWORKS_AGENT_PROVIDER: provider, APPWORKS_AGENT_MODEL: live[modelVar]! });
      const { agent } = createAgent(config, live);
      const req = request({ history: [] });
      const response = await agent.decide(req, { timeoutMs: 60_000 });
      expect(validateResponse(response, req)).toEqual([]);
    }, 90_000);
  });
}
