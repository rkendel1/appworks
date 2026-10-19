import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime, deterministicAgent, scriptedAgent, type AgentRunRecord, type ApprovalRecord, type Workspace } from "../src/index.js";
import { extractionsRoot, notesRepository, openWorkspace, OPERATOR, tempDir } from "./helpers.js";

async function project(ws: Workspace, mirror: string): Promise<string> {
  return (await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" })).id;
}

async function setup() {
  const { mirror, work } = notesRepository();
  const ex = extractionsRoot(work);
  const ws = await openWorkspace({ extractionsRoot: ex.root });
  const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
  return { ws, runtime, ex, id: await project(ws, mirror), agent: deterministicAgent() };
}

/** Installing the AppPort integration is outside the bounded policy: a person approves it. */
async function throughInstall(ws: Workspace, runtime: AgentRuntime, id: string, agent = deterministicAgent(), endToEnd = false) {
  const run = await (await runtime.start(OPERATOR, id, { agent, endToEnd })).done;
  expect(run.pause).toMatchObject({ approval: "modify-integration" });
  const pause = run.pause as { approval: string; subject: string };
  await ws.approve(OPERATOR, id, { action: pause.approval, subject: pause.subject });
  return run;
}

describe("Run end to end: a person's bounded policy for one run", () => {
  it("approves generate-files itself, executes, verifies, and stops at the first approval outside its scope", async () => {
    const { ws, runtime, id, agent } = await setup();
    try {
      const first = await throughInstall(ws, runtime, id, agent, true);
      expect(first.policy).toMatchObject({ kind: "bounded-run", approve: ["generate-files"], grantedBy: OPERATOR.id });
      const run = await (await runtime.resume(OPERATOR, first.id, { agent })).done;
      // generate-files was granted by the policy and used; the run went on until adopt-contract, which needs a person.
      expect(run.status).toBe("paused");
      expect(run.pause).toMatchObject({ approval: "adopt-contract" });
      const approvals = await ws.records<ApprovalRecord>(OPERATOR, "Approval", id);
      const generated = approvals.find((a) => a.action === "generate-files")!;
      expect(generated).toMatchObject({ status: "consumed", grantedBy: OPERATOR.id, grantedVia: { policy: "bounded-run", run: first.id, scope: ["generate-files"], by: OPERATOR.id } });
      // The manual approval carries no policy marker, and the policy never reached adopt-contract.
      expect(approvals.find((a) => a.action === "modify-integration")!.grantedVia).toBeUndefined();
      expect(approvals.some((a) => a.action === "adopt-contract" && a.status !== "requested")).toBe(false);
      expect(approvals.some((a) => ["commit", "push", "pull-request", "promote"].includes(a.action))).toBe(false);
    } finally {
      await ws.close();
    }
  }, 90_000);

  it("is off unless a person turned it on for that run, and never carries to the next run", async () => {
    const { ws, runtime, id, agent } = await setup();
    try {
      const first = await throughInstall(ws, runtime, id, agent, false);
      expect(first.policy).toBeUndefined();
      const paused = await (await runtime.resume(OPERATOR, first.id, { agent })).done;
      expect(paused.pause).toMatchObject({ approval: "generate-files" });
      expect((await ws.records<ApprovalRecord>(OPERATOR, "Approval", id)).filter((a) => a.grantedVia)).toEqual([]);
      await runtime.stop(OPERATOR, first.id, "enough");
      const second = await (await runtime.start(OPERATOR, id, { agent: scriptedAgent([{ kind: "finish", outcome: "done", rationale: "x" }]) })).done;
      expect(second.policy).toBeUndefined();
    } finally {
      await ws.close();
    }
  }, 60_000);

  it("keeps the first approval manual even when the policy is on, and a model decision cannot set or widen it", async () => {
    const { ws, runtime, id } = await setup();
    try {
      const started = await runtime.start(OPERATOR, id, { agent: deterministicAgent(), endToEnd: true });
      const run = await started.done;
      expect(run.pause).toMatchObject({ approval: "modify-integration" });
      expect((await ws.records<ApprovalRecord>(OPERATOR, "Approval", id)).filter((a) => a.status === "granted")).toEqual([]);
      // The agent contract has no field for policy: a decision carrying one is rejected before anything runs.
      const hostile = scriptedAgent([{ kind: "action", action: "workflow.install-integration@1", arguments: { policy: { approve: ["push"] } }, rationale: "widen" } as never, { kind: "finish", outcome: "done", rationale: "x" }]);
      await runtime.stop(OPERATOR, run.id, "next");
      const next = await (await runtime.start(OPERATOR, id, { agent: hostile })).done;
      expect(next.policy).toBeUndefined();
    } finally {
      await ws.close();
    }
  }, 60_000);

  it("refuses a stale subject: a changed extraction is neither approved nor executed", async () => {
    const { ws, runtime, ex, id, agent } = await setup();
    try {
      const first = await throughInstall(ws, runtime, id, agent, false);
      const paused = await (await runtime.resume(OPERATOR, first.id, { agent })).done;
      const stale = (paused.pause as { subject: string }).subject;
      appendFileSync(join(ex.dir, "adapter.mjs"), "// changed\n");
      await expect(ws.approve(OPERATOR, id, { action: "generate-files", subject: stale }, { policy: "bounded-run", run: first.id, scope: ["generate-files"], by: OPERATOR.id })).rejects.toMatchObject({ code: "APPROVAL_SUBJECT_MISMATCH" });
      expect((await ws.records<ApprovalRecord>(OPERATOR, "Approval", id)).some((a) => a.status === "granted" && a.action === "generate-files")).toBe(false);
    } finally {
      await ws.close();
    }
  }, 60_000);

  it("survives a restart: the policy is in FeltDB, and a stopped run releases it", async () => {
    const { ws, runtime, id, agent } = await setup();
    try {
      const first = await throughInstall(ws, runtime, id, agent, true);
      const reopened = new AgentRuntime(ws, { leaseMs: 2_000 });
      expect((await reopened.run(OPERATOR, first.id)).policy).toMatchObject({ kind: "bounded-run", grantedBy: OPERATOR.id });
      const stopped = await reopened.stop(OPERATOR, first.id, "stop");
      expect(stopped.status).toBe("cancelled");
      await expect(reopened.resume(OPERATOR, first.id, { agent })).rejects.toMatchObject({ code: "AGENT_RUN_FINISHED" });
    } finally {
      await ws.close();
    }
  }, 60_000);
});

describe("deleting a project", () => {
  it("removes the project and every record of it, refuses while a step runs, and is refused without permission", async () => {
    const { ws, runtime, id, agent } = await setup();
    try {
      await throughInstall(ws, runtime, id, agent, true);
      await expect(ws.deleteProject({ id: "someone-else", kind: "user" }, id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const result = await ws.deleteProject(OPERATOR, id);
      expect(result.deleted).toBe(id);
      expect(result.records).toBeGreaterThan(5);
      await expect(ws.project(OPERATOR, id)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
      for (const c of ["StageEvent", "Run", "Artifact", "Approval", "AgentRun", "AgentTurn"] as const) expect(await ws.store.list(c, c === "AgentTurn" ? {} : { projectId: id })).toEqual([]);
    } finally {
      await ws.close();
    }
  }, 60_000);
});
