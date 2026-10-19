import { loadFlow } from "./flow.js";

/**
 * The project workspace's domain: the workflow's stages, the transitions between them, the records FeltDB holds, and the
 * errors every boundary reports. Everything here is data; the rules that move a project are in `workflow.ts`.
 */

/**
 * The workflow, as `feltdb.flow` declares it (see `flow.ts`): the stages a project moves through, in order; the steps
 * that move it, each with the stages it starts from, the later stages it may be re-run from, the stage it reaches and the
 * evidence it fills; and the action classes an approval can authorize. None of it is restated here.
 */
export const MODEL = loadFlow();
export const STAGES: readonly string[] = MODEL.stages;
export type Stage = string;
export const STEPS = MODEL.steps;
export type StepName = string;
/**
 * The actions an approval can authorize, each enforced where the action happens, never by the page that asks for it.
 * A verified extraction or a valid fulfillment claim approves none of them.
 */
export const APPROVAL_ACTIONS: readonly string[] = MODEL.approvalActions;
export type ApprovalAction = string;

/** The current-evidence slots: the `evidence` names of the flow's steps. */
export type EvidenceSlot = string;

/** Who acted. The workspace never stores a credential; a principal is an identity, not a secret. */
export interface Principal {
  id: string;
  kind: "user" | "service";
}

/** A project's condition beside its stage. `partial` keeps going with visible gaps; `failed` and `cancelled` stop. */
export type ConditionState = "active" | "partial" | "failed" | "cancelled";
export interface Reason {
  code: string;
  message: string;
  stage?: Stage;
}

/** A secret named, never held: resolved in memory at the moment of use by the credential resolver. */
export interface CredentialReference {
  provider: "env";
  secretId: string;
}

export interface RepositoryIdentity {
  /** `github`: through @appport/github. `git`: a git remote or a local mirror of one (tests, offline). */
  provider: "github" | "git";
  owner: string;
  name: string;
  /** The canonical, credential-free URL: the identity assessments and extractions record. */
  url: string;
  /** `git` only: where the objects are fetched from, if not `url` (a local mirror). Never contains a credential. */
  fetchFrom?: string;
  defaultBranch?: string;
  /** References only. Reading and writing use separate credentials, and either may be absent (public read, no write). */
  credentials: { read?: CredentialReference; write?: CredentialReference };
}

export interface PinnedRevision {
  sha: string;
  ref: string;
  pinnedAt: string;
  /** Where the isolated checkout is, relative to the workspace home. */
  checkout: string;
  /** A content hash of the checkout (every path, mode, mtime and byte, .git included) taken when it was pinned. */
  treeDigest: string;
  /** Whether the pinned commit is the tip of the default branch when pinned; `no` and `unknown` are shown, never hidden. */
  onDefaultBranch: "yes" | "no" | "unknown";
  defaultBranchSha?: string;
}

export interface Project {
  id: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  repository: RepositoryIdentity;
  /** What was selected: a branch, tag or commit. The pinned SHA is what everything after pinning refers to. */
  ref: string;
  revision?: PinnedRevision;
  stage: Stage;
  condition: { state: ConditionState; reasons: Reason[] };
  /** The step that failed, when `condition.state` is `failed`: resume re-runs it. */
  failure?: { step: StepName; code: string; message: string; at: string; run: string };
  /** The current evidence: ids of records and artifacts in FeltDB. Replaced evidence stays in history. */
  current: Partial<Record<EvidenceSlot, string>>;
  /** The run holding the project, if a step is in progress. */
  activeRun?: string;
  /** How many stage events exist: the next one's sequence number. */
  history: number;
  __version?: number;
}

export interface StageEvent {
  id: string;
  projectId: string;
  sequence: number;
  step: StepName | "create" | "cancel" | "resume" | "fail" | "approve" | "action";
  from?: Stage;
  to: Stage;
  condition: ConditionState;
  at: string;
  actor: string;
  evidence: string[];
  reasons: Reason[];
  note?: string;
}

