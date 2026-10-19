/**
 * The transformation workflow. One implementation, used by the web workspace and the CLI alike (`actions.ts`).
 *
 * Every step follows the same protocol, against FeltDB:
 *   1. authority: the principal may advance the project;
 *   2. precondition: the project is at a stage the step starts from, not cancelled, not failed (resume re-runs a failed
 *      step), its pinned checkout is still the pinned revision, and the evidence the step needs is current;
 *   3. claim: one transaction fenced on the project's version marks a new run as the project's active run. A second
 *      claim, from this process or another, conflicts and is refused. A run whose lease expired (its worker died) is
 *      marked abandoned by the next claim;
 *   4. work, outside any transaction, renewing the lease while it runs;
 *   5. apply: one transaction moves the project to its next stage, records the stage event, the new evidence records and
 *      the run's outcome. A failure records the failure the same way. Nothing is applied twice.
 * A job record never decides anything: the project record and its evidence do.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRepository, gitIdentity, verifyAssessment, type ApplicationAssessment } from "@appport/assessment";
import { createExtraction, ExtractionRefused, observeCheckout, readPlan, verifyExtractionAt, type CapabilityExtraction } from "@appport/extraction";
import { digestOf, type AppPortManifest } from "@appport/protocol";
import { requireAllowed, parseCredentialReference, type Authority, type CredentialResolver } from "./authority.js";
import { discoverCapabilities, type DiscoveryRecord } from "./discovery.js";
import { endpointCandidates } from "./endpoints.js";
import { inspectIntegration, treeHash, type IntegrationRecord } from "./inspect.js";
import { APPROVAL_ACTIONS, MODEL, STAGES, STEPS, stagesAfter, WorkspaceError, type ApprovalAction, type ApprovalRecord, type ArtifactKind, type ArtifactRecord, type Principal, type Project, type PromotionRecord, type Reason, type RepositoryIdentity, type Run, type Stage, type StageEvent, type StepName, type VerificationRecord } from "./model.js";
import { adoptionProblems, proposeAdoption, type ContractAdoption } from "./adoption.js";
import { buildPromotion, patchDigest, promotionProblems, readPromotionPlan, worktreeFileDigests, writePromotionFiles, type Promotion } from "./promotion.js";
import { reconcile, type ExtractionBinding, type InventoryRecord, type MatchDecision } from "./reconcile.js";
import { acquireCheckout, commitInfo, commitWorktree, createPromotionWorktree, worktreePatch, worktreeState, type RepositoryProvider } from "./repository.js";
import { directoryDigest, listExtractions, runExtraction, runPromotionVerification, type ExtractionEntry } from "./runner.js";
import { sha256, Store, type Write } from "./store.js";

export interface WorkspaceOptions {
  /** The workspace home: FeltDB state, artifact bodies and isolated checkouts. */
  home: string;
  authority: Authority;
  credentials: CredentialResolver;
  providers: Partial<Record<RepositoryIdentity["provider"], RepositoryProvider>>;
  /** Reviewed extraction directories (`extractions/` of AppWorks). */
  extractionsRoot?: string;
  now?: () => Date;
  /** This worker's identity in run leases. */
  worker?: string;
  leaseMs?: number;
  /** Discovery's fetch (tests). */
  fetch?: typeof globalThis.fetch;
  /** Origins to try first when discovering without an endpoint (APPWORKS_DISCOVERY_ORIGINS). */
  discoveryOrigins?: string[];
  runnerTimeoutMs?: number;
  /** Tests only: called at named points of a step; throwing `SimulatedCrash` stops the run as if the process died. */
  faultPoint?: (name: string, context: { project: string; worktree?: string }) => void;
}

/** Thrown by a test's fault point: the run stops without recording anything, as if its process had been killed. */
export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

/** A step that has been claimed: its run id, and the promise of its result. */
export interface Started {
  run: string;
  done: Promise<Project>;
}

interface Outcome {
  writes?: Write[];
  current?: Project["current"];
  revision?: Project["revision"];
  repository?: Partial<RepositoryIdentity>;
  /** Partial-condition reasons this step contributes (replacing the ones it contributed before). */
  partial?: Reason[];
  evidence?: string[];
  note?: string;
  effect?: Record<string, unknown>;
}

/** Evidence each stage contributes (`evidence` in feltdb.flow); reaching a stage again clears what later stages derived. */
const CURRENT_BY_STAGE: Array<[Stage, keyof Project["current"]]> = Object.values(MODEL.steps).flatMap((s) => (s.evidence ? [[s.to, s.evidence as keyof Project["current"]] as [Stage, keyof Project["current"]]] : []));
/** The stages a step may run from, as feltdb.flow declares them: its `from` stages and, to re-run it, its `rerun` stages. */
const startsFrom = (step: StepName): { from: Stage[]; to: Stage } => {
  const s = STEPS[step];
  if (!s) throw new WorkspaceError("INVALID_INPUT", `feltdb.flow declares no step ${step}`);
  return { from: [...s.from, ...s.rerun], to: s.to };
};


export class Workspace {
  readonly store: Store;
  readonly home: string;
  private readonly authority: Authority;
  private readonly credentials: CredentialResolver;
  private readonly providers: WorkspaceOptions["providers"];
  private readonly extractionsRoot: string | undefined;
  private readonly now: () => Date;
  readonly worker: string;
  private readonly leaseMs: number;
  private readonly fetch: typeof globalThis.fetch | undefined;
  private readonly discoveryOrigins: string[];
  private readonly runnerTimeoutMs: number | undefined;
  private readonly faultPoint: WorkspaceOptions["faultPoint"];

  private constructor(store: Store, options: WorkspaceOptions) {
    this.store = store;
    this.home = options.home;
    this.authority = options.authority;
    this.credentials = options.credentials;
    this.providers = options.providers;
    this.extractionsRoot = options.extractionsRoot;
    this.now = options.now ?? (() => new Date());
    this.worker = options.worker ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.fetch = options.fetch;
    this.discoveryOrigins = options.discoveryOrigins ?? [];
    this.runnerTimeoutMs = options.runnerTimeoutMs;
    this.faultPoint = options.faultPoint;
  }

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    return new Workspace(await Store.open(options.home), options);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private iso = () => this.now().toISOString();

  /** Asks the workspace's authority; refuses with `UNAUTHORIZED`. For callers that act through the workspace (agents). */
  async authorize(principal: Principal, action: string, resource: { project?: string } = {}): Promise<void> {
    await requireAllowed(this.authority, principal, action, resource);
  }

  // ---- reads ---------------------------------------------------------------------------------------------------

