import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localAuthority, treeHash, Workspace, WorkspaceError, type ApprovalRecord, type Project, type Run, type StageEvent } from "../src/index.js";
import { ADVANCER, advanceMain, advanceTo, CANDIDATE, extractionsRoot, notesRepository, openWorkspace, OPERATOR, recordingProvider, sideBranch, step, VIEWER } from "./helpers.js";
import { gitProvider } from "../src/index.js";

const refusal = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error, `expected ${code}`).toBeInstanceOf(WorkspaceError);
  expect((error as WorkspaceError).code).toBe(code);
  return error as WorkspaceError;
};

describe("the workflow, end to end on the synthetic notes service (stub runner)", () => {
  it("pins, inspects, discovers, assesses, reconciles, selects, plans, waits for approval, executes, verifies and becomes ready", async () => {
    const { mirror, sha, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "ready");
      const p = await ws.project(OPERATOR, id);
      expect(p.stage).toBe("ready-for-promotion");
      expect(p.revision!.sha).toBe(sha);
      expect(p.revision!.onDefaultBranch).toBe("yes");
      // discovery without an endpoint, for a revision without an AppPort integration, is explicit
      const discovery = await ws.artifact<{ outcome: string }>(OPERATOR, p.current.discovery);
      expect(discovery!.body.outcome).toBe("no-integration");
      // every stage was recorded, in order, by the actor
      const events = (await ws.records<StageEvent>(OPERATOR, "StageEvent", id)).sort((a, b) => a.sequence - b.sequence);
      expect(events.map((e) => e.to).filter((s, i, all) => all.indexOf(s) === i)).toEqual(["project-selected", "repository-acquired", "revision-pinned", "integration-inspected", "capabilities-discovered", "assessment-completed", "inventory-reconciled", "candidate-selected", "extraction-planned", "awaiting-approval", "extraction-executed", "verification-completed", "ready-for-promotion"]);
      // the approval was consumed by the execution run, exactly once
      const approvals = await ws.records<ApprovalRecord>(OPERATOR, "Approval", id);
      expect(approvals.map((a) => [a.action, a.status])).toEqual([["generate-files", "consumed"]]);
      expect(approvals[0]!.consumedBy).toMatch(/\.execute\.1$/);
      // the extraction's match is confirmed in the inventory recomputed at verification
      const inventory = await ws.artifact<{ capabilities: Array<{ name: string; status: string; candidates: Array<{ id: string }> }> }>(OPERATOR, p.current.inventory);
      const note = inventory!.body.capabilities.find((c) => c.name === "note.get")!;
      expect(note.status).toBe("confirmed");
      expect(note.candidates[0]!.id).toBe(CANDIDATE);
      // readiness deploys nothing
      const decisions = await ws.records<{ kind: string; deployed: boolean }>(OPERATOR, "Decision", id);
      expect(decisions.find((d) => d.kind === "promotion-status")!.deployed).toBe(false);
    } finally {
      await ws.close();
    }
  });

  it("keeps the isolated checkout unchanged from pinning through verification, and runs nothing in the source repository", async () => {
    const { mirror, work } = notesRepository();
    const before = treeHash(mirror);
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "verify");
      const p = await ws.project(OPERATOR, id);
      expect(treeHash(ws.store.resolve(p.revision!.checkout))).toBe(p.revision!.treeDigest);
      expect(existsSync(join(ws.store.resolve(p.revision!.checkout), ".git", "hooks", "post-checkout"))).toBe(false);
      expect(treeHash(mirror)).toBe(before);
    } finally {
      await ws.close();
    }
  });
});

