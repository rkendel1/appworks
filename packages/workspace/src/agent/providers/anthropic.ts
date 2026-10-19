/**
 * The Anthropic adapter: one Messages API call per decision, the request as one user message, one tool per offered
 * action and a forced tool choice. Stateless; no SDK retries (the orchestrator's policy is the only one). The key is
 * passed in by configuration and never read from the environment by the SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AgentError, RESPONSE_FORMAT, type AgentAdapter, type AgentRequest, type AgentResponse, type DecideOptions } from "../contract.js";
import { decisionFrom, fromStatus, requestPrompt, systemPrompt, toolsFor } from "./shared.js";

export interface AnthropicAgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  /** Tests: the HTTP layer. */
  fetch?: typeof globalThis.fetch;
}

export function anthropicAgent(options: AnthropicAgentOptions): AgentAdapter {
  const client = new Anthropic({ apiKey: options.apiKey, authToken: null, webhookKey: null, baseURL: options.baseURL ?? "https://api.anthropic.com", maxRetries: 0, logLevel: "off", ...(options.fetch ? { fetch: options.fetch } : {}) });
  const secrets = [options.apiKey];
  return {
    identity: { provider: "anthropic", implementation: "appworks-anthropic@1", model: options.model },
    capabilities: { statefulSessions: false, cancellation: true, usage: true, local: false, model: true },
    async decide(request: AgentRequest, decide: DecideOptions = {}): Promise<AgentResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model: options.model,
            max_tokens: options.maxTokens ?? 2048,
            system: systemPrompt(request),
            messages: [{ role: "user", content: requestPrompt(request) }],
            tools: toolsFor(request).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema })),
            tool_choice: { type: "any", disable_parallel_tool_use: true }
          },
          { ...(decide.signal ? { signal: decide.signal } : {}), ...(decide.timeoutMs ? { timeout: decide.timeoutMs } : {}), maxRetries: 0 }
        );
      } catch (error) {
        throw normalize(error, secrets);
      }
      if (message.stop_reason === "refusal") throw new AgentError("refused", "the model refused to decide");
      const call = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!call) throw new AgentError("invalid-output", `the model answered without calling a tool (stop reason ${message.stop_reason})`);
      if (message.stop_reason === "max_tokens") throw new AgentError("invalid-output", "the model's tool call was cut off at the token limit");
      return { format: RESPONSE_FORMAT, decision: decisionFrom(request, call.name, call.input), usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }, providerRef: message.id };
    }
  };
}

function normalize(error: unknown, secrets: string[]): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new AgentError("cancelled", "the decision was cancelled");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AgentError("timeout", "the provider did not answer in time");
  if (error instanceof Anthropic.APIConnectionError) return new AgentError("transient", `could not reach the provider: ${(error as Error).message}`);
  if (error instanceof Anthropic.APIError) return fromStatus(error.status, error.message, error.headers, secrets);
  return new AgentError("unknown", (error as Error)?.message ?? String(error));
}
