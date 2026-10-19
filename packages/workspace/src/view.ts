/**
 * The project view: everything the web workspace shows and `appworks project show --json` prints, read from FeltDB
 * through the workflow's own reads. The page and the CLI render this one object; neither derives state of its own.
 *
 * The advisor (`next`) explains and recommends from the same state. It is deterministic, needs no model, and decides
 * nothing: every action it lists is still checked by the workflow, the authority and, where required, an approval.
 */
import type { ApplicationAssessment } from "@appport/assessment";
import type { CapabilityExtraction } from "@appport/extraction";
import type { DiscoveryRecord } from "./discovery.js";
import type { IntegrationRecord } from "./inspect.js";
import { MODEL, STAGES, stageIndex, type ApprovalRecord, type ArtifactRecord, type Principal, type Project, type Run, type StageEvent, type VerificationRecord } from "./model.js";
import type { InventoryRecord } from "./reconcile.js";
import type { Workspace } from "./workflow.js";

export type Tone = "positive" | "progress" | "attention" | "critical" | "neutral" | "unknown";
export interface Status {
  tone: Tone;
  label: string;
  detail?: string;
}

export interface NextAction {
  action: string;
  label: string;
  reason: string;
  /** Inputs the action takes. */
  inputs?: Array<{ name: string; label: string; required: boolean; hint?: string; value?: string }>;
  /** The approval its boundary will require, if any. */
  approval?: string;
}

export interface ProjectView {
  format: "appworks.project-view/1";
  flow: { app: string; workflow: string; stages: string[] };
  project: {
    id: string;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    repository: { provider: string; owner: string; name: string; url: string; defaultBranch?: string; readCredential?: string; writeCredential?: string };
    ref: string;
    revision?: Project["revision"];
    stage: string;
    stageIndex: number;
    condition: Project["condition"];
    failure?: Project["failure"];
    activeRun?: { id: string; step: string; owner: string; status: string; leaseExpiresAt: string; expired: boolean };
  };
  status: Status;
  stages: Array<{ stage: string; state: "done" | "current" | "pending" | "failed" }>;
  acquisition: Status & { sha?: string; checkout?: string; treeDigest?: string };
  revisionNotice?: string;
  integration?: { status: IntegrationRecord["status"]; integrations: IntegrationRecord["integrations"]; evidence: IntegrationRecord["evidence"]; note: string; artifact: string };
  discovery?: { outcome: DiscoveryRecord["outcome"]; endpoint?: string; at: string; state?: string; reasons: string[]; application?: DiscoveryRecord["application"]; capabilities: DiscoveryRecord["capabilities"]; established: DiscoveryRecord["established"]; note: string; artifact: string };
  assessment?: { digest: string; artifact: string; fileDigest: string; partial: string[]; coverage: { filesSeen: number; filesAnalyzed: number }; candidates: number; recommendation?: string; questions: number };
  inventory?: InventoryRecord & { artifact: string };
  selection?: { candidate: string; name: string; rationale: string; by: string; at: string };
  plan?: { artifact: string; digest: string; extraction: string; identity: string; behaviors: number; planDirectory: string };
  approvals: Array<Pick<ApprovalRecord, "id" | "action" | "subject" | "subjectDescription" | "status" | "requestedAt" | "requestedBy" | "grantedAt" | "grantedBy" | "consumedAt" | "consumedBy">>;
  extraction?: { artifact: string; digest: string; format: string; identity: string; previous?: string; source: string; contract: string; fulfillment?: string; summary: CapabilityExtraction["verification"]["summary"]; questions: Array<{ id: string; question: string }>; log?: string };
  verification?: VerificationRecord & { fresh: boolean; staleReasons: string[] };
  promotion?: { status: string; deployed: boolean; note: string; at: string };
  runs: Array<Pick<Run, "id" | "step" | "attempt" | "status" | "owner" | "actor" | "startedAt" | "finishedAt" | "error">>;
  history: Array<Pick<StageEvent, "sequence" | "step" | "from" | "to" | "condition" | "at" | "actor" | "note" | "reasons">>;
  next: { summary: string; actions: NextAction[]; note: string };
}

const credentialName = (r?: { provider: string; secretId: string }) => (r ? `${r.provider}:${r.secretId}` : undefined);