describe("approval is enforced at the action boundary", () => {
  it("refuses to execute without an approval, with a wrong subject, and after the plan changed", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "request-approval");
      await refusal(ws.execute(OPERATOR, id), "APPROVAL_REQUIRED");
      await refusal(ws.approve(OPERATOR, id, { action: "generate-files", subject: "sha256:" + "0".repeat(64) }), "APPROVAL_SUBJECT_MISMATCH");
      // the advancer may act but not approve: authority is not approval
      const { subject } = await ws.approvalSubject(OPERATOR, id, "generate-files");
      await refusal(ws.approve(ADVANCER, id, { action: "generate-files", subject }), "UNAUTHORIZED");
      await ws.approve(OPERATOR, id, { action: "generate-files", subject });
      // the reviewed extraction changes after approval: the approval does not cover it
      appendFileSync(join(ex.dir, "adapter.mjs"), "// changed after approval\n");
      await refusal(ws.execute(OPERATOR, id), "APPROVAL_REQUIRED");
      // refused at the boundary, before anything ran: no run, and the workflow is where it was
      const p = await ws.project(OPERATOR, id);
      expect(p.stage).toBe("awaiting-approval");
      expect(p.condition.state).not.toBe("failed");
      const runs = await ws.records<Run>(OPERATOR, "Run", id);
      expect(runs.filter((r) => r.step === "execute")).toEqual([]);
    } finally {
      await ws.close();
    }
  });

  it("enforces commit, push, promote and integration changes: no approval is refused, an approval is still unsupported", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "ready");
      for (const action of ["commit", "push", "promote", "modify-integration"]) {
        await refusal(ws.dispatch(OPERATOR, id, action, {}), "APPROVAL_REQUIRED");
        const { subject } = await ws.approvalSubject(OPERATOR, id, action);
        await ws.approve(OPERATOR, id, { action, subject });
        const again = await ws.dispatch(OPERATOR, id, action, {});
        const e = await refusal(again.done, "UNSUPPORTED");
        expect(e.message).toMatch(/approved but not supported/);
      }
      const p = await ws.project(OPERATOR, id);
      // a refused action does not move or fail the workflow
      expect(p.stage).toBe("ready-for-promotion");
      expect(p.condition.state).not.toBe("failed");
    } finally {
      await ws.close();
    }
  });

  it("opens a pull request only with an approval of that head and base, and a resumed run never opens a second one", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const calls: string[] = [];
    const ws = await openWorkspace({ extractionsRoot: ex.root, providers: { git: recordingProvider(gitProvider(), calls) } });
    try {
      const id = await advanceTo(ws, mirror, "verify");
      await refusal(ws.pullRequest(OPERATOR, id, { head: "feature", base: "main" }), "APPROVAL_REQUIRED");
      expect(calls).toEqual([]);
      const { subject } = await ws.approvalSubject(OPERATOR, id, "pull-request", { head: "feature", base: "main" });
      await ws.approve(OPERATOR, id, { action: "pull-request", subject, head: "feature", base: "main" });
      // an approval for feature→main does not cover other→main
      await refusal(ws.pullRequest(OPERATOR, id, { head: "other", base: "main" }), "APPROVAL_REQUIRED");
      // the pull request is opened, then the run is lost before its result is applied (a crash between effect and apply)
      const commit = ws.store.commit.bind(ws.store);
      let crashed = false;
      ws.store.commit = async (writes, tx) => {
        if (!crashed && writes.some((w) => w.collection === "Approval" && (w.value as { status?: string }).status === "consumed")) {
          crashed = true;
          throw new Error("process lost before applying");
        }
        return commit(writes, tx);
      };
      await (await ws.pullRequest(OPERATOR, id, { head: "feature", base: "main" })).done.catch(() => {});
      expect(calls).toEqual(["create feature->main"]);
      const resumed = await ws.resume(OPERATOR, id);
      await resumed.done;
      expect(calls).toEqual(["create feature->main"]); // adopted from the recorded effect, not opened again
      const runs = (await ws.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "pull-request");
      expect(runs.find((r) => r.status === "succeeded")!.effect).toMatchObject({ intent: "pull-request", result: { number: 7 } });
      const approvals = await ws.records<ApprovalRecord>(OPERATOR, "Approval", id);
      expect(approvals.find((a) => a.action === "pull-request")!.status).toBe("consumed");
      await refusal(ws.pullRequest(OPERATOR, id, { head: "feature", base: "main" }), "APPROVAL_CONSUMED");
    } finally {
      await ws.close();
    }
  });
});

