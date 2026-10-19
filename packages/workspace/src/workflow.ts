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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessRepository, gitIdentity, verifyAssessment, type ApplicationAssessment } from "@appport/assessment";
import { createExtraction, ExtractionRefused, observeCheckout, readPlan, verifyExtractionAt, type CapabilityExtraction } from "@appport/extraction";
import type { AppPortManifest } from "@appport/protocol";
import { requireAllowed, parseCredentialReference, type Authority, type CredentialResolver } from "./authority.js";
import { discoverCapabilities, type DiscoveryRecord } from "./discovery.js";
import { inspectIntegration, treeHash, type IntegrationRecord } from "./inspect.js";
import { APPROVAL_ACTIONS, MODEL, STAGES, STEPS, stagesAfter, WorkspaceError, type ApprovalAction, type ApprovalRecord, type ArtifactKind, type ArtifactRecord, type Principal, type Project, type Reason, type RepositoryIdentity, type Run, type Stage, type StageEvent, type StepName, type VerificationRecord } from "./model.js";
import { reconcile, type ExtractionBinding, type InventoryRecord, type MatchDecision } from "./reconcile.js";
import { acquireCheckout, type RepositoryProvider } from "./repository.js";
import { directoryDigest, listExtractions, runExtraction, type ExtractionEntry } from "./runner.js";
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
  runnerTimeoutMs?: number;
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

const digestOf = (value: unknown) => `sha256:${sha256(JSON.stringify(value))}`;

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
  private readonly runnerTimeoutMs: number | undefined;

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
    this.runnerTimeoutMs = options.runnerTimeoutMs;
  }

  static async open(options: WorkspaceOptions): Promise<Workspace> {
    return new Workspace(await Store.open(options.home), options);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private iso = () => this.now().toISOString();

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

  async records<T>(principal: Principal, collection: "StageEvent" | "Run" | "Artifact" | "Approval" | "Decision" | "Verification", projectId: string): Promise<T[]> {
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
    if (!input.ref || /\s|\.\.|^-/.test(input.ref)) throw new WorkspaceError("INVALID_INPUT", "a ref is a branch, tag or commit SHA");
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
    const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: (APPROVAL_ACTIONS as readonly string[]).includes(step) ? "action" : (step as StepName), from: p.stage, to: target, condition: next.condition.state, at, actor: principal.id, evidence: outcome.evidence ?? [], reasons: outcome.partial ?? [], ...(outcome.note ? { note: outcome.note } : {}) };
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
        const isAction = (APPROVAL_ACTIONS as readonly string[]).includes(step);
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
        revision: { sha: resolved.sha, ref: p.ref, pinnedAt: "", checkout, treeDigest: "", onDefaultBranch: resolved.onDefaultBranch, ...(resolved.defaultBranchSha ? { defaultBranchSha: resolved.defaultBranchSha } : {}) },
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
      const record = await discoverCapabilities({ ...(input.endpoint ? { endpoint: input.endpoint.replace(/\/$/, "") } : {}), integrationPresent: integration.body.status === "present", canonical: this.canonicalContracts(), now: this.now, ...(this.fetch ? { fetch: this.fetch } : {}) });
      const { record: artifact, writes } = await this.existingOrWrite(p, "discovery", record, run, { format: record.format, summary: { outcome: record.outcome, capabilities: record.capabilities.length } });
      const partial: Reason[] = record.outcome === "unavailable" ? [{ code: "DISCOVERY_UNAVAILABLE", message: record.note }] : [];
      return { writes, current: { discovery: artifact.id }, partial, evidence: [artifact.id], note: `${record.outcome}: ${record.capabilities.length} capabilities; nothing invoked` };
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
    if (action === "modify-integration") return { subject: digestOf({ action, revision: p.revision?.sha, integration: p.current.integration }), description: "Change the application's AppPort integration in the target repository." };
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
    const at = this.iso();
    const recordId = `${id}.approval.${input.action}.${current.subject.slice(7, 19)}`;
    const existing = await this.store.get<ApprovalRecord>("Approval", recordId);
    if (existing && existing.status === "granted") return existing;
    if (existing && existing.status === "consumed") throw new WorkspaceError("APPROVAL_CONSUMED", "this approval was already used; the action ran");
    const approval: ApprovalRecord = { ...(existing ?? { id: recordId, projectId: id, action: input.action, subject: current.subject, subjectDescription: current.description, requestedAt: at, requestedBy: principal.id }), status: "granted", grantedAt: at, grantedBy: principal.id } as ApprovalRecord;
    const event: StageEvent = { id: `${id}.${String(p.history).padStart(4, "0")}`, projectId: id, sequence: p.history, step: "approve", from: p.stage, to: p.stage, condition: p.condition.state, at, actor: principal.id, evidence: [recordId, current.subject], reasons: [], note: `approved ${input.action}` };
    await this.store.commit([
      existing ? { collection: "Approval", id: recordId, value: approval as never, ifVersion: (existing as ApprovalRecord & { __version: number }).__version } : { collection: "Approval", id: recordId, value: approval as never, create: true },
      { collection: "Project", id, value: { ...p, updatedAt: at, history: p.history + 1 } as never, ifVersion: p.__version },
      { collection: "StageEvent", id: event.id, value: event as never, create: true }
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
      case "pull-request":
        return this.pullRequest(principal, id, { head: s("head") ?? "", base: s("base") ?? "", ...(s("title") ? { title: s("title")! } : {}) }, resuming);
      case "commit":
      case "push":
      case "promote":
      case "modify-integration":
        return this.unsupportedAction(principal, id, step as ApprovalAction);
      default:
        return Promise.reject(new WorkspaceError("INVALID_INPUT", `unknown step ${step}`));
    }
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
        push: "@appport/github has no push contract and the workspace pushes nothing itself",
        promote: "no deployment contract exists for this workspace; nothing is deployed",
        "modify-integration": "the extraction adds its capability through a host beside the unmodified bridge; changing the bridge in the target repository is not a supported action"
      };
      throw new WorkspaceError("UNSUPPORTED", `${action} is approved but not supported: ${why[action] ?? "no contract"}`);
    });
  }
}

