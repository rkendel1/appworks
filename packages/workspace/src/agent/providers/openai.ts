/**
 * The OpenAI adapter: one Responses API call per decision, the request as one user input, one function tool per
 * offered action and a required tool choice. Stateless (`store: false`); no SDK retries. The key, organization and
 * project are passed in by configuration and never read from the environment by the SDK.
 */
import OpenAI from "openai";
import { AgentError, RESPONSE_FORMAT, type AgentAdapter, type AgentRequest, type AgentResponse, type DecideOptions } from "../contract.js";
import { decisionFrom, fromStatus, requestPrompt, systemPrompt, toolsFor } from "./shared.js";

export interface OpenAIAgentOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  /** Tests: the HTTP layer. */
  fetch?: typeof globalThis.fetch;
}

export function openaiAgent(options: OpenAIAgentOptions): AgentAdapter {
  const client = new OpenAI({ apiKey: options.apiKey, organization: null, project: null, webhookSecret: null, baseURL: options.baseURL ?? "https://api.openai.com/v1", maxRetries: 0, logLevel: "off", ...(options.fetch ? { fetch: options.fetch } : {}) });
  const secrets = [options.apiKey];
  return {
    identity: { provider: "openai", implementation: "appworks-openai@1", model: options.model },
    capabilities: { statefulSessions: false, cancellation: true, usage: true, local: false, model: true },
    async decide(request: AgentRequest, decide: DecideOptions = {}): Promise<AgentResponse> {
      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(
          {
            model: options.model,
            instructions: systemPrompt(request),
            input: [{ role: "user", content: requestPrompt(request) }],
            tools: toolsFor(request).map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.schema, strict: false })),
            tool_choice: "required",
            parallel_tool_calls: false,
            store: false,
            max_output_tokens: options.maxTokens ?? 2048
          },
          { ...(decide.signal ? { signal: decide.signal } : {}), ...(decide.timeoutMs ? { timeout: decide.timeoutMs } : {}), maxRetries: 0 }
        );
      } catch (error) {
        throw normalize(error, secrets);
      }
      const refusal = response.output.flatMap((o) => (o.type === "message" ? o.content : [])).find((c) => c.type === "refusal");
      if (refusal) throw new AgentError("refused", "the model refused to decide");
      const call = response.output.find((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
      if (!call) throw new AgentError("invalid-output", `the model answered without calling a tool (status ${response.status})`);
      if (response.status === "incomplete") throw new AgentError("invalid-output", `the model's tool call is incomplete (${response.incomplete_details?.reason ?? "unknown"})`);
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        throw new AgentError("invalid-output", "the model's tool arguments are not JSON");
      }
      return { format: RESPONSE_FORMAT, decision: decisionFrom(request, call.name, input), ...(response.usage ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } } : {}), providerRef: response.id };
    }
  };
}

function normalize(error: unknown, secrets: string[]): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return new AgentError("cancelled", "the decision was cancelled");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new AgentError("timeout", "the provider did not answer in time");
  if (error instanceof OpenAI.APIConnectionError) return new AgentError("transient", `could not reach the provider: ${(error as Error).message}`);
  if (error instanceof OpenAI.APIError) return fromStatus(error.status, error.message, error.headers, secrets);
  return new AgentError("unknown", (error as Error)?.message ?? String(error));
}