export async function projectView(ws: Workspace, principal: Principal, id: string): Promise<ProjectView> {
  const p = await ws.project(principal, id);
  const [runs, events, approvals] = await Promise.all([ws.records<Run>(principal, "Run", id), ws.records<StageEvent>(principal, "StageEvent", id), ws.records<ApprovalRecord>(principal, "Approval", id)]);
  const now = new Date().toISOString();
  const active = p.activeRun ? runs.find((r) => r.id === p.activeRun) : undefined;
  const index = stageIndex(p.stage);
  const failed = p.condition.state === "failed";
  const view: ProjectView = {
    format: "appworks.project-view/1",
    flow: { app: MODEL.spec.app, workflow: "transformation", stages: [...STAGES] },
    project: {
      id: p.id,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      updatedAt: p.updatedAt,
      repository: {
        provider: p.repository.provider,
        owner: p.repository.owner,
        name: p.repository.name,
        url: p.repository.url,
        ...(p.repository.defaultBranch ? { defaultBranch: p.repository.defaultBranch } : {}),
        ...(credentialName(p.repository.credentials.read) ? { readCredential: credentialName(p.repository.credentials.read)! } : {}),
        ...(credentialName(p.repository.credentials.write) ? { writeCredential: credentialName(p.repository.credentials.write)! } : {})
      },
      ref: p.ref,
      ...(p.revision ? { revision: p.revision } : {}),
      stage: p.stage,
      stageIndex: index,
      condition: p.condition,
      ...(p.failure ? { failure: p.failure } : {}),
      ...(active ? { activeRun: { id: active.id, step: active.step, owner: active.owner, status: active.status, leaseExpiresAt: active.leaseExpiresAt, expired: active.status === "running" && active.leaseExpiresAt <= now } } : {})
    },
    status:
      p.condition.state === "cancelled"
        ? { tone: "neutral", label: "Cancelled" }
        : failed
          ? { tone: "critical", label: "Failed", detail: `${p.failure?.step}: ${p.failure?.code}` }
          : active
            ? { tone: "progress", label: `Running ${active.step}` }
            : p.condition.state === "partial"
              ? { tone: "attention", label: "Partial", detail: p.condition.reasons.map((r) => r.code).join(", ") }
              : { tone: p.stage === STAGES[STAGES.length - 1] ? "positive" : "neutral", label: p.stage === STAGES[STAGES.length - 1] ? "Ready for promotion" : "Active" },
    stages: STAGES.map((stage, i) => ({ stage, state: i < index ? "done" : i === index ? (failed ? "failed" : "current") : "pending" })),
    acquisition: p.revision?.treeDigest
      ? { tone: "positive", label: "Pinned", detail: p.revision.sha, sha: p.revision.sha, checkout: p.revision.checkout, treeDigest: p.revision.treeDigest }
      : p.revision
        ? { tone: "progress", label: "Acquired, not pinned", sha: p.revision.sha, checkout: p.revision.checkout }
        : { tone: "neutral", label: "Not acquired" },
    approvals: approvals.map(({ id: aid, action, subject, subjectDescription, status, requestedAt, requestedBy, grantedAt, grantedBy, consumedAt, consumedBy }) => ({ id: aid, action, subject, subjectDescription, status, requestedAt, requestedBy, ...(grantedAt ? { grantedAt } : {}), ...(grantedBy ? { grantedBy } : {}), ...(consumedAt ? { consumedAt } : {}), ...(consumedBy ? { consumedBy } : {}) })),
    runs: runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map(({ id: rid, step, attempt, status, owner, actor, startedAt, finishedAt, error }) => ({ id: rid, step, attempt, status, owner, actor, startedAt, ...(finishedAt ? { finishedAt } : {}), ...(error ? { error } : {}) })),
    history: events.sort((a, b) => a.sequence - b.sequence).map(({ sequence, step, from, to, condition, at, actor, note, reasons }) => ({ sequence, step, ...(from ? { from } : {}), to, condition, at, actor, ...(note ? { note } : {}), reasons })),
    next: { summary: "", actions: [], note: "" }
  };
  const notice = p.condition.reasons.find((r) => r.code === "REVISION_NOT_ON_DEFAULT_BRANCH");
  if (notice) view.revisionNotice = notice.message;

  const integration = await ws.artifact<IntegrationRecord>(principal, p.current.integration);
  if (integration) view.integration = { status: integration.body.status, integrations: integration.body.integrations, evidence: integration.body.evidence, note: integration.body.note, artifact: integration.record.id };
  const discovery = await ws.artifact<DiscoveryRecord>(principal, p.current.discovery);
  if (discovery) {
    const d = discovery.body;
    view.discovery = { outcome: d.outcome, ...(d.endpoint ? { endpoint: d.endpoint } : {}), at: d.at, ...(d.state ? { state: d.state } : {}), reasons: d.reasons, ...(d.application ? { application: d.application } : {}), capabilities: d.capabilities, established: d.established, note: d.note, artifact: discovery.record.id };
  }
  const assessment = await ws.artifact<ApplicationAssessment>(principal, p.current.assessment);
  if (assessment) {
    const a = assessment.body;
    view.assessment = { digest: a.digest, artifact: assessment.record.id, fileDigest: assessment.record.fileDigest, partial: a.coverage.partial ? a.coverage.partialReasons : [], coverage: { filesSeen: a.coverage.filesSeen, filesAnalyzed: a.coverage.filesAnalyzed }, candidates: a.candidates.length, ...(a.recommendation?.candidate ? { recommendation: a.recommendation.candidate } : {}), questions: a.questions.length };
  }
  const inventory = await ws.artifact<InventoryRecord>(principal, p.current.inventory);
  if (inventory) view.inventory = { ...inventory.body, artifact: inventory.record.id };
  const decisions = await ws.records<Record<string, unknown> & { id: string }>(principal, "Decision", id);
  const selection = decisions.find((d) => d.id === p.current.selection);
  if (selection) view.selection = { candidate: String(selection.candidate), name: String(selection.name), rationale: String(selection.rationale ?? ""), by: String(selection.by), at: String(selection.at) };
  const plan = await ws.artifact<CapabilityExtraction>(principal, p.current.plan);
  if (plan) view.plan = { artifact: plan.record.id, digest: plan.body.digest, extraction: String(plan.record.summary.extraction), identity: String(plan.record.summary.identity), behaviors: plan.body.verification.records.length, planDirectory: String(plan.record.summary.planDirectory) };
  const extraction = await ws.artifact<CapabilityExtraction>(principal, p.current.extraction);
  if (extraction) {
    const x = extraction.body;
    view.extraction = {
      artifact: extraction.record.id,
      digest: x.digest,
      format: x.format,
      identity: `${x.identity.name} revision ${x.identity.revision}`,
      ...(x.identity.previous ? { previous: x.identity.previous } : {}),
      source: `${x.source.name} ${x.source.operation.fullMethod} at ${x.source.revision}`,
      contract: `${x.contract.capability.contract} ${x.contract.capability.name}@${x.contract.capability.version}`,
      ...(x.fulfillment ? { fulfillment: `${x.fulfillment.provider.application} ${x.fulfillment.provider.capability}@${x.fulfillment.provider.version} (declaration ${x.fulfillment.digest})` } : {}),
      summary: x.verification.summary,
      questions: x.questions.map((q) => ({ id: q.id, question: q.question })),
      ...(extraction.record.summary.log ? { log: String(extraction.record.summary.log) } : {})
    };
  }
  const verification = p.current.verification ? (await ws.records<VerificationRecord>(principal, "Verification", id)).find((v) => v.id === p.current.verification) : undefined;
  if (verification) {
    const stale = await ws.verificationFreshness(principal, id);
    view.verification = { ...verification, fresh: stale.length === 0, staleReasons: stale };
  }
  const promotion = decisions.find((d) => d.id === p.current.promotion);
  if (promotion) view.promotion = { status: String(promotion.status), deployed: promotion.deployed === true, note: String(promotion.note ?? ""), at: String(promotion.at) };
  view.next = advise(view);
  return view;
}