describe("preconditions are validated evidence", () => {
  it("refuses steps out of order, and an ineligible candidate", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" });
      await refusal(ws.assess(OPERATOR, p.id), "INVALID_TRANSITION");
      const id = await advanceTo(ws, mirror, "reconcile");
      const done = (await ws.select(OPERATOR, id, { candidate: "cand-notes.v1.NoteService.DeleteNote" })).done;
      const e = await refusal(done, "CANDIDATE_INELIGIBLE");
      expect(e.message).toMatch(/CANDIDATE_NOT_READ_ONLY/);
      await refusal((await ws.resume(OPERATOR, id)).done, "CANDIDATE_INELIGIBLE"); // resume replays the same input
    } finally {
      await ws.close();
    }
  });

  it("refuses a missing or invalid fulfillment declaration when validating the plan", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { declaration: () => ({ extensions: ["appport.fulfillment/1"], attributes: { "appport.fulfillment/1": { capabilities: { "note.get@1": [{ contract: "x", capability: "note.get", version: 1, digest: "sha256:0" }] } } } }) });
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "select");
      const e = await refusal((await ws.plan(OPERATOR, id)).done, "FULFILLMENT_MISMATCH");
      expect(e.details.reasons).toBeDefined();
      writeFileSync(join(ex.dir, "fulfillment.json"), "{ not json");
      await refusal((await ws.resume(OPERATOR, id)).done, "FULFILLMENT_MALFORMED");
      const { rmSync } = await import("node:fs");
      rmSync(join(ex.dir, "fulfillment.json"));
      const missing = await (await ws.resume(OPERATOR, id)).done.catch((x: WorkspaceError) => x);
      expect((missing as WorkspaceError).details.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FULFILLMENT_MISSING" })]));
    } finally {
      await ws.close();
    }
  });

  it("refuses a candidate with no reviewed plan: the workspace generates no code", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace({ extractionsRoot: join(mirror, "..", "none") });
    try {
      const id = await advanceTo(ws, mirror, "select");
      await refusal((await ws.plan(OPERATOR, id)).done, "PLAN_MISSING");
    } finally {
      await ws.close();
    }
  });

  it("stops when the pinned checkout changes, and reports a ref that moved without re-pinning", async () => {
    const { mirror, work, sha } = notesRepository();
    const ws = await openWorkspace({});
    try {
      const id = await advanceTo(ws, mirror, "pin");
      const moved = advanceMain(work, mirror);
      const p = await ws.project(OPERATOR, id);
      expect(p.revision!.sha).toBe(sha); // pinned: the moved branch changes nothing
      expect(moved).not.toBe(sha);
      appendFileSync(join(ws.store.resolve(p.revision!.checkout), "go.mod"), "\n");
      await refusal((await ws.inspect(OPERATOR, id)).done, "REVISION_CHANGED");
    } finally {
      await ws.close();
    }
  });

  it("records a revision that is not on the default branch, visibly", async () => {
    const { mirror, work } = notesRepository();
    const sha = sideBranch(work, mirror, "feature/bridge");
    const ws = await openWorkspace({});
    try {
      const id = await advanceTo(ws, mirror, "pin", { ref: "feature/bridge" });
      const p = await ws.project(OPERATOR, id);
      expect(p.revision!.sha).toBe(sha);
      expect(p.revision!.onDefaultBranch).toBe("no");
      expect(p.condition.state).toBe("partial");
      expect(p.condition.reasons.map((r) => r.code)).toContain("REVISION_NOT_ON_DEFAULT_BRANCH");
    } finally {
      await ws.close();
    }
  });

  it("refuses an unknown ref", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace({});
    try {
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "no-such-branch" });
      await refusal((await ws.acquire(OPERATOR, p.id)).done, "REF_NOT_FOUND");
      expect((await ws.project(OPERATOR, p.id)).failure!.step).toBe("acquire");
    } finally {
      await ws.close();
    }
  });

  it("keeps a partial assessment visible and records discovery as unavailable when an integration has no endpoint", async () => {
    const { mirror, work } = notesRepository({ "bridge/package.json": JSON.stringify({ name: "notes-bridge", dependencies: { "@appport/sdk": "1.2.2" } }), "web/app.py": "print(1)\n" });
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "reconcile");
      const p = await ws.project(OPERATOR, id);
      const codes = p.condition.reasons.map((r) => r.code);
      expect(codes).toContain("DISCOVERY_UNAVAILABLE");
      expect(codes).toContain("ASSESSMENT_PARTIAL");
      expect(new Set(codes).size).toBe(codes.length);
      const inventory = await ws.artifact<{ partial: Array<{ code: string }>; candidates: Array<{ exposure: string }> }>(OPERATOR, p.current.inventory);
      expect(inventory!.body.partial.map((x) => x.code)).toEqual(["DISCOVERY_UNAVAILABLE", "ASSESSMENT_PARTIAL"]);
      // with discovery unavailable, exposure is unknown, not "not exposed"
      expect(new Set(inventory!.body.candidates.map((c) => c.exposure))).toEqual(new Set(["unknown"]));
    } finally {
      await ws.close();
    }
  });
});

