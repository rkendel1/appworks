/**
 * The action registry: everything an agent may ask AppWorks to do, and nothing else. Each action has a versioned id, a
 * JSON Schema for its arguments, the authority it needs, its side-effect class, the approval its boundary requires,
 * whether it is safe to repeat, a time bound, and the kind of information its result is.
 *
 * Workflow actions run through `Workspace.dispatch`, the same path the CLI and the web workspace use, so every step
 * keeps its own authority check, stage precondition, run claim, lease, evidence check and approval boundary. Read
 * actions read the pinned checkout or recorded evidence, bounded, refusing paths that hold credentials. There is no
 * shell, no arbitrary filesystem access, no network tool, and no action that grants or consumes an approval.
 */
import { lstatSync, openSync, readdirSync, readSync, closeSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { STEPS, WorkspaceError, type Principal, type Project } from "../model.js";
import type { ProjectView } from "../view.js";
import type { Workspace } from "../workflow.js";
import { redact, type ActionOutcome, type ActionSpec, type SideEffect } from "./contract.js";

export interface ActionContext {
  ws: Workspace;
  principal: Principal;
  project: Project;
  view: ProjectView;
  signal: AbortSignal;
  /** Called once a workflow step has claimed its run, before it finishes: the turn records the run id. */
  started(run: string): Promise<void>;
}

export interface ActionResult extends ActionOutcome {
  /** The approval the action's boundary requires and that is not granted for the current subject: the run pauses. */
  pause?: { approval: string; subject: string; description: string };
}

export interface ActionDefinition {
  id: string;
  description: string;
  sideEffect: SideEffect;
  /** The authority the action needs (checked by the workspace where the action happens). */
  authority: string;
  approval?: string;
  /** Safe to run again with the same arguments (reads). Workflow steps are never repeated by the orchestrator. */
  idempotent: boolean;
  /** Bound on a read action. A workflow step is bounded by the workspace's runner timeout and its lease. */
  timeoutMs?: number;
  /** What the result is: `workflow-record` results reference evidence the workflow recorded; reads are observations. */
  evidence: NonNullable<ActionOutcome["class"]>;
  /** The workflow step it starts, if any. */
  step?: string;
  input(view: ProjectView): Record<string, unknown>;
  eligible(view: ProjectView): boolean;
  execute(ctx: ActionContext, args: Record<string, unknown>): Promise<ActionResult>;
}

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };
const MAX_DATA = 12_000;
const MAX_LINES = 400;
const MAX_FILE = 1_000_000;
/** Paths that hold credentials or keys: never read, listed or searched, whatever the repository is. */
const SENSITIVE = /(^|\/)(\.git(\/|$)|\.env($|\.)|\.npmrc$|\.netrc$|\.pypirc$|\.dockercfg$|\.docker\/config\.json$|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|[^/]*\.(pem|key|p12|pfx|jks|keystore|kdbx)$|credentials(\.[a-z]+)?$|secrets?\.(json|ya?ml|toml)$)/i;

const bounded = (value: unknown, offset = 0): { text: string; truncated: boolean; total: number } => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { text: text.slice(offset, offset + MAX_DATA), truncated: offset + MAX_DATA < text.length, total: text.length };
};

const live = (view: ProjectView) => view.project.condition.state !== "cancelled" && !(view.project.activeRun && !view.project.activeRun.expired);
const pinned = (view: ProjectView) => Boolean(view.project.revision?.treeDigest);

// ---- workflow actions ------------------------------------------------------------------------------------------

const SIDE_EFFECT: Record<string, SideEffect> = {
  acquire: "external-read",
  discover: "external-read",
  "install-integration": "isolated-write",
  execute: "executes-target-code",
  verify: "executes-target-code",
  "apply-promotion": "isolated-write",
  "verify-promotion": "executes-target-code",
  commit: "local-commit"
};