/** Explains the project's state and lists what can be done next. Advisory only. */
export function advise(v: ProjectView): ProjectView["next"] {
  const actions: NextAction[] = [];
  const p = v.project;
  const note = "Advisory: computed from the recorded state by fixed rules. It decides nothing; every action is checked by the workflow, the authority and, where shown, an explicit approval.";
  if (p.condition.state === "cancelled") return { summary: "The project is cancelled. Its history and evidence are kept; nothing further runs.", actions, note };
  if (p.activeRun) {
    if (p.activeRun.expired) actions.push({ action: "resume", label: "Resume", reason: `${p.activeRun.step} stopped renewing its lease (its worker is gone); resuming runs it again as a new attempt` });
    return { summary: p.activeRun.expired ? `${p.activeRun.step} was interrupted.` : `${p.activeRun.step} is running (${p.activeRun.id}).`, actions, note };
  }
  if (p.condition.state === "failed") {
    actions.push({ action: "resume", label: `Retry ${p.failure?.step}`, reason: `${p.failure?.step} failed with ${p.failure?.code}: ${p.failure?.message}. Resuming re-runs that step only.` });
    actions.push({ action: "cancel", label: "Cancel project", reason: "stop here and keep the record", inputs: [{ name: "reason", label: "Reason", required: false }] });
    return { summary: `${p.failure?.step} failed: ${p.failure?.message}`, actions, note };
  }
  const add = (action: string, label: string, reason: string, extra: Partial<NextAction> = {}) => actions.push({ action, label, reason, ...extra });
  switch (p.stage) {
    case "project-selected":
      add("acquire", "Acquire revision", `resolve ${p.ref} to a commit and fetch exactly that commit into an isolated checkout`);
      break;
    case "repository-acquired":
      add("pin", "Pin revision", "confirm HEAD is the resolved commit and record the checkout's content hash");
      break;
    case "revision-pinned":
      add("inspect", "Inspect integration", "look for an existing AppPort integration in the pinned files (static: nothing runs)");
      break;
    case "integration-inspected":
      add("discover", "Discover capabilities", v.integration?.status === "present" ? "ask a running instance what it advertises, through AppPort's client. Without an endpoint, discovery is recorded as unavailable" : "no integration was found; discovery records that explicitly", { inputs: [{ name: "endpoint", label: "Application origin", required: false, hint: "for example http://127.0.0.1:4000. No credential is sent." }] });
      break;
    case "capabilities-discovered":
      add("assess", "Assess revision", "static assessment of the same pinned revision");
      add("discover", "Discover again", "with another endpoint", { inputs: [{ name: "endpoint", label: "Application origin", required: false }] });
      break;
    case "assessment-completed":
      add("reconcile", "Reconcile inventory", "match discovered capabilities with assessed candidates, with graded evidence");
      break;
    case "inventory-reconciled":
    case "candidate-selected": {
      const extractable = v.inventory?.candidates.filter((c) => c.readiness === "exposure-candidate") ?? [];
      add("select", p.stage === "candidate-selected" ? "Select another candidate" : "Select candidate", `${extractable.length} candidates are classified exposure-candidate`, { inputs: [{ name: "candidate", label: "Candidate id", required: true, ...(v.assessment?.recommendation ? { value: v.assessment.recommendation } : {}) }, { name: "rationale", label: "Rationale", required: false }] });
      if (p.stage === "candidate-selected") add("plan", "Validate extraction plan", "validate the reviewed plan for the selected candidate with the extraction library (no code is generated)");
      break;
    }
    case "extraction-planned":
      add("request-approval", "Request approval", "ask for the generate-files approval of exactly this plan, revision and assessment");
      break;
    case "awaiting-approval": {
      const pending = v.approvals.find((a) => a.action === "generate-files" && a.status !== "consumed");
      if (pending?.status === "granted") add("execute", "Execute extraction", "the approval is granted for the current subject; this runs the reviewed extraction against the isolated checkout", { approval: "generate-files" });
      else add("approve", "Approve generating files", pending?.subjectDescription ?? "approve the extraction run", { approval: "generate-files", inputs: [{ name: "action", label: "Action", required: true, value: "generate-files" }, { name: "subject", label: "Subject", required: true, ...(pending ? { value: pending.subject } : {}) }] });
      add("plan", "Re-validate plan", "if the plan changed, validate it again (the approval request follows the new subject)");
      break;
    }
    case "extraction-executed":
      add("verify", "Verify extraction", "verify the artifact against the assessment, the pinned checkout and the adapter sources");
      break;
    case "verification-completed":
      if (v.verification?.status === "verified" && v.verification.fresh) add("ready", "Mark ready for promotion", "verified and still fresh. This deploys nothing and approves nothing for production");
      else add("verify", "Verify again", v.verification ? `not verified: ${[...v.verification.reasons.map((r) => r.code), ...v.verification.staleReasons].join(", ")}` : "verify");
      break;
    case "ready-for-promotion":
      add("verify", "Re-verify", "check the verification still holds");
      break;
  }
  if (p.stage !== "ready-for-promotion") add("cancel", "Cancel project", "stop and keep the record", { inputs: [{ name: "reason", label: "Reason", required: false }] });
  const summary =
    p.stage === "ready-for-promotion"
      ? "Verified for exactly this revision, contract, adapter, declaration and runtime. Promotion needs its own approval; no deployment contract exists here."
      : `At ${p.stage}${p.condition.state === "partial" ? `, with gaps: ${p.condition.reasons.map((r) => r.code).join(", ")}` : ""}.`;
  return { summary, actions, note };
}