describe("verification", () => {
  it("records failed behaviors as not verified, and readiness is refused", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { mode: "fail" });
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "verify");
      const view = await ws.project(OPERATOR, id);
      expect(view.stage).toBe("verification-completed");
      expect(view.condition.reasons.map((r) => r.code)).toContain("BEHAVIORS_NOT_PASSED");
      await refusal((await ws.ready(OPERATOR, id)).done, "NOT_VERIFIED");
    } finally {
      await ws.close();
    }
  });

  it("catches a run that modified the checkout", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { mode: "write-checkout" });
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const error = await advanceTo(ws, mirror, "execute").catch((e: WorkspaceError) => e);
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe("CHECKOUT_CHANGED");
    } finally {
      await ws.close();
    }
  });

  it("treats a verification as stale once the reviewed extraction changes, and re-verification says so", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "verify");
      appendFileSync(join(ex.dir, "adapter.mjs"), "// changed after verification\n");
      expect((await ws.verificationFreshness(OPERATOR, id)).join()).toMatch(/plan, adapter or suite changed/);
      await refusal((await ws.ready(OPERATOR, id)).done, "VERIFICATION_STALE");
      await refusal((await ws.resume(OPERATOR, id)).done, "VERIFICATION_STALE");
      await ws.cancel(OPERATOR, id, "stale");
      await refusal(ws.verify(OPERATOR, id), "PROJECT_CANCELLED");
    } finally {
      await ws.close();
    }
  });
});