const DESCRIPTION: Record<string, string> = {
  acquire: "Resolve the project's ref to one commit through its repository provider and fetch exactly that commit into an isolated checkout. Nothing runs.",
  pin: "Confirm the checkout's HEAD is the resolved commit and record its content hash.",
  inspect: "Look for an existing AppPort integration in the pinned files. Static; nothing runs.",
  "propose-integration": "Propose installing AppPort in a revision that has no AppPort integration: an AppPort application of its own in a new directory, publishing discovery. Nothing is written.",
  "install-integration": "Install the proposed AppPort integration in an isolated worktree of the pinned revision: write exactly the proposed files, install its pinned packages with lifecycle scripts disabled, start it on loopback and check it serves AppPort discovery. Needs the modify-integration approval of the proposal, granted by a person.",
  discover: "Ask a running instance of the application what it advertises, through AppPort's client. Without an endpoint, the ports the pinned source names are probed on loopback (an integration AppWorks installed is started for the discovery and stopped after it); if nothing answers, discovery is recorded as unavailable with every origin tried.",
  assess: "Statically assess the pinned revision: candidate capabilities, readiness, questions. Nothing runs.",
  reconcile: "Join discovered capabilities and assessed candidates into an inventory with graded evidence.",
  select: "Select one assessed candidate for extraction, with a rationale. Only candidates that have a reviewed extraction can be planned.",
  plan: "Validate the reviewed extraction plan for the selected candidate (no code is generated).",
  "request-approval": "Request the generate-files approval for exactly the current plan, revision and assessment. Does not approve anything.",
  execute: "Run the reviewed extraction against the isolated checkout. Needs the generate-files approval of the current subject, granted by a person.",
  verify: "Verify the extraction artifact against the assessment, the pinned checkout and the adapter sources.",
  ready: "Mark a verified, fresh extraction ready for promotion. Deploys nothing.",
  "propose-contract": "Propose adopting the verified contract into the target's integration, with every difference and open question.",
  "adopt-contract": "Adopt the proposed contract. Needs the adopt-contract approval of the proposal, granted by a person.",
  "propose-promotion": "Describe the integration change: which verified files are added where, and how they are verified.",
  "apply-promotion": "Apply the approved files to an isolated worktree of the pinned revision. Needs the modify-integration approval, granted by a person.",
  "verify-promotion": "Run the extraction's behavioral suite and mutation check against the promoted copy in the worktree.",
  "prepare-review": "Re-check every input of the verified change and mark it ready for review.",
  commit: "Commit exactly the reviewed patch on a local branch of the isolated worktree; nothing is pushed. Needs the commit approval, granted by a person.",
  resume: "Re-run the step that failed or was interrupted, as a new attempt with its original inputs. Completed steps are never repeated."
};