  async listProjects(principal: Principal): Promise<Project[]> {
    await requireAllowed(this.authority, principal, "project.read");
    return (await this.store.list<Project>("Project")).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async project(principal: Principal, id: string): Promise<Project & { __version: number }> {
    await requireAllowed(this.authority, principal, "project.read", { project: id });
    return this.load(id);
  }

  private async load(id: string): Promise<Project & { __version: number }> {
    const p = await this.store.get<Project>("Project", id);
    if (!p) throw new WorkspaceError("PROJECT_NOT_FOUND", `no project ${id}`);
    return p;
  }

  async records<T>(principal: Principal, collection: "StageEvent" | "Run" | "Artifact" | "Approval" | "Decision" | "Verification" | "Promotion", projectId: string): Promise<T[]> {
    await requireAllowed(this.authority, principal, "project.read", { project: projectId });
    return this.store.list<T>(collection, { projectId });
  }

  async artifact<T>(principal: Principal, id: string | undefined): Promise<{ record: ArtifactRecord; body: T } | undefined> {
    if (!id) return undefined;
    const record = await this.store.get<ArtifactRecord>("Artifact", id);
    if (!record) return undefined;
    await requireAllowed(this.authority, principal, "project.read", { project: record.projectId });
    return { record, body: this.store.readArtifact<T>(record) };
  }

  extractions(): ExtractionEntry[] {
    return this.extractionsRoot ? listExtractions(this.extractionsRoot) : [];
  }

  /** Canonical contracts known to this workspace (the reviewed extractions' contracts), for claim evaluation. */
  canonicalContracts(): AppPortManifest[] {
    return this.extractions().flatMap((e) => {
      try {
        const plan = JSON.parse(readFileSync(e.planPath, "utf8")) as { contract: string };
        return [JSON.parse(readFileSync(join(e.directory, plan.contract), "utf8")) as AppPortManifest];
      } catch {
        return [];
      }
    });
  }

  // ---- creation ------------------------------------------------------------------------------------------------

  async createProject(principal: Principal, input: { provider: RepositoryIdentity["provider"]; owner: string; name: string; url?: string; fetchFrom?: string; ref: string; readCredential?: string; writeCredential?: string }): Promise<Project> {
    await requireAllowed(this.authority, principal, "project.create");
    if (!this.providers[input.provider]) throw new WorkspaceError("UNSUPPORTED", `no ${input.provider} provider is configured`);
    const name = /^[A-Za-z0-9_.-]{1,100}$/;
    if (!name.test(input.owner) || !name.test(input.name)) throw new WorkspaceError("INVALID_INPUT", "owner and repository are GitHub-style names");
    // No ref: the repository's default branch (`HEAD`), resolved when the revision is acquired.
    input = { ...input, ref: input.ref?.trim() || "HEAD" };
    if (/\s|\.\.|^-/.test(input.ref)) throw new WorkspaceError("INVALID_INPUT", "a ref is a branch, tag or commit SHA");
    const url = (input.url ?? `https://github.com/${input.owner}/${input.name}`).replace(/\.git$/, "");
    if (/^[a-z]+:\/\/[^/]*@/.test(url) || (input.fetchFrom && /^[a-z]+:\/\/[^/]*@/.test(input.fetchFrom))) throw new WorkspaceError("INVALID_INPUT", "a repository URL never carries a credential; pass a credential reference");
    const repository: RepositoryIdentity = {
      provider: input.provider,
      owner: input.owner,
      name: input.name,
      url,
      ...(input.fetchFrom ? { fetchFrom: input.fetchFrom } : {}),
      credentials: {
        ...(input.readCredential ? { read: parseCredentialReference(input.readCredential) } : {}),
        ...(input.writeCredential ? { write: parseCredentialReference(input.writeCredential) } : {})
      }
    };
    const at = this.iso();
    const id = `prj_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const project: Project = { id, createdAt: at, createdBy: principal.id, updatedAt: at, repository, ref: input.ref, stage: STEPS.create!.to, condition: { state: "active", reasons: [] }, current: {}, history: 1 };
    const event: StageEvent = { id: `${id}.0000`, projectId: id, sequence: 0, step: "create", to: STEPS.create!.to, condition: "active", at, actor: principal.id, evidence: [], reasons: [], note: `${repository.owner}/${repository.name} at ${input.ref}` };
    await this.store.commit([
      { collection: "Project", id, value: project as never, create: true },
      { collection: "StageEvent", id: event.id, value: event as never, create: true }
    ]);
    return this.load(id);
  }

  // ---- the step protocol ---------------------------------------------------------------------------------------

  private assertRevision(p: Project): string {
    if (!p.revision) throw new WorkspaceError("REVISION_NOT_PINNED", "the project has no pinned revision");
    const checkout = this.store.resolve(p.revision.checkout);
    const head = gitIdentity(checkout).revision;
    if (head !== p.revision.sha) throw new WorkspaceError("REVISION_CHANGED", `the isolated checkout is at ${head ?? "no revision"}, not the pinned ${p.revision.sha}`);
    if (treeHash(checkout) !== p.revision.treeDigest) throw new WorkspaceError("REVISION_CHANGED", "the isolated checkout changed since it was pinned; acquire the revision again");
    return checkout;
  }

  /**
   * Claims a run for `step` and starts `work`. Rejects before claiming (unauthorized, wrong stage, cancelled, in
   * progress, conflict); after claiming, `done` resolves with the advanced project or rejects with the recorded failure.
   */
  private async begin(principal: Principal, id: string, step: StepName | ApprovalAction, options: { stage: { from: readonly Stage[]; to?: Stage }; input?: Record<string, unknown>; resuming?: boolean; permission?: string; guard?: (p: Project) => Promise<void> }, work: (ctx: { project: Project; run: Run; signal: AbortSignal }) => Promise<Outcome>): Promise<Started> {
    await requireAllowed(this.authority, principal, options.permission ?? "project.advance", { project: id });
    const p = await this.load(id);
    if (p.condition.state === "cancelled") throw new WorkspaceError("PROJECT_CANCELLED", "the project is cancelled; nothing further runs");
    if (p.condition.state === "failed" && !options.resuming) throw new WorkspaceError("PROJECT_FAILED", `the project failed at ${p.failure?.step ?? "a step"} (${p.failure?.code ?? ""}); resume it to retry that step`);
    if (!options.stage.from.includes(p.stage)) throw new WorkspaceError("INVALID_TRANSITION", `${step} starts from ${options.stage.from.join(" or ")}; the project is at ${p.stage}`, { stage: p.stage, step });
    // The action boundary's own precondition (an approval of the current subject): refused before any run is claimed.
    if (options.guard) await options.guard(p);
    const writes: Write[] = [];
    if (p.activeRun) {
      const active = await this.store.get<Run>("Run", p.activeRun);
      if (active && active.status === "running") {
        if (active.leaseExpiresAt > this.iso()) throw new WorkspaceError("STEP_IN_PROGRESS", `${active.step} is running (${active.id}, held by ${active.owner} until ${active.leaseExpiresAt})`);
        writes.push({ collection: "Run", id: active.id, value: { ...active, status: "abandoned", finishedAt: this.iso(), error: { code: "LEASE_EXPIRED", message: `${active.owner} stopped renewing its lease` } } as never, ifVersion: active.__version });
      }
    }
    const attempt = (await this.store.list<Run>("Run", { projectId: id, step })).length + 1;
    const run: Run = { id: `${id}.${step}.${attempt}`, projectId: id, step, attempt, status: "running", owner: this.worker, actor: principal.id, startedAt: this.iso(), leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(), ...(options.input ? { input: options.input } : {}) } as Run;
    await this.store.commit([
      ...writes,
      { collection: "Run", id: run.id, value: run as never, create: true },
      { collection: "Project", id, value: { ...p, activeRun: run.id, updatedAt: this.iso() } as never, ifVersion: p.__version }
    ]);
    const done = this.carry(principal, id, step, options.stage.to, run, work);
    done.catch(() => {}); // the failure is recorded; callers that await `done` still see it
    return { run: run.id, done };
  }

  private async carry(principal: Principal, id: string, step: StepName | ApprovalAction, to: Stage | undefined, run: Run, work: (ctx: { project: Project; run: Run; signal: AbortSignal }) => Promise<Outcome>): Promise<Project> {
    const controller = new AbortController();
    // The lease: renewed while the work runs. If the run is no longer ours, or the project was cancelled, stop.
    const heartbeat = setInterval(() => {
      void (async () => {
        const current = await this.store.get<Run>("Run", run.id);
        const project = await this.store.get<Project>("Project", id);
        if (!current || current.status !== "running" || current.owner !== this.worker || project?.condition.state === "cancelled") return controller.abort();
        await this.store.update("Run", run.id, current.__version, { leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString() });
      })().catch(() => {});
    }, Math.max(50, Math.floor(this.leaseMs / 3)));
    let outcome: Outcome;
    try {
      const p = await this.load(id);
      outcome = await work({ project: p, run, signal: controller.signal });
    } catch (error) {
      clearInterval(heartbeat);
      // A simulated process death records nothing: the run keeps its (expiring) lease, as after a real kill.
      if (error instanceof SimulatedCrash) throw error;
      const e = error instanceof WorkspaceError ? error : error instanceof ExtractionRefused ? new WorkspaceError(error.reasons[0]?.code ?? "EXTRACTION_REFUSED", error.message, { reasons: error.reasons }) : new WorkspaceError("STEP_FAILED", (error as Error)?.message ?? String(error));
      await this.recordFailure(principal, id, step, run, e);
      throw e;
    }
    clearInterval(heartbeat);
    const p = await this.load(id);
    const current = await this.store.get<Run>("Run", run.id);
    const at = this.iso();
    const target = to ?? p.stage;
    let nextCurrent = { ...p.current };
    if (to) for (const [stage, key] of CURRENT_BY_STAGE) if (stagesAfter(to).includes(stage)) delete nextCurrent[key];
    nextCurrent = { ...nextCurrent, ...outcome.current };
    const stageOfStep = to ?? p.stage;
    // A failure this run recovered from is no longer a condition of the project (it stays in the run and the history).
    const recovered = (r: Reason) => Boolean(p.failure && r.code === p.failure.code && r.message === p.failure.message);
    const kept = p.condition.reasons.filter((r) => r.stage !== stageOfStep && (!to || !stagesAfter(to).includes(r.stage as Stage)) && !recovered(r));
    // A gap already reported by an earlier stage is not repeated by a later one that inherits it.
    const reasons = [...kept, ...(outcome.partial ?? []).filter((r) => !kept.some((k) => k.code === r.code)).map((r) => ({ ...r, stage: stageOfStep }))];
    const next: Project = {
      ...p,
      ...(outcome.revision ? { revision: outcome.revision } : {}),
      repository: { ...p.repository, ...outcome.repository },
      stage: target,
      condition: { state: reasons.length ? "partial" : "active", reasons },
      current: nextCurrent,
      updatedAt: at,
      history: p.history + 1
    };
    delete next.failure;
    delete next.activeRun;
    const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: !(step in STEPS) ? "action" : (step as StepName), from: p.stage, to: target, condition: next.condition.state, at, actor: principal.id, evidence: outcome.evidence ?? [], reasons: outcome.partial ?? [], ...(outcome.note ? { note: outcome.note } : {}) };
    try {
      if (!current || current.status !== "running" || p.activeRun !== run.id) throw new WorkspaceError("CONFLICT", `run ${run.id} no longer holds the project`);
      await this.store.commit([
        ...(outcome.writes ?? []),
        { collection: "Run", id: run.id, value: { ...current, status: "succeeded", finishedAt: at, ...(outcome.effect ? { effect: outcome.effect } : {}) } as never, ifVersion: current.__version },
        { collection: "Project", id, value: next as never, ifVersion: p.__version },
        { collection: "StageEvent", id: event.id, value: event as never, create: true }
      ]);
    } catch (error) {
      // The project changed under the run (cancelled, or another run took over an expired lease): the outcome is kept
      // on the run record and not applied.
      const latest = await this.store.get<Run>("Run", run.id);
      if (latest && latest.status === "running") await this.store.commit([{ collection: "Run", id: run.id, value: { ...latest, status: "not-applied", finishedAt: at, error: { code: "CONFLICT", message: (error as Error).message } } as never, ifVersion: latest.__version }]).catch(() => {});
      throw error instanceof WorkspaceError ? error : new WorkspaceError("CONFLICT", (error as Error).message);
    }
    return this.load(id);
  }

  private async recordFailure(principal: Principal, id: string, step: StepName | ApprovalAction, run: Run, error: WorkspaceError): Promise<void> {
    for (let tries = 0; tries < 3; tries++) {
      const p = await this.load(id);
      const current = await this.store.get<Run>("Run", run.id);
      if (!current || current.status !== "running") return;
      const at = this.iso();
      const writes: Write[] = [{ collection: "Run", id: run.id, value: { ...current, status: "failed", finishedAt: at, error: { code: error.code, message: error.message } } as never, ifVersion: current.__version }, ...((error.details.writes as Write[] | undefined) ?? [])];
      if (p.activeRun === run.id && p.condition.state !== "cancelled") {
        const isAction = !(step in STEPS);
        // A refused action leaves the workflow where it was: only a failed workflow step marks the project failed.
        const next: Project = isAction
          ? { ...p, updatedAt: at, history: p.history + 1 }
          : { ...p, condition: { state: "failed", reasons: [...p.condition.reasons, { code: error.code, message: error.message, stage: p.stage }] }, failure: { step: step as StepName, code: error.code, message: error.message, at, run: run.id }, updatedAt: at, history: p.history + 1 };
        delete next.activeRun;
        const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: isAction ? "action" : "fail", from: p.stage, to: p.stage, condition: next.condition.state, at, actor: principal.id, evidence: [run.id], reasons: [{ code: error.code, message: error.message }], note: `${step} failed` };
        writes.push({ collection: "Project", id, value: next as never, ifVersion: p.__version }, { collection: "StageEvent", id: event.id, value: event as never, create: true });
      }
      try {
        await this.store.commit(writes);
        return;
      } catch {
        /* the project moved (a heartbeat or a cancel); re-read and retry */
      }
    }
  }

  private artifactWrite(p: Project, kind: ArtifactKind, body: unknown, run: Run, extra: Partial<ArtifactRecord> = {}): { record: ArtifactRecord; write: Write } {
    const stored = this.store.putArtifactBody(`${JSON.stringify(body, null, 2)}\n`);
    const record: ArtifactRecord = { id: `${p.id}.${kind}.${stored.fileDigest.slice(7, 23)}`, projectId: p.id, kind, fileDigest: stored.fileDigest, path: stored.path, bytes: stored.bytes, revision: p.revision?.sha ?? "", createdAt: this.iso(), run: run.id, partial: [], summary: {}, ...extra };
    return { record, write: { collection: "Artifact", id: record.id, value: record as never, create: true } };
  }

  private async existingOrWrite(p: Project, kind: ArtifactKind, body: unknown, run: Run, extra: Partial<ArtifactRecord> = {}) {
    const made = this.artifactWrite(p, kind, body, run, extra);
    const existing = await this.store.get<ArtifactRecord>("Artifact", made.record.id);
    return existing ? { record: existing, writes: [] as Write[] } : { record: made.record, writes: [made.write] };
  }

  private async body<T>(id: string | undefined, what: string): Promise<{ record: ArtifactRecord; body: T }> {
    const record = id ? await this.store.get<ArtifactRecord>("Artifact", id) : undefined;
    if (!record) throw new WorkspaceError("EVIDENCE_MISSING", `the project has no current ${what}`);
    return { record, body: this.store.readArtifact<T>(record) };
  }

  // ---- steps ---------------------------------------------------------------------------------------------------

  /** Resolves the ref to a commit through the provider and fetches exactly that commit into an isolated checkout. */
  acquire(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "acquire", { stage: startsFrom("acquire"), resuming }, async ({ project: p }) => {
      const provider = this.providers[p.repository.provider];
      if (!provider) throw new WorkspaceError("UNSUPPORTED", `no ${p.repository.provider} provider is configured`);
      const resolved = await provider.resolve(p.repository, p.ref, { principal, project: p.id, authority: this.authority, credentials: this.credentials });
      const checkout = join("workspaces", p.id, resolved.sha, "checkout");
      await acquireCheckout({
        destination: this.store.resolve(checkout),
        fetchUrl: resolved.fetchUrl,
        canonicalUrl: p.repository.url,
        sha: resolved.sha,
        ...(p.repository.credentials.read ? { credential: { reference: p.repository.credentials.read, resolver: this.credentials, project: p.id } } : {})
      });
      const partial: Reason[] = resolved.onDefaultBranch === "yes" ? [] : [{ code: "REVISION_NOT_ON_DEFAULT_BRANCH", message: resolved.note ?? `${resolved.sha.slice(0, 12)} is not established as part of ${resolved.defaultBranch ?? "the default branch"}` }];
      return {
        revision: { sha: resolved.sha, ref: resolved.ref ?? p.ref, pinnedAt: "", checkout, treeDigest: "", onDefaultBranch: resolved.onDefaultBranch, ...(resolved.defaultBranchSha ? { defaultBranchSha: resolved.defaultBranchSha } : {}) },
        repository: { ...(resolved.defaultBranch ? { defaultBranch: resolved.defaultBranch } : {}) },
        partial,
        evidence: [resolved.sha],
        note: `fetched ${resolved.sha} (${p.ref}) into an isolated checkout; hooks, submodules and LFS smudge off; nothing executed`
      };
    });
  }

  /** Pins the acquired revision: HEAD is the resolved SHA, and the checkout's content hash is recorded. */
  pin(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "pin", { stage: startsFrom("pin"), resuming }, async ({ project: p }) => {
      if (!p.revision) throw new WorkspaceError("EVIDENCE_MISSING", "nothing was acquired");
      const checkout = this.store.resolve(p.revision.checkout);
      const head = gitIdentity(checkout).revision;
      if (head !== p.revision.sha) throw new WorkspaceError("REVISION_MISMATCH", `the checkout is at ${head ?? "no revision"}, not ${p.revision.sha}`);
      const treeDigest = treeHash(checkout);
      return { revision: { ...p.revision, pinnedAt: this.iso(), treeDigest }, partial: p.condition.reasons.filter((r) => r.stage === "repository-acquired"), evidence: [p.revision.sha, treeDigest], note: `pinned ${p.revision.sha}; checkout ${treeDigest}` };
    });
  }

  /** Static inspection of the pinned revision for an existing AppPort integration. */
  inspect(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "inspect", { stage: startsFrom("inspect"), resuming }, async ({ project: p, run }) => {
      const checkout = this.assertRevision(p);
      const record: IntegrationRecord = inspectIntegration(checkout, p.revision!.sha);
      const { record: artifact, writes } = await this.existingOrWrite(p, "integration", record, run, { format: record.format, summary: { status: record.status, integrations: record.integrations.map((i) => i.root) } });
      return { writes, current: { integration: artifact.id }, evidence: [artifact.id], note: `AppPort integration ${record.status}${record.integrations.length ? `: ${record.integrations.map((i) => i.root).join(", ")}` : ""}` };
    });
  }

  /**
   * Discovers what a running instance of the application advertises, through AppPort's client. `endpoint` is the
   * application's origin; without one (or without an integration) the outcome says so explicitly.
   */
  discover(principal: Principal, id: string, input: { endpoint?: string } = {}, resuming = false): Promise<Started> {
    if (input.endpoint !== undefined && !/^https?:\/\/[^\s/@]+(?::\d+)?\/?$/.test(input.endpoint)) return Promise.reject(new WorkspaceError("INVALID_INPUT", "an endpoint is an http(s) origin without credentials or a path"));
    return this.begin(principal, id, "discover", { stage: startsFrom("discover"), input, resuming }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const integration = await this.body<IntegrationRecord>(p.current.integration, "integration inspection");
      const present = integration.body.status === "present";
      const candidates = !input.endpoint && present ? endpointCandidates(this.store.resolve(p.revision!.checkout), { configured: this.discoveryOrigins, integrationRoots: integration.body.integrations.map((i) => i.root) }) : [];
      const record = await discoverCapabilities({ ...(input.endpoint ? { endpoint: input.endpoint.replace(/\/$/, "") } : {}), candidates, integrationPresent: present, canonical: this.canonicalContracts(), now: this.now, ...(this.fetch ? { fetch: this.fetch } : {}) });
      const { record: artifact, writes } = await this.existingOrWrite(p, "discovery", record, run, { format: record.format, summary: { outcome: record.outcome, capabilities: record.capabilities.length } });
      const partial: Reason[] = record.outcome === "unavailable" ? [{ code: "DISCOVERY_UNAVAILABLE", message: record.note }] : [];
      return { writes, current: { discovery: artifact.id }, partial, evidence: [artifact.id], note: `${record.outcome}${record.endpoint ? ` at ${record.endpoint}${record.resolution?.given ? "" : " (found from the source)"}` : ""}: ${record.capabilities.length} capabilities; nothing invoked` };
    });
  }

  /** Static assessment of the same pinned revision with @appport/assessment. Partial coverage stays visible. */
  assess(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "assess", { stage: startsFrom("assess"), resuming }, async ({ project: p, run }) => {
      const checkout = this.assertRevision(p);
      const assessment = assessRepository(checkout);
      const verified = verifyAssessment(assessment, { repository: checkout });
      if (!verified.ok) throw new WorkspaceError("ASSESSMENT_INVALID", `the assessment does not verify: ${[...new Set(verified.findings.map((f) => f.code))].join(", ")}`);
      if (assessment.target.revision !== p.revision!.sha) throw new WorkspaceError("REVISION_MISMATCH", `the assessment is of ${assessment.target.revision}, not ${p.revision!.sha}`);
      this.assertRevision(p);
      const { record: artifact, writes } = await this.existingOrWrite(p, "assessment", assessment, run, {
        digest: assessment.digest,
        format: assessment.format,
        partial: assessment.coverage.partial ? assessment.coverage.partialReasons : [],
        summary: { candidates: assessment.candidates.length, filesAnalyzed: assessment.coverage.filesAnalyzed, filesSeen: assessment.coverage.filesSeen, recommended: assessment.recommendation?.candidate ?? null }
      });
      const partial: Reason[] = assessment.coverage.partial ? [{ code: "ASSESSMENT_PARTIAL", message: `partial coverage: ${assessment.coverage.partialReasons.join(", ")} (${assessment.coverage.filesAnalyzed} of ${assessment.coverage.filesSeen} files analyzed)` }] : [];
      return { writes, current: { assessment: artifact.id }, partial, evidence: [artifact.id, assessment.digest], note: `${assessment.candidates.length} candidates; ${assessment.digest}` };
    });
  }

  private async bindings(p: Project): Promise<ExtractionBinding[]> {
    const verification = p.current.verification ? await this.store.get<VerificationRecord>("Verification", p.current.verification) : undefined;
    if (!verification || !p.current.extraction) return [];
    const x = await this.body<CapabilityExtraction>(p.current.extraction, "extraction");
    const fresh = await this.freshness(p, verification);
    return [
      {
        candidate: x.body.assessment.candidate.id,
        capability: { name: x.body.contract.capability.name, version: x.body.contract.capability.version },
        extraction: `${x.body.identity.name} revision ${x.body.identity.revision}`,
        extractionDigest: x.body.digest,
        verified: verification.status === "verified" && fresh.length === 0,
        detail: verification.status === "verified" && fresh.length === 0 ? `${verification.behaviors.passed} of ${verification.behaviors.required} behaviors passed (${verification.behaviors.againstReal} against the real application), declaration published and valid` : `not verified: ${[...verification.reasons, ...fresh].map((r) => r.code).join(", ")}`
      }
    ];
  }

  private async decisions(projectId: string): Promise<MatchDecision[]> {
    return (await this.store.list<MatchDecision & { projectId: string; kind: string }>("Decision", { projectId, kind: "match-assertion" })).map(({ id, capability, candidate, rationale, by, at }) => ({ id, capability, candidate, rationale, by, at }));
  }

  /** One inventory of discovered capabilities and assessed candidates, with graded matches. */
  reconcile(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "reconcile", { stage: startsFrom("reconcile"), resuming }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
      const discovery = await this.body<DiscoveryRecord>(p.current.discovery, "discovery");
      const inventory = reconcile({ assessment: assessment.body, discovery: discovery.body, bindings: await this.bindings(p), decisions: await this.decisions(p.id) });
      const { record: artifact, writes } = await this.existingOrWrite(p, "inventory", inventory, run, { format: inventory.format, partial: inventory.partial.map((x) => x.code), summary: inventory.summary });
      return { writes, current: { inventory: artifact.id }, partial: inventory.partial, evidence: [artifact.id], note: `${inventory.summary.confirmed} confirmed, ${inventory.summary.probable} probable, ${inventory.summary.ambiguous} ambiguous, ${inventory.summary.unresolved} unresolved; ${inventory.summary.candidates} candidates kept` };
    });
  }

  /** Records an operator's assertion that a candidate backs a capability: evidence for reconciliation, never verification. */
  async assertMatch(principal: Principal, id: string, input: { capability: string; candidate: string; rationale: string }): Promise<MatchDecision> {
    await requireAllowed(this.authority, principal, "project.advance", { project: id });
    const p = await this.load(id);
    const [name, version] = input.capability.split("@");
    if (!name || !/^\d+$/.test(version ?? "") || !input.candidate || !input.rationale?.trim()) throw new WorkspaceError("INVALID_INPUT", "an assertion names capability@version, a candidate and a rationale");
    const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
    if (!assessment.body.candidates.some((c) => c.id === input.candidate)) throw new WorkspaceError("CANDIDATE_NOT_FOUND", `${input.candidate} is not a candidate of the current assessment`);
    const decision = { id: `${id}.match.${sha256(`${input.capability}|${input.candidate}|${this.iso()}`).slice(0, 12)}`, projectId: id, kind: "match-assertion", capability: { name, version: Number(version) }, candidate: input.candidate, rationale: input.rationale.trim(), by: principal.id, at: this.iso() };
    await this.store.commit([{ collection: "Decision", id: decision.id, value: decision as never, create: true }]);
    return decision;
  }

  /** Selects a candidate for extraction. Only an eligible candidate of the current inventory can be selected. */
  select(principal: Principal, id: string, input: { candidate: string; rationale?: string }, resuming = false): Promise<Started> {
    return this.begin(principal, id, "select", { stage: startsFrom("select"), input, resuming }, async ({ project: p }) => {
      this.assertRevision(p);
      const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
      const candidate = assessment.body.candidates.find((c) => c.id === input.candidate);
      if (!candidate) throw new WorkspaceError("CANDIDATE_NOT_FOUND", `${input.candidate} is not a candidate of the current assessment`);
      const { candidateRefusals } = await import("@appport/extraction");
      const refusals = candidateRefusals(candidate, candidate.id);
      if (refusals.length) throw new WorkspaceError("CANDIDATE_INELIGIBLE", `${candidate.id} cannot be extracted: ${refusals.map((r) => r.code).join(", ")}`, { reasons: refusals });
      const decision = { id: `${id}.selection.${sha256(`${candidate.id}|${this.iso()}`).slice(0, 12)}`, projectId: id, kind: "candidate-selection", candidate: candidate.id, name: candidate.name, assessmentDigest: assessment.body.digest, rationale: input.rationale ?? "", by: principal.id, at: this.iso() };
      return { writes: [{ collection: "Decision", id: decision.id, value: decision as never, create: true }], current: { selection: decision.id }, evidence: [decision.id], note: `selected ${candidate.name}` };
    });
  }

  private async selection(p: Project): Promise<{ candidate: string; name: string; assessmentDigest: string }> {
    const s = p.current.selection ? await this.store.get<{ candidate: string; name: string; assessmentDigest: string }>("Decision", p.current.selection) : undefined;
    if (!s) throw new WorkspaceError("EVIDENCE_MISSING", "no candidate is selected");
    return s;
  }

  private entryFor(candidate: string): ExtractionEntry {
    const entries = this.extractions().filter((e) => e.candidate === candidate);
    if (!entries.length) throw new WorkspaceError("PLAN_MISSING", `no reviewed extraction plan exists for ${candidate}; the workspace does not generate one`);
    if (entries.length > 1) throw new WorkspaceError("PLAN_AMBIGUOUS", `${entries.length} extraction plans name ${candidate}: ${entries.map((e) => e.name).join(", ")}`);
    return entries[0]!;
  }

  /** The approval subject of `generate-files`: exactly this revision, assessment, plan directory and validated plan. */
  private async generateSubject(p: Project): Promise<{ subject: string; description: string; entry: ExtractionEntry; planDigest: string }> {
    const selection = await this.selection(p);
    const entry = this.entryFor(selection.candidate);
    const plan = await this.body<CapabilityExtraction>(p.current.plan, "extraction plan");
    const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
    const planDigest = directoryDigest(entry.directory);
    const subject = digestOf({ action: "generate-files", revision: p.revision!.sha, assessment: assessment.body.digest, extraction: entry.name, planDirectory: planDigest, plan: plan.body.digest });
    return { subject, entry, planDigest, description: `Run the reviewed extraction ${entry.name} (${entry.identity.name} revision ${entry.identity.revision}) against ${p.repository.owner}/${p.repository.name} at ${p.revision!.sha.slice(0, 12)}: builds the application with the plan's declared build outside the checkout, starts it with synthetic data and the existing AppPort bridge with the extracted host, runs the behavioral suite, and writes the extraction artifact into this workspace. It writes nothing to the target repository and pushes nothing.` };
  }

  /** Validates the reviewed plan for the selected candidate with the extraction library, then requests approval. */
  plan(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "plan", { stage: startsFrom("plan"), resuming }, async ({ project: p, run }) => {
      const checkout = this.assertRevision(p);
      const selection = await this.selection(p);
      const entry = this.entryFor(selection.candidate);
      const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
      if (selection.assessmentDigest !== assessment.body.digest) throw new WorkspaceError("SELECTION_STALE", "the selection was made against another assessment; select again");
      // The plan, contract, adapter, mapping, fulfillment declaration and runtime, validated as `appworks extract` would,
      // without results: every behavior not run. Refusals carry the library's codes (FULFILLMENT_MISSING, ...).
      const read = readPlan(entry.planPath, checkout);
      const previous = entry.previousPath ? (JSON.parse(readFileSync(entry.previousPath, "utf8")) as CapabilityExtraction) : undefined;
      const proposal = createExtraction({ assessment: assessment.body, candidate: selection.candidate, checkout: observeCheckout(assessment.body, checkout), plan: read, ...(previous ? { previous } : {}) });
      const { record: artifact, writes } = await this.existingOrWrite(p, "plan", proposal, run, { digest: proposal.digest, format: proposal.format, summary: { extraction: entry.name, identity: `${proposal.identity.name} revision ${proposal.identity.revision}`, planDirectory: directoryDigest(entry.directory), behaviors: proposal.verification.records.length } });
      return { writes, current: { plan: artifact.id }, evidence: [artifact.id, proposal.digest], note: `plan ${entry.name} validated: ${proposal.verification.records.length} behaviors to verify, none run` };
    });
  }

