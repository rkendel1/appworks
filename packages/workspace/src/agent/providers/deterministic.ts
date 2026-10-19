/**
 * The deterministic agent: no model, no network. It follows the workspace's own advisor (`advise()`, carried in the
 * request's context) through the same contract a model-backed agent uses, so the orchestrator, the action registry and
 * the approval boundary are exercised offline and in CI. It never retries a failed or refused action: it finishes
 * blocked with that result as the blocker.
 */
import { RESPONSE_FORMAT, type AgentAdapter, type AgentDecision, type AgentRequest, type AgentResponse } from "../contract.js";

/** An advisor `approve` of an approval class → the step whose boundary needs it. */
const GATED: Record<string, string> = { "generate-files": "execute", "adopt-contract": "adopt-contract", "modify-integration": "apply-promotion", commit: "commit" };

interface Advised {
  action: string;
  reason: string;
  approval?: string;
  values?: Record<string, string>;
}

export function deterministicAgent(): AgentAdapter {
  return {
    identity: { provider: "deterministic", implementation: "appworks-deterministic@1" },
    capabilities: { statefulSessions: false, cancellation: true, usage: false, local: true, model: false },
    async decide(request: AgentRequest): Promise<AgentResponse> {
      return { format: RESPONSE_FORMAT, decision: decideFor(request) };
    }
  };
}

function decideFor(request: AgentRequest): AgentDecision {
  const context = request.context as { project?: { stage?: string; reasons?: Array<{ code: string; message: string }> }; advisor?: { summary?: string; actions?: Advised[] }; reviewedExtractions?: Array<{ candidate: string; inThisAssessment: boolean }>; integrationChange?: { commit?: string } };
  const last = request.history.at(-1);
  if (last?.decision?.kind === "action" && (last.result.status === "failed" || last.result.status === "refused"))
    return { kind: "finish", outcome: "blocked", rationale: `${last.decision.action} ${last.result.status}; the deterministic agent does not retry`, blockers: [`${last.result.code ?? last.result.status}: ${last.result.summary}`] };
  const lastSucceeded = last?.decision?.kind === "action" && last.result.status === "succeeded" ? last.decision.action : undefined;
  const offered = new Set(request.actions.map((a) => a.id));
  const unmet: string[] = [];
  for (const advised of context.advisor?.actions ?? []) {
    if (advised.action === "cancel") continue;
    const step = advised.action === "approve" ? (advised.approval ? GATED[advised.approval] : undefined) : advised.action;
    if (!step) continue;
    const id = `workflow.${step}@1`;
    if (!offered.has(id) || id === lastSucceeded) continue;
    if (step === "select") {
      const reviewed = context.reviewedExtractions?.find((e) => e.inThisAssessment)?.candidate;
      const candidate = reviewed ?? advised.values?.candidate;
      if (!candidate) {
        unmet.push(`NO_CANDIDATE: nothing to select (${advised.reason})`);
        continue;
      }
      return { kind: "action", action: id, arguments: { candidate, rationale: reviewed ? "the candidate with a reviewed extraction in this assessment" : "the assessment's recommendation" }, rationale: `select ${candidate}: ${advised.reason}` };
    }
    return { kind: "action", action: id, arguments: {}, rationale: advised.reason };
  }
  const stage = context.project?.stage ?? "";
  if (stage === "ready-for-review" && context.integrationChange?.commit)
    return { kind: "finish", outcome: "done", rationale: "the verified change is committed locally; submitting it needs a push, which has no supported contract here" };
  const reasons = (context.project?.reasons ?? []).map((r) => `${r.code}: ${r.message}`);
  return { kind: "finish", outcome: "blocked", rationale: `no advised action is available at ${stage}: ${context.advisor?.summary ?? ""}`, blockers: [...unmet, ...reasons].length ? [...unmet, ...reasons] : [context.advisor?.summary ?? `nothing further at ${stage}`] };
}