describe("failure, recovery and concurrency", () => {
  it("records a runner that fails mid-run, keeps the approval, and resumes only that step", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { mode: "crash" });
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "approve");
      const e = await refusal((await ws.execute(OPERATOR, id)).done, "RUNNER_FAILED");
      expect(e.message).toMatch(/exited 3/);
      let p: Project = await ws.project(OPERATOR, id);
      expect(p.condition.state).toBe("failed");
      expect(p.failure!.step).toBe("execute");
      await refusal(ws.verify(OPERATOR, id), "PROJECT_FAILED");
      const approvals = await ws.records<ApprovalRecord>(OPERATOR, "Approval", id);
      expect(approvals[0]!.status).toBe("granted"); // a failed run consumed nothing
      // the runner's log is kept as evidence; the environment it saw had no credential or workspace variable
      const log = (await ws.records<{ kind: string; id: string }>(OPERATOR, "Artifact", id)).find((a) => a.kind === "verification-log")!;
      const body = (await ws.artifact<{ output: string }>(OPERATOR, log.id))!.body;
      expect(body.output).toMatch(/crashing on purpose/);
      expect(body.output).not.toMatch(/GITHUB_TOKEN|APPWORKS_/);
      const stepsBefore = (await ws.records<StageEvent>(OPERATOR, "StageEvent", id)).length;
      ex.setMode("pass"); // the reviewed extraction is fixed... which changes its subject: the old approval no longer covers it
      await refusal(ws.resume(OPERATOR, id), "APPROVAL_REQUIRED");
      const { subject } = await ws.approvalSubject(OPERATOR, id, "generate-files");
      await ws.approve(OPERATOR, id, { action: "generate-files", subject });
      p = await (await ws.resume(OPERATOR, id)).done;
      expect(p.stage).toBe("extraction-executed");
      expect(p.condition.state).not.toBe("failed");
      expect(p.failure).toBeUndefined();
      expect(p.condition.reasons.map((r) => r.code)).not.toContain("RUNNER_FAILED");
      const runs = (await ws.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "execute");
      expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
      // earlier steps were not repeated
      const events = await ws.records<StageEvent>(OPERATOR, "StageEvent", id);
      expect(events.filter((e2) => e2.step === "assess")).toHaveLength(1);
      expect(events.length).toBeGreaterThan(stepsBefore);
    } finally {
      await ws.close();
    }
  });

  it("refuses a concurrent step on the same project, from the same or another process's workspace", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { mode: "hang" });
    const home = (await import("./helpers.js")).tempDir("ws-home-");
    const a = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-a", runnerTimeoutMs: 4_000 });
    const b = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-b" });
    try {
      const id = await advanceTo(a, mirror, "approve");
      const started = await a.execute(OPERATOR, id);
      await refusal(b.execute(OPERATOR, id), "STEP_IN_PROGRESS");
      await refusal(a.verify(OPERATOR, id), "INVALID_TRANSITION");
      await refusal(b.resume(OPERATOR, id), "STEP_IN_PROGRESS");
      await refusal(started.done, "RUNNER_FAILED"); // the hanging runner is stopped at its timeout
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("lets exactly one of two racing claims win", async () => {
    const { mirror } = notesRepository();
    const home = (await import("./helpers.js")).tempDir("ws-home-");
    const a = await openWorkspace({ home, worker: "worker-a" });
    const b = await openWorkspace({ home, worker: "worker-b" });
    try {
      const p = await a.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" });
      const results = await Promise.allSettled([a.acquire(OPERATOR, p.id), b.acquire(OPERATOR, p.id)]);
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(["CONFLICT", "STEP_IN_PROGRESS"]).toContain((lost.reason as WorkspaceError).code);
      await (won[0] as PromiseFulfilledResult<{ done: Promise<Project> }>).value.done;
      expect((await a.project(OPERATOR, p.id)).stage).toBe("repository-acquired");
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("refuses reads and mutations the authority does not permit", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace({});
    try {
      await refusal(ws.createProject(VIEWER, { provider: "git", owner: "example", name: "notes", fetchFrom: mirror, ref: "main" }), "UNAUTHORIZED");
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" });
      expect((await ws.project(VIEWER, p.id)).id).toBe(p.id);
      await refusal(ws.acquire(VIEWER, p.id), "UNAUTHORIZED");
      await refusal(ws.cancel(VIEWER, p.id, "no"), "UNAUTHORIZED");
      await refusal(ws.project({ id: "local:stranger", kind: "user" }, p.id), "UNAUTHORIZED");
      const locked = await Workspace.open({ home: ws.home, authority: localAuthority({}), credentials: { resolve: async () => "" }, providers: {} }).catch((e) => e);
      expect(locked).toBeInstanceOf(Workspace); // a second handle on the same home (multi-process FeltDB)
      await refusal((locked as Workspace).listProjects(OPERATOR), "UNAUTHORIZED");
      await (locked as Workspace).close();
    } finally {
      await ws.close();
    }
  });
});

describe("credentials", () => {
  it("never writes a credential to FeltDB, an artifact or a run record, and refuses one given as a value", async () => {
    const { mirror } = notesRepository();
    const secret = "ghp_" + "S3cr3tT0k3nValue".repeat(2);
    const ws = await openWorkspace({ credentials: { resolve: async () => secret } });
    try {
      await refusal(ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", fetchFrom: mirror, ref: "main", readCredential: secret }), "INVALID_INPUT");
      await refusal(ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: `https://x-access-token:${secret}@github.com/example/notes`, ref: "main" }), "INVALID_INPUT");
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main", readCredential: "env:NOTES_TOKEN", writeCredential: "env:NOTES_WRITE_TOKEN" });
      await step(ws, OPERATOR, p.id, "acquire");
      await step(ws, OPERATOR, p.id, "pin");
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (name === "workspaces") continue;
          if (statSync(path).isDirectory()) walk(path);
          else files.push(path);
        }
      };
      walk(ws.home);
      for (const file of files) expect(readFileSync(file, "utf8").includes(secret), file).toBe(false);
      const stored = await ws.project(OPERATOR, p.id);
      expect(stored.repository.credentials).toEqual({ read: { provider: "env", secretId: "NOTES_TOKEN" }, write: { provider: "env", secretId: "NOTES_WRITE_TOKEN" } });
    } finally {
      await ws.close();
    }
  });
});