  /** Requests the `generate-files` approval for the validated plan. */
  requestApproval(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "request-approval", { stage: startsFrom("request-approval"), resuming }, async ({ project: p }) => {
      this.assertRevision(p);
      const { subject, description } = await this.generateSubject(p);
      const approval: ApprovalRecord = { id: `${id}.approval.generate-files.${subject.slice(7, 19)}`, projectId: id, action: "generate-files", subject, subjectDescription: description, status: "requested", requestedAt: this.iso(), requestedBy: principal.id };
      const existing = await this.store.get<ApprovalRecord>("Approval", approval.id);
      return { writes: existing ? [] : [{ collection: "Approval", id: approval.id, value: approval as never, create: true }], current: { approvalRequest: approval.id }, evidence: [approval.id, subject], note: "approval requested for generate-files" };
    });
  }

  /** The current subject of any approval action, from the current evidence. */
  async approvalSubject(principal: Principal, id: string, action: ApprovalAction, input: Record<string, string> = {}): Promise<{ subject: string; description: string }> {
    await requireAllowed(this.authority, principal, "project.read", { project: id });
    const p = await this.load(id);
    if (action === "generate-files") {
      const s = await this.generateSubject(p);
      return { subject: s.subject, description: s.description };
    }
    if (action === "adopt-contract") {
      const a = await this.body<ContractAdoption>(p.current.adoption, "contract-adoption proposal");
      return { subject: a.body.digest, description: `Adopt ${a.body.contract.application} ${a.body.contract.capability}@${a.body.contract.version} (${a.body.contract.capabilityDigest}) into ${p.repository.owner}/${p.repository.name}'s AppPort integration, as proposed: ${a.body.differences.length} differences, ${a.body.questions.length} questions, ${a.body.blocking.length} blocking. Adoption grants no authority and registers nothing.` };
    }
    if (action === "modify-integration") {
      const a = await this.body<Promotion>(p.current.promotionArtifact, "promotion artifact");
      return { subject: a.body.digest, description: `Add ${a.body.target.files.length} files under ${a.body.target.directory} of an isolated worktree of ${p.repository.owner}/${p.repository.name} at ${a.body.target.base.slice(0, 12)} (${a.body.target.files.map((f) => f.path).join(", ")}), then run ${a.body.verification.runner.path} against it. Existing files are not modified; nothing is committed, pushed or deployed.` };
    }
    if (action === "commit" || action === "push" || (action === "pull-request" && !input.head && !input.base)) {
      const promotion = await this.currentPromotion(p);
      if (promotion?.patchDigest) {
        const subject = digestOf({ action, promotion: promotion.digest, patch: promotion.patchDigest, ...(action !== "commit" ? { commit: promotion.commit ?? null, branch: promotion.branch ?? null, base: p.repository.defaultBranch ?? null } : {}) });
        return { subject, description: action === "commit" ? `Commit the reviewed patch ${promotion.patchDigest} (promotion ${promotion.digest}) on a local branch of the isolated worktree. Nothing is pushed.` : `${action} the committed promotion ${promotion.commit ?? "(not committed)"} on ${promotion.branch ?? "(no branch)"}.` };
      }
    }
    const x = p.current.extraction ? await this.body<CapabilityExtraction>(p.current.extraction, "extraction") : undefined;
    if (action === "promote") return { subject: digestOf({ action, verification: p.current.verification, extraction: x?.body.digest }), description: `Promote the verified extraction ${x ? `${x.body.identity.name} revision ${x.body.identity.revision} (${x.body.digest})` : ""} to a deployment.` };
    if (action === "pull-request") {
      if (!input.head || !input.base) throw new WorkspaceError("INVALID_INPUT", "a pull request names a head and a base branch");
      return { subject: digestOf({ action, repository: `${p.repository.owner}/${p.repository.name}`, revision: p.revision?.sha, head: input.head, base: input.base }), description: `Open a pull request on ${p.repository.owner}/${p.repository.name} from ${input.head} into ${input.base}.` };
    }
    return { subject: digestOf({ action, revision: p.revision?.sha, extraction: x?.body.digest }), description: `${action} generated changes to ${p.repository.owner}/${p.repository.name}.` };
  }

  /**
   * Grants an approval for exactly `subject`. The principal needs `approval.grant:<action>`; a subject that is not the
   * action's current subject is refused, so an approval never covers inputs that changed after it was asked for.
   */
  async approve(principal: Principal, id: string, input: { action: ApprovalAction; subject: string; head?: string; base?: string }): Promise<ApprovalRecord> {
    if (!(APPROVAL_ACTIONS as readonly string[]).includes(input.action)) throw new WorkspaceError("INVALID_INPUT", `approval actions are ${APPROVAL_ACTIONS.join(", ")}`);
    await requireAllowed(this.authority, principal, `approval.grant:${input.action}`, { project: id });
    const p = await this.load(id);
    if (p.condition.state === "cancelled") throw new WorkspaceError("PROJECT_CANCELLED", "the project is cancelled");
    const current = await this.approvalSubject(principal, id, input.action, { ...(input.head ? { head: input.head } : {}), ...(input.base ? { base: input.base } : {}) });
    if (input.subject !== current.subject) throw new WorkspaceError("APPROVAL_SUBJECT_MISMATCH", `the subject to approve is ${current.subject}; ${input.subject} is not (the inputs changed, or another action was meant)`);
    const extra: Write[] = [];
    if (input.action === "adopt-contract") {
      const a = await this.body<ContractAdoption>(p.current.adoption, "contract-adoption proposal");
      if (a.body.blocking.length) throw new WorkspaceError("ADOPTION_BLOCKED", `the proposal has ${a.body.blocking.length} blocking items and cannot be approved: ${a.body.blocking.map((b) => b.code + " " + b.subject).join("; ")}`);
    }
    const at = this.iso();
    const recordId = `${id}.approval.${input.action}.${current.subject.slice(7, 19)}`;
    const existing = await this.store.get<ApprovalRecord>("Approval", recordId);
    if (existing && existing.status === "granted") return existing;
    if (existing && existing.status === "consumed") throw new WorkspaceError("APPROVAL_CONSUMED", "this approval was already used; the action ran");
    const approval: ApprovalRecord = { ...(existing ?? { id: recordId, projectId: id, action: input.action, subject: current.subject, subjectDescription: current.description, requestedAt: at, requestedBy: principal.id }), status: "granted", grantedAt: at, grantedBy: principal.id } as ApprovalRecord;
    if (input.action === "modify-integration") {
      const promotion = await this.currentPromotion(p);
      if (promotion && promotion.digest === current.subject && promotion.state === "proposed") extra.push({ collection: "Promotion", id: promotion.id, value: { ...promotion, state: "approved", approval: recordId, updatedAt: at } as never, ifVersion: promotion.__version! });
    }
    const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: "approve", from: p.stage, to: p.stage, condition: p.condition.state, at, actor: principal.id, evidence: [recordId, current.subject], reasons: [], note: `approved ${input.action}` };
    await this.store.commit([
      existing ? { collection: "Approval", id: recordId, value: approval as never, ifVersion: (existing as ApprovalRecord & { __version: number }).__version } : { collection: "Approval", id: recordId, value: approval as never, create: true },
      { collection: "Project", id, value: { ...p, updatedAt: at, history: p.history + 1 } as never, ifVersion: p.__version },
      { collection: "StageEvent", id: event.id, value: event as never, create: true },
      ...extra
    ]);
    return approval;
  }

  /** The action boundary: a granted, unconsumed approval for exactly this subject, and the authority to act. */
  private async requireApproval(principal: Principal, p: Project, action: ApprovalAction, subject: string): Promise<ApprovalRecord & { __version: number }> {
    await requireAllowed(this.authority, principal, `action:${action}`, { project: p.id });
    const approval = await this.store.get<ApprovalRecord>("Approval", `${p.id}.approval.${action}.${subject.slice(7, 19)}`);
    if (!approval || approval.subject !== subject) throw new WorkspaceError("APPROVAL_REQUIRED", `${action} needs an explicit approval of its current subject ${subject}; none was granted${(await this.store.list<ApprovalRecord>("Approval", { projectId: p.id, action })).length ? " (an earlier approval covers inputs that have since changed)" : ""}`);
    if (approval.status === "consumed") throw new WorkspaceError("APPROVAL_CONSUMED", `the approval for ${action} was used by ${approval.consumedBy}`);
    if (approval.status !== "granted") throw new WorkspaceError("APPROVAL_REQUIRED", `${action} is ${approval.status}, not approved`);
    return approval;
  }

  private consume(approval: ApprovalRecord & { __version: number }, run: Run): Write {
    return { collection: "Approval", id: approval.id, value: { ...approval, status: "consumed", consumedAt: this.iso(), consumedBy: run.id } as never, ifVersion: approval.__version };
  }

  /**
   * Executes the approved extraction: the boundary re-derives the subject from the current evidence and requires its
   * approval, so a plan, revision or assessment that changed after approval cannot run on the old approval.
   */
  execute(principal: Principal, id: string, resuming = false): Promise<Started> {
    const approvalAction = STEPS.execute!.approval!;
    const guard = async (p: Project) => {
      this.assertRevision(p);
      await this.requireApproval(principal, p, approvalAction, (await this.generateSubject(p)).subject);
    };
    return this.begin(principal, id, "execute", { stage: startsFrom("execute"), resuming, guard }, async ({ project: p, run, signal }) => {
      const checkout = this.assertRevision(p);
      const { subject, entry, planDigest } = await this.generateSubject(p);
      const approval = await this.requireApproval(principal, p, approvalAction, subject);
      const work = join(tmpdir(), `appworks-run-${run.id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
      mkdirSync(work, { recursive: true });
      const output = join(work, "extraction.json");
      rmSync(output, { force: true });
      const result = await runExtraction(entry, { checkout, output, signal, ...(this.runnerTimeoutMs ? { timeoutMs: this.runnerTimeoutMs } : {}) });
      const log = await this.existingOrWrite(p, "verification-log", { format: "appworks.runner-log/1", runner: `${entry.name}/scripts/extract.mjs`, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, output: result.output }, run, { summary: { exitCode: result.exitCode, timedOut: result.timedOut } });
      let text: string;
      try {
        text = readFileSync(output, "utf8");
      } catch {
        throw new WorkspaceError(signal.aborted ? "RUN_CANCELLED" : "RUNNER_FAILED", `the runner exited ${result.exitCode ?? result.signal}${result.timedOut ? " (timed out)" : ""} without an extraction artifact; see ${log.record.id}`, { log: log.record.id, writes: log.writes });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      // The runner contract: nothing is written to the checkout. A run that did is refused, whatever it reports.
      if (treeHash(checkout) !== p.revision!.treeDigest) throw new WorkspaceError("CHECKOUT_CHANGED", `the runner modified the pinned checkout; its result is not recorded (log ${log.record.id}). Acquire the revision again.`, { log: log.record.id, writes: log.writes });
      const extraction = JSON.parse(text) as CapabilityExtraction;
      if (extraction.source?.revision !== p.revision!.sha) throw new WorkspaceError("REVISION_MISMATCH", `the extraction is of ${extraction.source?.revision}, not ${p.revision!.sha}`);
      const { record: artifact, writes } = await this.existingOrWrite(p, "extraction", extraction, run, {
        digest: extraction.digest,
        format: extraction.format,
        summary: { identity: `${extraction.identity.name} revision ${extraction.identity.revision}`, planDirectory: planDigest, runnerExit: result.exitCode, ...extraction.verification.summary, log: log.record.id }
      });
      return { writes: [...log.writes, ...writes, this.consume(approval, run)], current: { extraction: artifact.id }, evidence: [artifact.id, extraction.digest, approval.id], note: `${extraction.identity.name} revision ${extraction.identity.revision}: ${extraction.verification.summary.passed} of ${extraction.verification.records.length} behaviors passed (runner exit ${result.exitCode})` };
    });
  }

  /** Why the current verification no longer holds; empty when it is fresh or when there is none. */
  async verificationFreshness(principal: Principal, id: string): Promise<string[]> {
    await requireAllowed(this.authority, principal, "project.read", { project: id });
    const p = await this.load(id);
    const v = p.current.verification ? await this.store.get<VerificationRecord>("Verification", p.current.verification) : undefined;
    return v ? (await this.freshness(p, v)).map((r) => r.message) : [];
  }

  /** Why a verification no longer holds, if it does not: every input it was made for must still be current. */
  private async freshness(p: Project, v: VerificationRecord): Promise<Reason[]> {
    const out: Reason[] = [];
    if (!p.revision || p.revision.sha !== v.revision) out.push({ code: "VERIFICATION_STALE", message: "the project is pinned to another revision" });
    else {
      const checkout = this.store.resolve(p.revision.checkout);
      if (treeHash(checkout) !== v.treeDigest) out.push({ code: "VERIFICATION_STALE", message: "the checkout changed since verification" });
    }
    const assessment = p.current.assessment ? await this.store.get<ArtifactRecord>("Artifact", p.current.assessment) : undefined;
    if (assessment?.digest !== v.assessmentDigest) out.push({ code: "VERIFICATION_STALE", message: "the assessment changed since verification" });
    const extraction = p.current.extraction ? await this.store.get<ArtifactRecord>("Artifact", p.current.extraction) : undefined;
    if (extraction?.digest !== v.extractionDigest) out.push({ code: "VERIFICATION_STALE", message: "the extraction changed since verification" });
    try {
      const selection = await this.selection(p);
      if (directoryDigest(this.entryFor(selection.candidate).directory) !== v.planDigest) out.push({ code: "VERIFICATION_STALE", message: "the extraction's plan, adapter or suite changed since verification" });
    } catch (error) {
      out.push({ code: "VERIFICATION_STALE", message: (error as Error).message });
    }
    return out;
  }

  /**
   * Verifies the executed extraction with the extraction library, against the assessment, the pinned checkout and the
   * adapter sources, and records whether every required behavior passed for exactly this subject. Then re-reconciles:
   * a verified extraction is the evidence that confirms its match.
   */
  verify(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "verify", { stage: startsFrom("verify"), resuming }, async ({ project: p, run }) => {
      const checkout = this.store.resolve(p.revision!.checkout);
      const x = await this.body<CapabilityExtraction>(p.current.extraction, "extraction");
      const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
      const selection = await this.selection(p);
      const entry = this.entryFor(selection.candidate);
      const integrity = verifyExtractionAt(x.body, { assessment: assessment.body, repository: checkout, planDirectory: entry.directory });
      const records = x.body.verification.records;
      const s = x.body.verification.summary;
      const reasons: Reason[] = [];
      const treeDigest = treeHash(checkout);
      const checkoutUnchanged = treeDigest === p.revision!.treeDigest && gitIdentity(checkout).revision === p.revision!.sha;
      if (!integrity.ok) reasons.push({ code: "EXTRACTION_INVALID", message: integrity.findings.map((f) => f.code).join(", ") });
      if (x.body.source.revision !== p.revision!.sha) reasons.push({ code: "REVISION_MISMATCH", message: `the extraction is of ${x.body.source.revision}` });
      if (x.body.assessment.digest !== assessment.body.digest) reasons.push({ code: "VERIFICATION_STALE", message: "the extraction names another assessment" });
      if (x.body.assessment.candidate.id !== selection.candidate) reasons.push({ code: "SELECTION_MISMATCH", message: `the extraction is of ${x.body.assessment.candidate.id}, not the selected ${selection.candidate}` });
      if (!checkoutUnchanged) reasons.push({ code: "CHECKOUT_CHANGED", message: "the pinned checkout changed during or after the run" });
      if (s.passed !== records.length) reasons.push({ code: "BEHAVIORS_NOT_PASSED", message: `${records.length - s.passed} of ${records.length} required behaviors did not pass` });
      const planDigest = String(x.record.summary.planDirectory ?? "");
      if (planDigest !== directoryDigest(entry.directory)) reasons.push({ code: "VERIFICATION_STALE", message: "the extraction's plan directory changed since it ran" });
      const verification: VerificationRecord = {
        id: `${id}.verification.${run.attempt}.${sha256(run.id).slice(0, 8)}`,
        projectId: id,
        at: this.iso(),
        extraction: x.record.id,
        extractionDigest: x.body.digest,
        assessmentDigest: assessment.body.digest,
        planDigest,
        treeDigest,
        revision: p.revision!.sha,
        status: reasons.length ? "not-verified" : "verified",
        integrity: { ok: integrity.ok, findings: integrity.findings.map((f) => ({ code: f.code, path: f.path, message: f.message })) },
        behaviors: { required: records.length, passed: s.passed, failed: s.failed, inconclusive: s.inconclusive, notRun: s["not-run"], againstReal: records.filter((r) => r.status === "passed" && r.against === "real-application").length, againstStub: records.filter((r) => r.status === "passed" && r.against === "stub-application").length },
        records: records.map((r) => ({ behavior: r.behavior, status: r.status, ...(r.against ? { against: r.against } : {}) })),
        checkoutUnchanged,
        reasons
      };
      // The inventory, with this verification as evidence.
      const discovery = await this.body<DiscoveryRecord>(p.current.discovery, "discovery");
      const binding: ExtractionBinding = { candidate: x.body.assessment.candidate.id, capability: { name: x.body.contract.capability.name, version: x.body.contract.capability.version }, extraction: `${x.body.identity.name} revision ${x.body.identity.revision}`, extractionDigest: x.body.digest, verified: verification.status === "verified", detail: verification.status === "verified" ? `${s.passed} of ${records.length} behaviors passed (${verification.behaviors.againstReal} against the real application), declaration published and valid` : `not verified: ${reasons.map((r) => r.code).join(", ")}` };
      const inventory: InventoryRecord = reconcile({ assessment: assessment.body, discovery: discovery.body, bindings: [binding], decisions: await this.decisions(id) });
      const inv = await this.existingOrWrite(p, "inventory", inventory, run, { format: inventory.format, partial: inventory.partial.map((r) => r.code), summary: inventory.summary });
      return {
        writes: [{ collection: "Verification", id: verification.id, value: verification as never, create: true }, ...inv.writes],
        current: { verification: verification.id, inventory: inv.record.id },
        partial: verification.status === "verified" ? [] : reasons,
        evidence: [verification.id, inv.record.id],
        note: `${verification.status}: ${s.passed} of ${records.length} behaviors passed`
      };
    });
  }

  /** Marks a verified, still-fresh extraction ready for promotion. Deploys nothing and approves nothing. */
  ready(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "ready", { stage: startsFrom("ready"), resuming }, async ({ project: p }) => {
      const v = p.current.verification ? await this.store.get<VerificationRecord>("Verification", p.current.verification) : undefined;
      if (!v) throw new WorkspaceError("EVIDENCE_MISSING", "nothing was verified");
      if (v.status !== "verified") throw new WorkspaceError("NOT_VERIFIED", `the extraction did not verify: ${v.reasons.map((r) => r.code).join(", ")}`);
      const stale = await this.freshness(p, v);
      if (stale.length) throw new WorkspaceError("VERIFICATION_STALE", stale.map((r) => r.message).join("; "));
      const promotion = { id: `${id}.promotion.${v.id.split(".").pop()}`, projectId: id, kind: "promotion-status", status: "ready", verification: v.id, extractionDigest: v.extractionDigest, at: this.iso(), deployed: false, approval: "promote: not granted", note: "Ready for promotion means verified and fresh. Promotion is a separate action that needs its own approval; this workspace has no deployment contract and deploys nothing." };
      return { writes: [{ collection: "Decision", id: promotion.id, value: promotion as never, create: true }], current: { promotion: promotion.id }, evidence: [promotion.id, v.id], note: "ready for promotion (not deployed, not approved for production)" };
    });
  }

  /** Cancels the project. Terminal: a running step's result is kept on its run and not applied. */
  async cancel(principal: Principal, id: string, reason: string): Promise<Project> {
    await requireAllowed(this.authority, principal, "project.cancel", { project: id });
    const p = await this.load(id);
    if (p.condition.state === "cancelled") return p;
    const at = this.iso();
    const next: Project = { ...p, condition: { state: "cancelled", reasons: [...p.condition.reasons, { code: "CANCELLED", message: reason || "cancelled", stage: p.stage }] }, updatedAt: at, history: p.history + 1 };
    const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: "cancel", from: p.stage, to: p.stage, condition: "cancelled", at, actor: principal.id, evidence: [], reasons: [{ code: "CANCELLED", message: reason || "cancelled" }] };
    await this.store.commit([
      { collection: "Project", id, value: next as never, ifVersion: p.__version },
      { collection: "StageEvent", id: event.id, value: event as never, create: true }
    ]);
    return this.load(id);
  }

  /**
   * Resumes a failed project, or one whose run's worker died: re-runs exactly the step that did not finish, with the
   * inputs it was started with. Steps that completed are never repeated, and an action whose external effect was
   * recorded is not performed again.
   */
  async resume(principal: Principal, id: string): Promise<Started> {
    await requireAllowed(this.authority, principal, "project.advance", { project: id });
    const p = await this.load(id);
    let step: string | undefined;
    let input: Record<string, unknown> | undefined;
    if (p.condition.state === "failed" && p.failure) {
      step = p.failure.step;
      input = ((await this.store.get<Run>("Run", p.failure.run)) as (Run & { input?: Record<string, unknown> }) | undefined)?.input;
    } else if (p.activeRun) {
      const run = (await this.store.get<Run>("Run", p.activeRun)) as (Run & { input?: Record<string, unknown> }) | undefined;
      if (run && run.status === "running" && run.leaseExpiresAt > this.iso()) throw new WorkspaceError("STEP_IN_PROGRESS", `${run.step} is still running (${run.id})`);
      step = run?.step;
      input = run?.input;
    }
    if (!step) throw new WorkspaceError("NOTHING_TO_RESUME", "the project is neither failed nor holding an interrupted run");
    return this.dispatch(principal, id, step, input ?? {}, true);
  }

  /** Starts a step or action by name: the one table the CLI, the web API and resume all go through. */
  dispatch(principal: Principal, id: string, step: string, input: Record<string, unknown>, resuming = false): Promise<Started> {
    const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
    switch (step) {
      case "acquire":
        return this.acquire(principal, id, resuming);
      case "pin":
        return this.pin(principal, id, resuming);
      case "inspect":
        return this.inspect(principal, id, resuming);
      case "discover":
        return this.discover(principal, id, s("endpoint") ? { endpoint: s("endpoint")! } : {}, resuming);
      case "assess":
        return this.assess(principal, id, resuming);
      case "reconcile":
        return this.reconcile(principal, id, resuming);
      case "select":
        return this.select(principal, id, { candidate: s("candidate") ?? "", ...(s("rationale") ? { rationale: s("rationale")! } : {}) }, resuming);
      case "plan":
        return this.plan(principal, id, resuming);
      case "request-approval":
        return this.requestApproval(principal, id, resuming);
      case "execute":
        return this.execute(principal, id, resuming);
      case "verify":
        return this.verify(principal, id, resuming);
      case "ready":
        return this.ready(principal, id, resuming);
      case "propose-contract":
        return this.proposeContract(principal, id, resuming);
      case "adopt-contract":
        return this.adoptContract(principal, id, resuming);
      case "propose-promotion":
        return this.proposePromotion(principal, id, resuming);
      case "apply-promotion":
        return this.applyPromotion(principal, id, resuming);
      case "verify-promotion":
        return this.verifyPromotion(principal, id, resuming);
      case "prepare-review":
        return this.prepareReview(principal, id, resuming);
      case "submit-review":
        return this.submitReview(principal, id);
      case "commit":
        return this.commitPromotion(principal, id, resuming);
      case "pull-request":
        if (!s("head") && !s("base")) return this.submitReview(principal, id);
        return this.pullRequest(principal, id, { head: s("head") ?? "", base: s("base") ?? "", ...(s("title") ? { title: s("title")! } : {}) }, resuming);
      case "push":
      case "promote":
        return this.unsupportedAction(principal, id, step as ApprovalAction);
      default:
        return Promise.reject(new WorkspaceError("INVALID_INPUT", `unknown step ${step}`));
    }
  }

  // ---- contract adoption and promotion -------------------------------------------------------------------------

  /** The promotion record of the project's current promotion artifact, if there is one. */
  private async currentPromotion(p: Project): Promise<(PromotionRecord & { __version: number }) | undefined> {
    const record = p.current.promotionArtifact ? await this.store.get<ArtifactRecord>("Artifact", p.current.promotionArtifact) : undefined;
    return record?.digest ? this.store.get<PromotionRecord>("Promotion", `${p.id}.promotion.${record.digest.slice(7, 23)}`) : undefined;
  }

  /** Everything a contract-adoption proposal is made from, as it is now. */
  private async adoptionInputs(p: Project) {
    const x = await this.body<CapabilityExtraction>(p.current.extraction, "extraction");
    const assessment = await this.body<ApplicationAssessment>(p.current.assessment, "assessment");
    const discovery = await this.body<DiscoveryRecord>(p.current.discovery, "discovery");
    const inventory = await this.body<InventoryRecord>(p.current.inventory, "inventory");
    const selection = await this.selection(p);
    const entry = this.entryFor(selection.candidate);
    const candidate = assessment.body.candidates.find((c) => c.id === selection.candidate);
    if (!candidate) throw new WorkspaceError("CANDIDATE_NOT_FOUND", `${selection.candidate} is not in the current assessment`);
    const planned = JSON.parse(readFileSync(entry.planPath, "utf8")) as { contract: string; fulfillment?: { declaration: string } };
    const readJson = (path: string | undefined) => {
      if (!path) return undefined;
      try {
        return JSON.parse(readFileSync(join(entry.directory, path), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    };
    let dispositions = {};
    try {
      dispositions = readPromotionPlan(entry).plan.adoption?.questions ?? {};
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === "PROMOTION_PLAN_MISSING")) throw error;
    }
    return {
      entry,
      input: {
        extraction: x.body,
        candidate,
        contract: readJson(planned.contract),
        declaration: readJson(planned.fulfillment?.declaration),
        discovery: discovery.body,
        matches: inventory.body.candidates.find((c) => c.id === candidate.id)?.matches.map((m) => m.capability) ?? [],
        dispositions
      }
    };
  }

  /**
   * Proposes adopting the verified extraction's contract into the target integration: every difference with what
   * supports it, the open questions, and AppPort's validation. Blocking items keep the project partial and the proposal
   * unapprovable.
   */
  proposeContract(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "propose-contract", { stage: startsFrom("propose-contract"), resuming }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const v = p.current.verification ? await this.store.get<VerificationRecord>("Verification", p.current.verification) : undefined;
      if (!v || v.status !== "verified") throw new WorkspaceError("NOT_VERIFIED", "only a verified extraction's contract can be proposed for adoption");
      const stale = await this.freshness(p, v);
      if (stale.length) throw new WorkspaceError("VERIFICATION_STALE", stale.map((r) => r.message).join("; "));
      const { input } = await this.adoptionInputs(p);
      const adoption = proposeAdoption(input);
      const { record, writes } = await this.existingOrWrite(p, "adoption", adoption, run, { digest: adoption.digest, format: adoption.format, partial: adoption.blocking.map((b) => b.code), summary: { contract: `${adoption.contract.application} ${adoption.contract.capability}@${adoption.contract.version}`, differences: adoption.differences.length, blocking: adoption.blocking.length } });
      const partial: Reason[] = adoption.blocking.length ? [{ code: "ADOPTION_BLOCKED", message: `${adoption.blocking.length} blocking items: ${adoption.blocking.map((b) => `${b.code} ${b.subject}`).join("; ")}` }] : [];
      return { writes, current: { adoption: record.id }, partial, evidence: [record.id, adoption.digest], note: `contract adoption proposed: ${adoption.differences.length} differences, ${adoption.blocking.length} blocking` };
    });
  }

  /** Adopts exactly the approved proposal, after re-deriving it: inputs that changed since make it stale. */
  adoptContract(principal: Principal, id: string, resuming = false): Promise<Started> {
    const current = async (p: Project) => {
      const stored = await this.body<ContractAdoption>(p.current.adoption, "contract-adoption proposal");
      const problems = adoptionProblems(stored.body);
      if (problems.length) throw new WorkspaceError(problems[0]!, "the stored adoption proposal does not match its digest");
      if (stored.body.blocking.length) throw new WorkspaceError("ADOPTION_BLOCKED", `the proposal has ${stored.body.blocking.length} blocking items: ${stored.body.blocking.map((b) => `${b.code} ${b.subject}`).join("; ")}`);
      const again = proposeAdoption((await this.adoptionInputs(p)).input);
      if (again.digest !== stored.body.digest) throw new WorkspaceError("ADOPTION_STALE", "the contract, declaration, extraction, discovery or dispositions changed since the proposal; propose again");
      return stored;
    };
    const guard = async (p: Project) => {
      const stored = await current(p);
      await this.requireApproval(principal, p, STEPS["adopt-contract"]!.approval!, stored.body.digest);
    };
    return this.begin(principal, id, "adopt-contract", { stage: startsFrom("adopt-contract"), resuming, guard }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const stored = await current(p);
      const approval = await this.requireApproval(principal, p, STEPS["adopt-contract"]!.approval!, stored.body.digest);
      const decision = { id: `${id}.adoption.${stored.body.digest.slice(7, 19)}`, projectId: id, kind: "contract-adoption", at: this.iso(), by: principal.id, adoption: stored.record.id, adoptionDigest: stored.body.digest, approval: approval.id, contract: stored.body.contract, note: "Adopted into the target's integration as proposed. It grants no authority, registers nothing and is not an equivalence claim." };
      const exists = await this.store.get("Decision", decision.id);
      return { writes: [...(exists ? [] : [{ collection: "Decision" as const, id: decision.id, value: decision as never, create: true as const }]), this.consume(approval, run)], current: { adoptionDecision: decision.id }, evidence: [decision.id, stored.body.digest, approval.id], note: `adopted ${stored.body.contract.application} ${stored.body.contract.capability}@${stored.body.contract.version}` };
    });
  }

  /** The promotion artifact: deterministic, from the reviewed promotion plan, the verified extraction and the adoption. */
  proposePromotion(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "propose-promotion", { stage: startsFrom("propose-promotion"), resuming }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const decision = p.current.adoptionDecision ? await this.store.get<{ adoptionDigest: string }>("Decision", p.current.adoptionDecision) : undefined;
      const adoption = await this.body<ContractAdoption>(p.current.adoption, "contract-adoption proposal");
      if (!decision || decision.adoptionDigest !== adoption.body.digest) throw new WorkspaceError("CONTRACT_NOT_ADOPTED", "the current contract-adoption proposal has not been adopted");
      const x = await this.body<CapabilityExtraction>(p.current.extraction, "extraction");
      const entry = this.entryFor((await this.selection(p)).candidate);
      const promotion = buildPromotion({ project: id, checkout: this.store.resolve(p.revision!.checkout), repository: { url: p.repository.url, owner: p.repository.owner, name: p.repository.name }, revision: p.revision!.sha, entry, extraction: x.body, adoptionDigest: adoption.body.digest });
      const { record, writes } = await this.existingOrWrite(p, "promotion", promotion, run, { digest: promotion.digest, format: promotion.format, summary: { files: promotion.target.files.map((f) => f.path), directory: promotion.target.directory } });
      const promotionId = `${id}.promotion.${promotion.digest.slice(7, 23)}`;
      const at = this.iso();
      const existing = await this.store.get<PromotionRecord>("Promotion", promotionId);
      const state: PromotionRecord = { id: promotionId, projectId: id, artifact: record.id, digest: promotion.digest, state: "proposed", worktree: join("workspaces", id, p.revision!.sha, "promotions", promotion.digest.slice(7, 23), "worktree"), base: p.revision!.sha, createdAt: at, updatedAt: at };
      const unmet = promotion.requirements.packages.filter((r) => !r.met);
      const partial: Reason[] = unmet.length ? [{ code: "REQUIREMENT_UNMET", message: `the target pins ${unmet.map((r) => `${r.name} ${r.target ?? "(absent)"}`).join(", ")} in ${promotion.requirements.lockfile}; the promoted host was verified with ${unmet.map((r) => `${r.name} ${r.required}`).join(", ")}. The patch does not change the target's dependencies` }] : [];
      return { writes: [...writes, ...(existing ? [] : [{ collection: "Promotion" as const, id: promotionId, value: state as never, create: true as const }])], current: { promotionArtifact: record.id }, partial, evidence: [record.id, promotion.digest], note: `promotion proposed: ${promotion.target.files.length} files under ${promotion.target.directory}${unmet.length ? `; ${unmet.length} runtime requirements unmet in the target` : ""}` };
    });
  }

  /** The stored promotion artifact, valid against everything it names as it is now. */
  private async validPromotion(p: Project): Promise<{ promotion: Promotion; record: ArtifactRecord; state: PromotionRecord & { __version: number }; entry: ExtractionEntry }> {
    const stored = await this.body<Promotion>(p.current.promotionArtifact, "promotion artifact");
    const state = await this.currentPromotion(p);
    if (!state) throw new WorkspaceError("EVIDENCE_MISSING", "the promotion has no record");
    const x = await this.store.get<ArtifactRecord>("Artifact", p.current.extraction!);
    const adoption = await this.store.get<ArtifactRecord>("Artifact", p.current.adoption!);
    const entry = this.entryFor((await this.selection(p)).candidate);
    const problems = promotionProblems(stored.body, { revision: p.revision?.sha, extractionDigest: x?.digest, adoptionDigest: adoption?.digest, extractionDirectory: entry.directory });
    if (problems.length) throw new WorkspaceError(problems[0]!.code, problems.map((r) => `${r.code}: ${r.message}`).join("; "), { reasons: problems });
    return { promotion: stored.body, record: stored.record, state, entry };
  }

  /** The worktree holds exactly the recorded patch on its base, and nothing else. */
  private async inspectApplied(worktree: string, promotion: Promotion): Promise<Reason[]> {
    const state = await worktreeState(worktree);
    const approved = new Set(promotion.target.files.map((f) => f.path));
    const out: Reason[] = [];
    if (state.head !== promotion.target.base) out.push({ code: "WORKTREE_REVISION_CHANGED", message: `the worktree is at ${state.head ?? "no revision"}, not ${promotion.target.base}` });
    for (const e of state.entries) if (!approved.has(e.path)) out.push({ code: "PATCH_OUTSIDE_APPROVED_SET", message: `${e.path} (${e.status.trim()}) is not in the approved file set` });
    for (const e of state.entries) if (approved.has(e.path) && !["??", "A "].includes(e.status)) out.push({ code: "PATCH_OPERATION_INVALID", message: `${e.path} is ${e.status.trim()}, not an added file` });
    const digests = worktreeFileDigests(worktree, [...approved]);
    for (const f of promotion.target.files) if (digests[f.path] !== f.sha256) out.push({ code: digests[f.path] ? "PATCH_CONTENT_MISMATCH" : "PATCH_INCOMPLETE", message: `${f.path} ${digests[f.path] ? "differs from" : "is missing, not"} the approved file` });
    return out;
  }

  /**
   * Applies exactly the approved promotion to an isolated worktree. Before writing: the approval of this artifact's
   * digest, the artifact valid against everything it names, the pinned checkout unchanged, the destination holding
   * nothing unexpected, and the authority rechecked. After: the complete diff inspected, nothing outside the approved
   * files, revisions rechecked, the patch and its digest recorded. A resumed run inspects the worktree first and never
   * writes a file twice.
   */
  applyPromotion(principal: Principal, id: string, resuming = false): Promise<Started> {
    const action = STEPS["apply-promotion"]!.approval!;
    const guard = async (p: Project) => {
      const { promotion, state } = await this.validPromotion(p);
      if (!["proposed", "approved"].includes(state.state)) throw new WorkspaceError("INVALID_TRANSITION", `the promotion is ${state.state}`);
      await this.requireApproval(principal, p, action, promotion.digest);
    };
    return this.begin(principal, id, "apply-promotion", { stage: startsFrom("apply-promotion"), resuming, guard }, async ({ project: p, run }) => {
      const checkout = this.assertRevision(p);
      const { promotion, state, entry } = await this.validPromotion(p);
      const approval = await this.requireApproval(principal, p, action, promotion.digest);
      const worktree = this.store.resolve(state.worktree);
      const approved = new Set(promotion.target.files.map((f) => f.path));
      if (!existsSync(join(worktree, ".git"))) {
        await createPromotionWorktree({ destination: worktree, pinnedCheckout: checkout, canonicalUrl: p.repository.url, sha: promotion.target.base });
      }
      // The destination: at the base, and holding nothing but (a resumed run's) approved files with approved bytes.
      const before = await worktreeState(worktree);
      if (before.head !== promotion.target.base) throw new WorkspaceError("DESTINATION_DIRTY", `the worktree is at ${before.head ?? "no revision"}, not ${promotion.target.base}`);
      const unexpected = before.entries.filter((e) => !approved.has(e.path) || !["??", "A "].includes(e.status));
      if (unexpected.length) throw new WorkspaceError("DESTINATION_DIRTY", `the worktree has unexpected changes: ${unexpected.map((e) => `${e.status.trim()} ${e.path}`).join(", ")}`);
      await requireAllowed(this.authority, principal, `action:${action}`, { project: id });
      const { written, present } = writePromotionFiles(promotion, entry.directory, worktree);
      this.faultPoint?.("after-patch-written", { project: id, worktree });
      // The complete diff, as git sees it, against the base.
      const patch = await worktreePatch(worktree, promotion.target.base);
      const files = promotion.target.files.map((f) => ({ path: f.path, sha256: f.sha256, mode: f.mode }));
      const digest = patchDigest(promotion.target.base, files);
      const body = { format: "appworks.patch/1", promotion: promotion.digest, base: promotion.target.base, files, patchDigest: digest, diff: patch };
      const stored = await this.existingOrWrite(p, "patch", body, run, { digest, summary: { files: files.length, written: written.length, alreadyPresent: present.length } });
      const problems = await this.inspectApplied(worktree, promotion);
      this.assertRevision(p);
      if (problems.length) {
        // The patch and the evidence stay: the worktree is not cleaned up, and the patch as found is recorded.
        throw new WorkspaceError(problems[0]!.code, problems.map((r) => r.message).join("; "), { reasons: problems, writes: [...stored.writes, { collection: "Promotion", id: state.id, value: { ...state, patch: stored.record.id, reasons: problems, updatedAt: this.iso() }, ifVersion: state.__version }] });
      }
      const at = this.iso();
      return {
        writes: [...stored.writes, { collection: "Promotion", id: state.id, value: { ...state, state: "applied", approval: approval.id, appliedAt: state.appliedAt ?? at, patch: stored.record.id, patchDigest: digest, files, updatedAt: at, reasons: [] } as never, ifVersion: state.__version }, this.consume(approval, run)],
        current: { patch: stored.record.id },
        evidence: [stored.record.id, digest, approval.id],
        note: `applied ${files.length} files to the isolated worktree (${written.length} written, ${present.length} already present); patch ${digest}`
      };
    });
  }

  /**
   * Runs the promotion's verification against the applied worktree and judges it: the subject the promoted copy
   * produced must be exactly the extraction's, every required behavior must pass against what it passed against
   * before, every mutant must be caught, and the worktree must be the patch before and after.
   */
  verifyPromotion(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "verify-promotion", { stage: startsFrom("verify-promotion"), resuming }, async ({ project: p, run, signal }) => {
      this.assertRevision(p);
      const { promotion, state, entry } = await this.validPromotion(p);
      if (!["applied", "verified", "verification-failed", "ready-for-review"].includes(state.state) || !state.patchDigest) throw new WorkspaceError("INVALID_TRANSITION", `the promotion is ${state.state}, not applied`);
      const approval = state.approval ? await this.store.get<ApprovalRecord>("Approval", state.approval) : undefined;
      if (!approval || approval.status !== "consumed" || approval.subject !== promotion.digest) throw new WorkspaceError("APPROVAL_REQUIRED", "the applied patch was not applied under an approval of this promotion");
      const worktree = this.store.resolve(state.worktree);
      const before = await this.inspectApplied(worktree, promotion);
      if (before.length) throw new WorkspaceError("WORKTREE_CHANGED", before.map((r) => r.message).join("; "), { reasons: before });
      const work = join(tmpdir(), `appworks-promotion-${run.id.replace(/[^A-Za-z0-9_-]/g, "_")}`);
      mkdirSync(work, { recursive: true });
      const output = join(work, "verification.json");
      const result = await runPromotionVerification(entry, promotion.verification.runner.path, { worktree, host: join(worktree, promotion.verification.host), output, mutations: promotion.verification.mutations, signal, ...(this.runnerTimeoutMs ? { timeoutMs: this.runnerTimeoutMs } : {}) });
      const log = await this.existingOrWrite(p, "promotion-log", { format: "appworks.runner-log/1", runner: promotion.verification.runner.path, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, output: result.output }, run, { summary: { exitCode: result.exitCode } });
      let summary: { results?: { subject: Record<string, string>; behaviors: Record<string, { status: string; against?: string }> }; worktreeUnchanged?: boolean; mutations?: { caught: number; total: number } | null };
      try {
        summary = JSON.parse(readFileSync(output, "utf8"));
      } catch {
        throw new WorkspaceError(signal.aborted ? "RUN_CANCELLED" : "RUNNER_FAILED", `the promotion verification runner exited ${result.exitCode ?? result.signal} without results; see ${log.record.id}`, { writes: log.writes });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      const after = await this.inspectApplied(worktree, promotion);
      const reasons: Reason[] = [...after.map((r) => ({ ...r, code: "WORKTREE_CHANGED" }))];
      const results = summary.results;
      if (!results) reasons.push({ code: "RESULTS_MISSING", message: "the runner recorded no behavior results (the promoted host is not a verified copy, or the suite did not run)" });
      else {
        for (const [k, v] of Object.entries(promotion.verification.subject)) if (results.subject[k] !== v) reasons.push({ code: "SUBJECT_MISMATCH", message: `${k} is ${results.subject[k]}, the verified extraction's is ${v}` });
        for (const b of promotion.verification.required) {
          const r = results.behaviors[b];
          if (!r || r.status !== "passed") reasons.push({ code: "BEHAVIOR_NOT_PASSED", message: `${b}: ${r?.status ?? "not run"}` });
          else if (r.against !== promotion.verification.against[b]) reasons.push({ code: "BEHAVIOR_TARGET_CHANGED", message: `${b} passed against ${r.against}, the extraction's against ${promotion.verification.against[b]}` });
        }
      }
      if (promotion.verification.mutations && !(summary.mutations && summary.mutations.total > 0 && summary.mutations.caught === summary.mutations.total)) reasons.push({ code: "MUTANT_SURVIVED", message: summary.mutations ? `${summary.mutations.caught} of ${summary.mutations.total} mutants caught` : "the mutation check did not run" });
      if (summary.worktreeUnchanged !== true) reasons.push({ code: "WORKTREE_CHANGED", message: "the runner reports the worktree changed during verification" });
      const status = reasons.length ? "not-verified" : "verified";
      const record = { format: "appworks.promotion-verification/1", promotion: promotion.digest, patchDigest: state.patchDigest, status, reasons, results: results ?? null, mutations: summary.mutations ?? null, runner: { exitCode: result.exitCode, log: log.record.id } };
      const stored = await this.existingOrWrite(p, "promotion-verification", record, run, { digest: digestOf(record), summary: { status, reasons: reasons.length } });
      const at = this.iso();
      return {
        writes: [...log.writes, ...stored.writes, { collection: "Promotion", id: state.id, value: { ...state, state: status === "verified" ? "verified" : "verification-failed", verification: stored.record.id, verificationStatus: status, reasons, updatedAt: at } as never, ifVersion: state.__version }],
        current: { promotionVerification: stored.record.id },
        partial: status === "verified" ? [] : [{ code: "PROMOTION_NOT_VERIFIED", message: reasons.map((r) => `${r.code}: ${r.message}`).join("; ") }],
        evidence: [stored.record.id, log.record.id],
        note: `promotion ${status}${reasons.length ? `: ${reasons.length} reasons` : ""}`
      };
    });
  }

  /** Marks a verified promotion ready for review, after re-checking that every input is still what was verified. */
  prepareReview(principal: Principal, id: string, resuming = false): Promise<Started> {
    return this.begin(principal, id, "prepare-review", { stage: startsFrom("prepare-review"), resuming }, async ({ project: p }) => {
      this.assertRevision(p);
      const { promotion, state } = await this.validPromotion(p);
      if (state.state !== "verified") throw new WorkspaceError("NOT_VERIFIED", `the promotion is ${state.state}${state.reasons?.length ? `: ${state.reasons.map((r) => r.code).join(", ")}` : ""}`);
      const verification = await this.body<{ promotion: string; patchDigest: string; status: string }>(p.current.promotionVerification, "promotion verification");
      if (verification.body.promotion !== promotion.digest || verification.body.patchDigest !== state.patchDigest || verification.body.status !== "verified") throw new WorkspaceError("VERIFICATION_STALE", "the promotion verification is for another promotion or patch");
      const changed = await this.inspectApplied(this.store.resolve(state.worktree), promotion);
      if (changed.length) throw new WorkspaceError("WORKTREE_CHANGED", changed.map((r) => r.message).join("; "));
      return { writes: [{ collection: "Promotion", id: state.id, value: { ...state, state: "ready-for-review", updatedAt: this.iso() } as never, ifVersion: state.__version }], current: { review: state.id }, evidence: [state.id, state.patchDigest!], note: `ready for review: patch ${state.patchDigest}` };
    });
  }

  /**
   * Commits the reviewed patch on a local branch of the isolated worktree, under an approval of exactly that patch. A
   * commit that is already there (a resumed run) is found and adopted, never made twice. Nothing is pushed.
   */
  commitPromotion(principal: Principal, id: string, resuming = false): Promise<Started> {
    const subject = async (p: Project) => (await this.approvalSubject(principal, id, "commit")).subject;
    const guard = async (p: Project) => {
      const state = await this.currentPromotion(p);
      if (!state || state.state !== "ready-for-review") throw new WorkspaceError("INVALID_TRANSITION", "only a promotion that is ready for review can be committed");
      await this.requireApproval(principal, p, "commit", await subject(p));
    };
    return this.begin(principal, id, "commit", { stage: { from: ["ready-for-review"] }, resuming, guard }, async ({ project: p, run }) => {
      this.assertRevision(p);
      const { promotion, state } = await this.validPromotion(p);
      const approval = await this.requireApproval(principal, p, "commit", await subject(p));
      const worktree = this.store.resolve(state.worktree);
      const branch = `appworks/promotion/${promotion.capability.provider.capability}-${promotion.digest.slice(7, 19)}`;
      const head = (await worktreeState(worktree)).head;
      let commit: string;
      if (head && head !== promotion.target.base) {
        // A commit is already there: adopt it only if it is exactly this patch on this base, with nothing else.
        const info = await commitInfo(worktree, head);
        const status = await worktreeState(worktree);
        const digests = worktreeFileDigests(worktree, promotion.target.files.map((f) => f.path));
        const exact = info.parent === promotion.target.base && JSON.stringify([...info.paths].sort()) === JSON.stringify(promotion.target.files.map((f) => f.path).sort()) && status.entries.length === 0 && promotion.target.files.every((f) => digests[f.path] === f.sha256);
        if (!exact) throw new WorkspaceError("WORKTREE_CHANGED", `the worktree's HEAD ${head} is not the reviewed patch on ${promotion.target.base}`);
        commit = head;
      } else {
        const changed = await this.inspectApplied(worktree, promotion);
        if (changed.length) throw new WorkspaceError("WORKTREE_CHANGED", changed.map((r) => r.message).join("; "));
        await requireAllowed(this.authority, principal, "action:commit", { project: id });
        commit = await commitWorktree(worktree, { branch, date: state.appliedAt ?? this.iso(), message: `AppWorks: add ${promotion.capability.provider.capability}@${promotion.capability.provider.version} through the AppPort bridge\n\nPromotion ${promotion.digest}\nPatch ${state.patchDigest}\nExtraction ${promotion.extraction.identity.name} revision ${promotion.extraction.identity.revision} ${promotion.extraction.digest}\nContract ${promotion.capability.contract.application} ${promotion.capability.contract.capability}@${promotion.capability.contract.version} ${promotion.capability.contract.capabilityDigest}\n` });
        this.faultPoint?.("after-commit", { project: id, worktree });
      }
      return { writes: [{ collection: "Promotion", id: state.id, value: { ...state, commit, branch, updatedAt: this.iso() } as never, ifVersion: state.__version }, this.consume(approval, run)], effect: { commit, branch, adopted: head !== promotion.target.base }, evidence: [commit, approval.id], note: `committed ${commit} on local branch ${branch} (not pushed)` };
    });
  }

  /**
   * Submitting for review needs the branch on GitHub: a push, then a pull request. The boundary is enforced (an approval
   * of exactly this commit), then the action is refused: @appport/github has no push or commit contract, and the
   * workspace does not push with git behind the integration's back. Nothing is attempted.
   */
  async submitReview(principal: Principal, id: string): Promise<Started> {
    await requireAllowed(this.authority, principal, "project.advance", { project: id });
    const p = await this.load(id);
    const state = await this.currentPromotion(p);
    if (!state || state.state !== "ready-for-review" || !state.commit) throw new WorkspaceError("INVALID_TRANSITION", "submitting needs a promotion that is ready for review and committed");
    await this.requireApproval(principal, p, STEPS["submit-review"]!.approval!, (await this.approvalSubject(principal, id, "pull-request")).subject);
    throw new WorkspaceError("UNSUPPORTED", "submitting for review is approved but not supported: it needs the branch pushed to GitHub, and @appport/github 1.0.2 has no push, commit or compare contract");
  }

  // ---- gated actions -------------------------------------------------------------------------------------------

  /**
   * Opens a pull request through @appport/github (write capability, write credential), after an approval of exactly
   * this repository, revision, head and base. The effect is recorded on the run before and after the call, so a resumed
   * run adopts the pull request instead of opening another.
   */
  pullRequest(principal: Principal, id: string, input: { head: string; base: string; title?: string }, resuming = false): Promise<Started> {
    const branch = /^[A-Za-z0-9._/-]{1,200}$/;
    if (!branch.test(input.head) || !branch.test(input.base)) return Promise.reject(new WorkspaceError("INVALID_INPUT", "head and base are branch names"));
    const guard = async (p: Project) => {
      await this.requireApproval(principal, p, "pull-request", (await this.approvalSubject(principal, id, "pull-request", { head: input.head, base: input.base })).subject);
    };
    return this.begin(principal, id, "pull-request", { stage: { from: ["verification-completed", "ready-for-promotion"] }, input, resuming, guard }, async ({ project: p, run }) => {
      const { subject } = await this.approvalSubject(principal, id, "pull-request", { head: input.head, base: input.base });
      const approval = await this.requireApproval(principal, p, "pull-request", subject);
      const provider = this.providers[p.repository.provider];
      if (!provider?.createPullRequest) throw new WorkspaceError("UNSUPPORTED", `the ${p.repository.provider} provider cannot open pull requests`);
      // An earlier attempt that already opened it recorded the result: adopt it, never open a second.
      const earlier = (await this.store.list<Run>("Run", { projectId: id, step: "pull-request" })).find((r) => r.effect && (r.effect as { result?: unknown }).result && (r.effect as { subject?: string }).subject === subject);
      let result = earlier ? ((earlier.effect as { result: { number: number; url?: string; existing: boolean } }).result) : undefined;
      if (!result) {
        const r = await this.store.get<Run>("Run", run.id);
        await this.store.update("Run", run.id, r!.__version, { effect: { subject, intent: "pull-request", at: this.iso() } });
        const title = input.title ?? `AppWorks: ${input.head} into ${input.base} [appworks:${id}]`;
        result = await provider.createPullRequest(p.repository, { head: input.head, base: input.base, title, body: `Opened by the AppWorks workspace for ${p.repository.owner}/${p.repository.name} at ${p.revision?.sha ?? p.ref}, under approval ${approval.id}.` }, { principal, project: id, authority: this.authority, credentials: this.credentials });
        const r2 = await this.store.get<Run>("Run", run.id);
        await this.store.update("Run", run.id, r2!.__version, { effect: { subject, intent: "pull-request", result } });
      }
      return { writes: [this.consume(approval, run)], effect: { subject, intent: "pull-request", result }, evidence: [approval.id], note: `pull request #${result.number}${result.existing ? " (adopted)" : ""}` };
    });
  }

  /**
   * Commit, push, promote and integration changes: the boundary is enforced (authority and approval) and then the
   * action is refused, because no contract for it exists here. @appport/github has no commit or push operation, the
   * extraction writes nothing to the target repository, and there is no deployment contract. Nothing is attempted.
   */
  unsupportedAction(principal: Principal, id: string, action: ApprovalAction): Promise<Started> {
    const guard = async (p: Project) => {
      await this.requireApproval(principal, p, action, (await this.approvalSubject(principal, id, action)).subject);
    };
    return this.begin(principal, id, action, { stage: { from: [...STAGES] }, guard }, async ({ project: p }) => {
      const { subject } = await this.approvalSubject(principal, id, action);
      await this.requireApproval(principal, p, action, subject);
      const why: Record<string, string> = {
        commit: "the extraction writes nothing to the target repository, so there is nothing to commit; @appport/github has no commit contract",
        push: "@appport/github 1.0.2 has no push or commit contract, and the workspace does not push with git behind the integration",
        promote: "no deployment contract exists for this workspace; nothing is deployed",
        "modify-integration": "the extraction adds its capability through a host beside the unmodified bridge; changing the bridge in the target repository is not a supported action"
      };
      throw new WorkspaceError("UNSUPPORTED", `${action} is approved but not supported: ${why[action] ?? "no contract"}`);
    });
  }
}