/** One attempt at one step: the workspace's durable run record, with a lease (see `docs/workspace.md`, Jobs). */
export interface Run {
  id: string;
  projectId: string;
  step: StepName | ApprovalAction;
  attempt: number;
  status: "running" | "succeeded" | "failed" | "abandoned" | "not-applied";
  owner: string;
  actor: string;
  startedAt: string;
  leaseExpiresAt: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  /** For a step with an external effect: what was done, so a resume never does it again. */
  effect?: Record<string, unknown>;
  __version?: number;
}

export type ArtifactKind = "integration" | "discovery" | "assessment" | "inventory" | "plan" | "extraction" | "verification-log" | "adoption" | "promotion" | "patch" | "promotion-verification" | "promotion-log";

/** A content-addressed file under the workspace home, referenced from FeltDB by digest. */
export interface ArtifactRecord {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  /** sha256 of the stored bytes: the file's address. */
  fileDigest: string;
  /** The artifact's own digest, when its format has one (assessment, extraction). */
  digest?: string;
  format?: string;
  path: string;
  bytes: number;
  revision: string;
  createdAt: string;
  run: string;
  partial: string[];
  summary: Record<string, unknown>;
}

/** Where one promotion is in its lifecycle. The promotion artifact it names never changes. */
export type PromotionState = "proposed" | "approved" | "applied" | "verified" | "verification-failed" | "ready-for-review" | "submitted-for-review";
export interface PromotionRecord {
  id: string;
  projectId: string;
  artifact: string;
  digest: string;
  state: PromotionState;
  /** The isolated promotion worktree, relative to the workspace home. Never the pinned checkout. */
  worktree: string;
  base: string;
  createdAt: string;
  updatedAt: string;
  approval?: string;
  appliedAt?: string;
  patch?: string;
  patchDigest?: string;
  files?: Array<{ path: string; sha256: string; mode: string }>;
  verification?: string;
  verificationStatus?: "verified" | "not-verified";
  reasons?: Reason[];
  commit?: string;
  branch?: string;
  __version?: number;
}

export interface ApprovalRecord {
  id: string;
  projectId: string;
  action: ApprovalAction;
  /** What exactly is approved: a digest over the action's inputs. A changed input is a different subject. */
  subject: string;
  subjectDescription: string;
  status: "requested" | "granted" | "consumed" | "revoked";
  requestedAt: string;
  requestedBy: string;
  grantedAt?: string;
  grantedBy?: string;
  consumedAt?: string;
  consumedBy?: string;
  __version?: number;
}

export interface VerificationRecord {
  id: string;
  projectId: string;
  at: string;
  extraction: string;
  extractionDigest: string;
  assessmentDigest: string;
  planDigest: string;
  treeDigest: string;
  revision: string;
  status: "verified" | "not-verified";
  integrity: { ok: boolean; findings: Array<{ code: string; path: string; message: string }> };
  behaviors: { required: number; passed: number; failed: number; inconclusive: number; notRun: number; againstReal: number; againstStub: number };
  records: Array<{ behavior: string; status: string; against?: string }>;
  checkoutUnchanged: boolean;
  reasons: Reason[];
}

/** Every refusal names its reason with a stable code. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** HTTP status for an error code: the web API and the CLI exit code are both derived from the code, never the message. */
export function statusOf(code: string): number {
  if (code === "UNAUTHORIZED") return 403;
  if (code === "NOT_FOUND" || code === "PROJECT_NOT_FOUND") return 404;
  if (code === "CONFLICT" || code === "STEP_IN_PROGRESS") return 409;
  if (code === "INVALID_INPUT") return 400;
  if (code === "UNSUPPORTED") return 501;
  return 422;
}

export const isStage = (value: unknown): value is Stage => typeof value === "string" && STAGES.includes(value);
export const stageIndex = (stage: Stage) => STAGES.indexOf(stage);
/** The stages after `stage`, in workflow order. */
export const stagesAfter = (stage: Stage) => STAGES.slice(STAGES.indexOf(stage) + 1);
