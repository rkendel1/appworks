/**
 * The scripted fake agent, for tests: it answers each decision with the next scripted step (a decision, a whole
 * response, an `AgentError` to throw, or a function of the request) and records every request it was given. A step
 * may be delayed; the delay honors cancellation. When the script runs out it finishes.
 */
import { AgentError, RESPONSE_FORMAT, type AgentAdapter, type AgentDecision, type AgentIdentity, type AgentRequest, type AgentResponse, type DecideOptions } from "../contract.js";

export type ScriptStep = AgentDecision | AgentResponse | AgentError | unknown | ((request: AgentRequest) => AgentDecision | AgentResponse | Promise<AgentDecision | AgentResponse>);

export interface ScriptedAgent extends AgentAdapter {
  readonly requests: AgentRequest[];
}

export function scriptedAgent(script: ScriptStep[], options: { identity?: Partial<AgentIdentity>; delayMs?: number; ignoreSignal?: boolean } = {}): ScriptedAgent {
  const steps = [...script];
  const requests: AgentRequest[] = [];
  return {
    identity: { provider: "fake", implementation: "appworks-fake@1", model: "scripted", ...options.identity },
    capabilities: { statefulSessions: false, cancellation: !options.ignoreSignal, usage: true, local: true, model: false },
    requests,
    async decide(request: AgentRequest, decide: DecideOptions = {}): Promise<AgentResponse> {
      requests.push(structuredClone(request));
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, options.delayMs);
          if (!options.ignoreSignal)
            decide.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new AgentError("cancelled", "the decision was cancelled"));
            }, { once: true });
        });
      }
      const step = steps.shift();
      if (step === undefined) return { format: RESPONSE_FORMAT, decision: { kind: "finish", outcome: "done", rationale: "the script is exhausted" } };
      if (step instanceof AgentError) throw step;
      const value = typeof step === "function" ? await (step as (r: AgentRequest) => unknown)(request) : step;
      const v = value as Record<string, unknown>;
      if (v && typeof v === "object" && "kind" in v && !("format" in v)) return { format: RESPONSE_FORMAT, decision: v as AgentDecision, usage: { inputTokens: 10, outputTokens: 5 } };
      return value as AgentResponse;
    }
  };
}