function stepInput(step: string, view: ProjectView): Record<string, unknown> {
  if (step === "discover") return { type: "object", properties: { endpoint: { type: "string", pattern: "^https?://[^\\s@/]+(:\\d+)?(/.*)?$", description: "origin of a running instance; omit when none is known (discovery is then recorded as unavailable)" } }, additionalProperties: false };
  if (step === "select") {
    const ids = (view.inventory?.candidates ?? []).map((c) => c.id);
    return { type: "object", properties: { candidate: { type: "string", ...(ids.length ? { enum: ids.slice(0, 200) } : {}), description: "an assessed candidate id" }, rationale: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["candidate", "rationale"], additionalProperties: false };
  }
  return NO_INPUT;
}

function workflowAction(step: string): ActionDefinition {
  const approval = step === "commit" ? "commit" : STEPS[step]?.approval;
  return {
    id: `workflow.${step}@1`,
    step,
    description: DESCRIPTION[step] ?? `Run the workflow step ${step}.`,
    sideEffect: SIDE_EFFECT[step] ?? "workspace-state",
    authority: "project.advance",
    ...(approval ? { approval } : {}),
    idempotent: false,
    evidence: "workflow-record",
    input: (view) => stepInput(step, view),
    eligible(view) {
      const p = view.project;
      if (p.condition.state === "cancelled") return false;
      if (step === "resume") return p.condition.state === "failed" || Boolean(p.activeRun?.expired);
      if (!live(view) || p.activeRun || p.condition.state === "failed") return false;
      if (step === "propose-integration" && view.integration?.status !== "absent") return false;
      if (step === "commit") return p.stage === "ready-for-review" && Boolean(view.integrationChange && !view.integrationChange.commit);
      const s = STEPS[step];
      return Boolean(s && [...s.from, ...s.rerun].includes(p.stage));
    },
    async execute(ctx, args) {
      const before = { ...ctx.project.current };
      const input = step === "select" ? { candidate: String(args.candidate), rationale: `agent-proposed: ${String(args.rationale)}` } : step === "discover" && typeof args.endpoint === "string" ? { endpoint: args.endpoint } : {};
      let started;
      try {
        started = step === "resume" ? await ctx.ws.resume(ctx.principal, ctx.project.id) : await ctx.ws.dispatch(ctx.principal, ctx.project.id, step, input);
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        if ((error.code === "APPROVAL_REQUIRED" || error.code === "APPROVAL_CONSUMED") && approval) {
          const subject = await ctx.ws.approvalSubject(ctx.principal, ctx.project.id, approval).catch(() => undefined);
          return { status: "paused", code: error.code, class: "none", summary: `refused at the approval boundary before anything ran: ${error.message}`, ...(subject ? { pause: { approval, subject: subject.subject, description: subject.description } } : {}) };
        }
        return { status: "refused", code: error.code, class: "none", summary: `refused before anything ran: ${error.message}` };
      }
      await ctx.started(started.run);
      try {
        const p = await started.done;
        const evidence = Object.entries(p.current).filter(([k, v]) => v && before[k] !== v).map(([, v]) => v as string);
        return { status: "succeeded", class: "workflow-record", summary: `${step} succeeded: the project is at ${p.stage} (${p.condition.state})`, evidence: [started.run, ...evidence], data: { stage: p.stage, condition: p.condition.state, reasons: p.condition.reasons.map((r) => ({ code: r.code, message: r.message.slice(0, 300) })) } };
      } catch (error) {
        const e = error instanceof WorkspaceError ? error : new WorkspaceError("STEP_FAILED", (error as Error)?.message ?? String(error));
        return { status: "failed", class: "workflow-record", code: e.code, summary: `${step} ran and failed: ${e.message}`, evidence: [started.run] };
      }
    }
  };
}

// ---- read actions ----------------------------------------------------------------------------------------------

/** Resolves a repository-relative path inside the pinned checkout, refusing escapes, links out of it and credentials. */
function checkoutPath(ctx: ActionContext, path: string): { root: string; absolute: string; relative: string } {
  if (!ctx.project.revision?.treeDigest) throw new WorkspaceError("REVISION_NOT_PINNED", "the project has no pinned checkout to read");
  const root = realpathSync(ctx.ws.store.resolve(ctx.project.revision.checkout));
  const rel = normalize(path || ".").replace(/^(\.\/)+/, "");
  if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`)) throw new WorkspaceError("PATH_REFUSED", "paths are relative to the repository root");
  const shown = rel === "." ? "" : rel.split(sep).join("/");
  if (shown && SENSITIVE.test(shown)) throw new WorkspaceError("PATH_REFUSED", `${shown} may hold credentials and is never read`);
  let absolute: string;
  try {
    absolute = realpathSync(join(root, rel));
  } catch {
    throw new WorkspaceError("PATH_NOT_FOUND", `${shown || "."} does not exist in the pinned checkout`);
  }
  if (absolute !== root && !absolute.startsWith(root + sep)) throw new WorkspaceError("PATH_REFUSED", `${shown} leads outside the pinned checkout`);
  return { root, absolute, relative: shown };
}

function readText(absolute: string): string | undefined {
  const size = statSync(absolute).size;
  if (size > MAX_FILE) return undefined;
  const buffer = Buffer.alloc(size);
  const fd = openSync(absolute, "r");
  try {
    readSync(fd, buffer, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
}

function* walk(root: string, start: string, limit: { files: number }): Generator<string> {
  const entries = readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (limit.files <= 0) return;
    const absolute = join(start, e.name);
    const rel = relative(root, absolute).split(sep).join("/");
    if (SENSITIVE.test(rel) || e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (["node_modules", ".git"].includes(e.name)) continue;
      yield* walk(root, absolute, limit);
    } else if (e.isFile()) {
      limit.files--;
      yield absolute;
    }
  }
}

const observation = (summary: string, data: unknown): ActionResult => ({ status: "succeeded", class: "source-observation", summary, data });

const READS: ActionDefinition[] = [
  {
    id: "source.list@1",
    description: "List one directory of the pinned checkout (names, kinds, sizes). Paths that may hold credentials are omitted.",
    sideEffect: "none",
    authority: "project.read",
    idempotent: true,
    timeoutMs: 10_000,
    evidence: "source-observation",
    input: () => ({ type: "object", properties: { path: { type: "string", maxLength: 500, description: "directory relative to the repository root; omit for the root" } }, additionalProperties: false }),
    eligible: pinned,
    async execute(ctx, args) {
      const at = checkoutPath(ctx, typeof args.path === "string" ? args.path : "");
      if (!lstatSync(at.absolute).isDirectory()) throw new WorkspaceError("INVALID_INPUT", `${at.relative} is not a directory`);
      const entries = readdirSync(at.absolute, { withFileTypes: true })
        .filter((e) => !SENSITIVE.test(at.relative ? `${at.relative}/${e.name}` : e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 500)
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "link" : "file", ...(e.isFile() ? { bytes: statSync(join(at.absolute, e.name)).size } : {}) }));
      return observation(`${entries.length} entries in ${at.relative || "/"} of the pinned checkout`, { path: at.relative || ".", entries });
    }
  },
  {
    id: "source.read@1",
    description: `Read lines of one text file of the pinned checkout (at most ${MAX_LINES} lines). Files that may hold credentials are refused, and anything that looks like a credential is redacted.`,
    sideEffect: "none",
    authority: "project.read",
    idempotent: true,
    timeoutMs: 10_000,
    evidence: "source-observation",
    input: () => ({ type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 500 }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: MAX_LINES } }, required: ["path"], additionalProperties: false }),
    eligible: pinned,
    async execute(ctx, args) {
      const at = checkoutPath(ctx, String(args.path));
      if (!lstatSync(at.absolute).isFile()) throw new WorkspaceError("INVALID_INPUT", `${at.relative} is not a file`);
      const text = readText(at.absolute);
      if (text === undefined) throw new WorkspaceError("UNREADABLE", `${at.relative} is binary or larger than ${MAX_FILE} bytes`);
      const lines = text.split("\n");
      const start = typeof args.startLine === "number" ? args.startLine : 1;
      const count = typeof args.lineCount === "number" ? args.lineCount : 200;
      const slice = redact(lines.slice(start - 1, start - 1 + count).join("\n")).slice(0, MAX_DATA);
      return observation(`${at.relative} lines ${start}-${Math.min(lines.length, start - 1 + count)} of ${lines.length}`, { path: at.relative, startLine: start, totalLines: lines.length, text: slice });
    }
  },
  {
    id: "source.search@1",
    description: "Find a literal text in the pinned checkout's text files (case-sensitive, at most 100 matches). Paths that may hold credentials are skipped.",
    sideEffect: "none",
    authority: "project.read",
    idempotent: true,
    timeoutMs: 20_000,
    evidence: "source-observation",
    input: () => ({ type: "object", properties: { text: { type: "string", minLength: 2, maxLength: 200 }, path: { type: "string", maxLength: 500, description: "directory to search under; omit for the whole repository" } }, required: ["text"], additionalProperties: false }),
    eligible: pinned,
    async execute(ctx, args) {
      const at = checkoutPath(ctx, typeof args.path === "string" ? args.path : "");
      const needle = String(args.text);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const limit = { files: 5_000 };
      for (const file of lstatSync(at.absolute).isDirectory() ? walk(at.root, at.absolute, limit) : [at.absolute]) {
        if (ctx.signal.aborted || matches.length >= 100) break;
        const text = readText(file);
        if (text === undefined || !text.includes(needle)) continue;
        const rel = relative(at.root, file).split(sep).join("/");
        text.split("\n").forEach((line, i) => {
          if (matches.length < 100 && line.includes(needle)) matches.push({ path: rel, line: i + 1, text: redact(line.trim()).slice(0, 240) });
        });
      }
      return observation(`${matches.length} matches of ${JSON.stringify(needle)}${matches.length >= 100 ? " (first 100)" : ""}`, { matches, filesScanned: 5_000 - limit.files });
    }
  },
  {
    id: "evidence.read@1",
    description: "Read recorded evidence of the project by its current-evidence slot (integration, discovery, assessment, inventory, plan, extraction, verification, adoption, promotionArtifact, patch, ...), in pages of 12000 characters.",
    sideEffect: "none",
    authority: "project.read",
    idempotent: true,
    timeoutMs: 10_000,
    evidence: "workspace-read",
    input: (view) => ({ type: "object", properties: { slot: { type: "string", enum: Object.keys(currentOf(view)).length ? Object.keys(currentOf(view)) : ["integration"] }, offset: { type: "integer", minimum: 0 } }, required: ["slot"], additionalProperties: false }),
    eligible: (view) => Object.keys(currentOf(view)).length > 0,
    async execute(ctx, args) {
      const id = ctx.project.current[String(args.slot)];
      if (!id) throw new WorkspaceError("EVIDENCE_MISSING", `the project has no current ${String(args.slot)}`);
      const artifact = await ctx.ws.artifact(ctx.principal, id);
      const body = artifact ? artifact.body : (await ctx.ws.records<Record<string, unknown>>(ctx.principal, String(args.slot) === "verification" ? "Verification" : "Decision", ctx.project.id)).find((r) => r.id === id);
      if (body === undefined) throw new WorkspaceError("EVIDENCE_MISSING", `${id} could not be read`);
      const page = bounded(body, typeof args.offset === "number" ? args.offset : 0);
      return { status: "succeeded", class: "workspace-read", summary: `${String(args.slot)} ${id}: ${page.text.length} of ${page.total} characters${page.truncated ? " (more: read again with a larger offset)" : ""}`, evidence: [id], data: { id, offset: args.offset ?? 0, total: page.total, text: redact(page.text) } };
    }
  },
  {
    id: "candidate.inspect@1",
    description: "Read one assessed candidate in full from the current assessment: its source, readiness, effect, exposure and the assessment's reasons.",
    sideEffect: "none",
    authority: "project.read",
    idempotent: true,
    timeoutMs: 10_000,
    evidence: "workspace-read",
    input: (view) => ({ type: "object", properties: { candidate: { type: "string", ...((view.inventory?.candidates.length ?? 0) ? { enum: view.inventory!.candidates.map((c) => c.id).slice(0, 200) } : {}) } }, required: ["candidate"], additionalProperties: false }),
    eligible: (view) => Boolean(view.assessment && view.assessment.candidates > 0),
    async execute(ctx, args) {
      const artifact = await ctx.ws.artifact<{ candidates: Array<{ id: string }> }>(ctx.principal, ctx.project.current.assessment);
      const candidate = artifact?.body.candidates.find((c) => c.id === args.candidate);
      if (!candidate) throw new WorkspaceError("CANDIDATE_NOT_FOUND", `${String(args.candidate)} is not in the current assessment`);
      const page = bounded(candidate);
      return { status: "succeeded", class: "workspace-read", summary: `candidate ${String(args.candidate)}${page.truncated ? " (truncated)" : ""}`, evidence: [artifact!.record.id], data: JSON.parse(JSON.stringify({ text: redact(page.text) })) };
    }
  }
];

function currentOf(view: ProjectView): Record<string, string> {
  const slots: Record<string, string | undefined> = {
    integration: view.integration?.artifact,
    discovery: view.discovery?.artifact,
    assessment: view.assessment?.artifact,
    inventory: view.inventory?.artifact,
    plan: view.plan?.artifact,
    extraction: view.extraction?.artifact,
    verification: view.verification?.id,
    adoption: view.adoption?.artifact,
    promotionArtifact: view.integrationChange?.artifact,
    patch: view.integrationChange?.patch?.artifact
  };
  return Object.fromEntries(Object.entries(slots).filter(([, v]) => v)) as Record<string, string>;
}

/** Every action AppWorks offers agents: the flow's steps (except creating and submitting), commit, resume, and the reads. */
export const ACTION_REGISTRY: readonly ActionDefinition[] = [
  ...Object.keys(STEPS)
    .filter((s) => s !== "create" && s !== "submit-review")
    .map(workflowAction),
  workflowAction("commit"),
  workflowAction("resume"),
  ...READS
];

export function actionById(id: string): ActionDefinition | undefined {
  return ACTION_REGISTRY.find((a) => a.id === id);
}

/** The actions an agent may request now, given the project's recorded state, as the contract presents them. */
export function eligibleActions(view: ProjectView): { definitions: ActionDefinition[]; specs: ActionSpec[] } {
  const definitions = ACTION_REGISTRY.filter((a) => a.eligible(view));
  return { definitions, specs: definitions.map((a) => ({ id: a.id, description: a.description, input: a.input(view), sideEffect: a.sideEffect, ...(a.approval ? { approval: a.approval } : {}) })) };
}
