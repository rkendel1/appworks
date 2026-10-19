import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentError, AgentRuntime, projectView, deterministicAgent, scriptedAgent, SimulatedCrash, WorkspaceError, type AgentRunRecord, type AgentTurnRecord, type Run, type Workspace } from "../src/index.js";
import { advanceTo, CANDIDATE, extractionsRoot, notesRepository, openWorkspace, OPERATOR, step, tempDir, VIEWER } from "./helpers.js";

const finished = (started: { done: Promise<AgentRunRecord> }) => started.done;
const turnsOf = (runtime: AgentRuntime, run: string) => runtime.turns(OPERATOR, run);
const workflowRuns = async (ws: Workspace, id: string) => ws.records<Run>(OPERATOR, "Run", id);

async function project(ws: Workspace, mirror: string): Promise<string> {
  return (await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" })).id;
}

async function approvePaused(ws: Workspace, runtime: AgentRuntime, run: string): Promise<AgentRunRecord> {
  const r = await runtime.run(OPERATOR, run);
  expect(r.status).toBe("paused");
  expect(r.pause?.kind).toBe("approval");
  const pause = r.pause as { approval: string; subject: string };
  // The run paused on the subject the workflow itself derives: the agent supplied none of it.
  expect((await ws.approvalSubject(OPERATOR, r.projectId, pause.approval)).subject).toBe(pause.subject);
  await ws.approve(OPERATOR, r.projectId, { action: pause.approval, subject: pause.subject });
  return r;
}

describe("the agent runtime drives the workflow autonomously", () => {
  it("carries a project from selection to a local commit, pausing only at each approval a person must grant", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const agent = deterministicAgent();
      let started = await runtime.start(OPERATOR, id, { agent });
      let run = await finished(started);
      // The revision has no AppPort integration: the agent proposes installing one and waits for its approval.
      expect(run.status).toBe("paused");
      expect((await ws.project(OPERATOR, id)).stage).toBe("integration-proposed");
      expect((await turnsOf(runtime, run.id)).map((t) => [t.action, t.status])).toEqual([
        ["workflow.acquire@1", "succeeded"],
        ["workflow.pin@1", "succeeded"],
        ["workflow.inspect@1", "succeeded"],
        ["workflow.propose-integration@1", "succeeded"],
        ["workflow.install-integration@1", "paused"]
      ]);
      expect(run.pause).toMatchObject({ kind: "approval", approval: "modify-integration" });
      await approvePaused(ws, runtime, run.id);
      run = await finished(await runtime.resume(OPERATOR, run.id, { agent }));
      // Installed, discovered on the installed integration, then through request-approval without anyone.
      expect(run.status).toBe("paused");
      expect((await ws.project(OPERATOR, id)).stage).toBe("awaiting-approval");
      expect((await turnsOf(runtime, run.id)).slice(5).map((t) => [t.action, t.status])).toEqual([
        ["workflow.install-integration@1", "succeeded"],
        ["workflow.discover@1", "succeeded"],
        ["workflow.assess@1", "succeeded"],
        ["workflow.reconcile@1", "succeeded"],
        ["workflow.select@1", "succeeded"],
        ["workflow.plan@1", "succeeded"],
        ["workflow.request-approval@1", "succeeded"],
        ["workflow.execute@1", "paused"]
      ]);
      const view = await projectView(ws, OPERATOR, id);
      expect(view.installation).toMatchObject({ state: "installed", directory: "appport", application: { id: "com.github.example.notes" }, install: { verified: true } });
      expect(view.discovery).toMatchObject({ outcome: "discovered", application: { id: "com.github.example.notes" }, capabilities: [] });
      expect(view.installation!.install!.patch).toMatch(/^diff --git a\/appport\/.gitignore/m);
      // The selection is the reviewed extraction's candidate, and attributed to the agent.
      expect((await ws.records<{ kind: string; candidate?: string; rationale?: string }>(OPERATOR, "Decision", id)).find((d) => d.kind === "candidate-selection")).toMatchObject({ candidate: CANDIDATE, rationale: expect.stringMatching(/^agent-proposed: /) });
      // Every action went through the workflow: one run per step, no execution yet.
      expect((await workflowRuns(ws, id)).some((r) => r.step === "execute")).toBe(false);
      for (const until of ["contract-proposed", "promotion-proposed", "ready-for-review"]) {
        await approvePaused(ws, runtime, run.id);
        started = await runtime.resume(OPERATOR, run.id, { agent });
        run = await finished(started);
        expect(run.status, until).toBe("paused");
        expect((await ws.project(OPERATOR, id)).stage).toBe(until);
      }
      await approvePaused(ws, runtime, run.id);
      run = await finished(await runtime.resume(OPERATOR, run.id, { agent }));
      expect(run.status).toBe("completed");
      expect(run.outcome).toMatchObject({ claimed: "done", stage: "ready-for-review" });
      expect(run.agent).toEqual({ provider: "deterministic", implementation: "appworks-deterministic@1" });
      const p = await ws.project(OPERATOR, id);
      expect(p.stage).toBe("ready-for-review");
      // No step ran twice: every workflow run succeeded on its first attempt.
      expect((await workflowRuns(ws, id)).every((r) => r.attempt === 1 && r.status === "succeeded")).toBe(true);
      // A finished run releases the project to a new run.
      await expect(runtime.start(VIEWER, id, { agent })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await ws.close();
    }
  }, 60_000);

  it("never executes on an approval of a subject that changed: it pauses again for the new subject", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const agent = deterministicAgent();
      const run = await finished(await runtime.start(OPERATOR, id, { agent }));
      await approvePaused(ws, runtime, run.id); // installing AppPort
      const paused = await finished(await runtime.resume(OPERATOR, run.id, { agent }));
      expect(paused.pause).toMatchObject({ approval: "generate-files" });
      const before = await approvePaused(ws, runtime, run.id);
      appendFileSync(join(ex.dir, "adapter.mjs"), "// changed after approval\n");
      const again = await finished(await runtime.resume(OPERATOR, run.id, { agent }));
      expect(again.status).toBe("paused");
      expect((again.pause as { subject: string }).subject).not.toBe((before.pause as { subject: string }).subject);
      expect((await workflowRuns(ws, id)).some((r) => r.step === "execute")).toBe(false);
    } finally {
      await ws.close();
    }
  }, 30_000);
});

describe("decisions are validated before anything runs", () => {
  it("rejects unknown actions, invalid arguments and malformed responses, executes nothing for them, and fails after three in a row", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const agent = scriptedAgent([
        { kind: "action", action: "shell.exec@1", arguments: { command: "rm -rf /" }, rationale: "try" },
        { kind: "action", action: "workflow.acquire@1", arguments: { force: true }, rationale: "extra argument" },
        { format: "something-else", decision: { kind: "finish" } }
      ]);
      const run = await finished(await runtime.start(OPERATOR, id, { agent }));
      expect(run.status).toBe("failed");
      expect(run.error?.code).toBe("AGENT_OUTPUT_INVALID");
      const turns = await turnsOf(runtime, run.id);
      expect(turns.map((t) => [t.status, t.problems?.[0]?.code])).toEqual([
        ["invalid", "ACTION_UNKNOWN"],
        ["invalid", "ARGUMENTS_INVALID"],
        ["invalid", "RESPONSE_FORMAT"]
      ]);
      // The rejection reached the agent in the next request, with what was offered.
      expect(agent.requests[1]!.history[0]!.result).toMatchObject({ status: "invalid", code: "ACTION_UNKNOWN" });
      expect(agent.requests[0]!.actions.map((a) => a.id)).toEqual(["workflow.acquire@1"]);
      expect((await ws.project(OPERATOR, id)).stage).toBe("project-selected");
      expect(await workflowRuns(ws, id)).toEqual([]);
    } finally {
      await ws.close();
    }
  });

  it("bounds a decision in time, retries only retryable failures, and never retries an authentication failure", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000, backoffMs: 5 });
    try {
      // An adapter that ignores its signal is still bounded.
      const slow = scriptedAgent([{ kind: "finish", outcome: "done", rationale: "late" }], { delayMs: 5_000, ignoreSignal: true });
      const t0 = Date.now();
      const timedOut = await finished(await runtime.start(OPERATOR, await project(ws, mirror), { agent: slow, limits: { decisionTimeoutMs: 100, maxRetries: 1 } }));
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(timedOut).toMatchObject({ status: "failed", error: { code: "AGENT_TIMEOUT", kind: "timeout" } });
      expect(slow.requests).toHaveLength(2); // one retry

      const limited = scriptedAgent([new AgentError("rate-limited", "429", { retryAfterMs: 10 }), new AgentError("transient", "503"), { kind: "finish", outcome: "nothing-to-do", rationale: "fine" }]);
      const ok = await finished(await runtime.start(OPERATOR, await project(ws, mirror), { agent: limited }));
      expect(ok.status).toBe("completed");
      expect((await turnsOf(runtime, ok.id))[0]!.attempts).toBe(3);

      const denied = scriptedAgent([new AgentError("authentication", "bad key"), { kind: "finish", outcome: "done", rationale: "never reached" }]);
      const failed = await finished(await runtime.start(OPERATOR, await project(ws, mirror), { agent: denied }));
      expect(failed).toMatchObject({ status: "failed", error: { code: "AGENT_AUTHENTICATION", kind: "authentication" } });
      expect(denied.requests).toHaveLength(1);
      expect(failed.agent.provider).toBe("fake"); // no other provider took over
    } finally {
      await ws.close();
    }
  });

  it("stops a run on request: the in-flight decision is abandoned and the project is left as it was", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const agent = scriptedAgent([{ kind: "action", action: "workflow.acquire@1", arguments: {}, rationale: "late" }], { delayMs: 10_000 });
      const started = await runtime.start(OPERATOR, id, { agent });
      await new Promise((r) => setTimeout(r, 100));
      await runtime.stop(OPERATOR, started.run, "enough");
      const run = await finished(started);
      expect(run.status).toBe("cancelled");
      expect(await workflowRuns(ws, id)).toEqual([]);
      expect((await ws.project(OPERATOR, id)).condition.state).toBe("active");
      // A stopped run no longer holds the project.
      expect((await finished(await runtime.start(OPERATOR, id, { agent: scriptedAgent([]) }))).status).toBe("completed");
    } finally {
      await ws.close();
    }
  });
});

describe("one agent run per project, recoverable after a crash", () => {
  it("refuses a second run on a project another run holds, from this or another runtime", async () => {
    const { mirror } = notesRepository();
    const home = tempDir("ws-home-");
    const a = await openWorkspace({ home });
    const b = await openWorkspace({ home });
    const ra = new AgentRuntime(a, { leaseMs: 2_000, worker: "a" });
    const rb = new AgentRuntime(b, { leaseMs: 2_000, worker: "b" });
    try {
      const id = await project(a, mirror);
      const slow = () => scriptedAgent([{ kind: "finish", outcome: "done", rationale: "x" }], { delayMs: 500 });
      const results = await Promise.allSettled([ra.start(OPERATOR, id, { agent: slow() }), rb.start(OPERATOR, id, { agent: slow() })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(["CONFLICT", "AGENT_RUN_IN_PROGRESS"]).toContain((refused.reason as WorkspaceError).code);
      const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ run: string; done: Promise<AgentRunRecord> }>).value;
      await expect(rb.start(OPERATOR, id, { agent: slow() })).rejects.toMatchObject({ code: "AGENT_RUN_IN_PROGRESS" });
      await winner.done;
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("recovers a run whose worker died after its step completed: the step's result is reconciled, not repeated", async () => {
    const { mirror } = notesRepository();
    const home = tempDir("ws-home-");
    const ws = await openWorkspace({ home });
    const crashing = new AgentRuntime(ws, { leaseMs: 1_000, worker: "dead", faultPoint: (name, c) => { if (name === "after-execute" && c.turn === 1) throw new SimulatedCrash(name); } });
    try {
      const id = await project(ws, mirror);
      const agent = deterministicAgent();
      const started = await crashing.start(OPERATOR, id, { agent });
      await expect(started.done).rejects.toBeInstanceOf(SimulatedCrash);
      expect((await ws.project(OPERATOR, id)).stage).toBe("repository-acquired");
      const survivor = new AgentRuntime(ws, { leaseMs: 1_000, worker: "survivor" });
      // While the dead worker's lease could still be renewed, nobody takes the run over.
      await expect(survivor.resume(OPERATOR, started.run, { agent })).rejects.toMatchObject({ code: "AGENT_RUN_IN_PROGRESS" });
      await expect(survivor.start(OPERATOR, id, { agent })).rejects.toMatchObject({ code: "AGENT_RUN_IN_PROGRESS" });
      await new Promise((r) => setTimeout(r, 1_200));
      expect((await survivor.runs(OPERATOR, id))[0]!.interrupted).toBe(true);
      await expect(survivor.start(OPERATOR, id, { agent })).rejects.toMatchObject({ code: "AGENT_RUN_INTERRUPTED" });
      const run = await finished(await survivor.resume(OPERATOR, started.run, { agent }));
      // It carried on from the recorded state, to the approval installing AppPort needs.
      expect(run).toMatchObject({ status: "paused", pause: { approval: "modify-integration" } });
      const first = (await turnsOf(survivor, run.id))[0] as AgentTurnRecord;
      expect(first).toMatchObject({ status: "succeeded", action: "workflow.acquire@1", result: { status: "succeeded", summary: expect.stringMatching(/recovered from the workflow's record, not repeated/) } });
      expect((await workflowRuns(ws, id)).filter((r) => r.step === "acquire")).toHaveLength(1);
    } finally {
      await ws.close();
    }
  }, 30_000);

  it("reports an action that never started as interrupted, and the agent decides again", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const crashing = new AgentRuntime(ws, { leaseMs: 500, worker: "dead", faultPoint: (name) => { if (name === "before-execute") throw new SimulatedCrash(name); } });
    try {
      const id = await project(ws, mirror);
      const started = await crashing.start(OPERATOR, id, { agent: deterministicAgent() });
      await expect(started.done).rejects.toBeInstanceOf(SimulatedCrash);
      await new Promise((r) => setTimeout(r, 700));
      const agent = scriptedAgent([{ kind: "finish", outcome: "done", rationale: "seen" }], { identity: { provider: "deterministic", implementation: "appworks-deterministic@1", model: undefined } });
      const run = await finished(await new AgentRuntime(ws, { leaseMs: 500 }).resume(OPERATOR, started.run, { agent }));
      expect(run.status).toBe("completed");
      expect(agent.requests[0]!.history[0]!.result).toMatchObject({ status: "interrupted", summary: expect.stringMatching(/never started/) });
      expect(await workflowRuns(ws, id)).toEqual([]);
    } finally {
      await ws.close();
    }
  });
});

describe("people stay in charge", () => {
  it("pauses for a question, resumes only with an answer, and gives the answer to the agent", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const agent = scriptedAgent([{ kind: "ask", question: "Which application origin?", rationale: "the source names none" }, { kind: "finish", outcome: "done", rationale: "answered" }]);
      const run = await finished(await runtime.start(OPERATOR, id, { agent }));
      expect(run).toMatchObject({ status: "paused", pause: { kind: "question", question: "Which application origin?" } });
      await expect(runtime.resume(OPERATOR, run.id, { agent })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect((await finished(await runtime.resume(OPERATOR, run.id, { agent, answer: "none yet" }))).status).toBe("completed");
      expect(agent.requests[1]!.history[0]!.result).toMatchObject({ status: "answered", class: "human-answer", summary: expect.stringContaining("none yet") });
    } finally {
      await ws.close();
    }
  });

  it("refuses to resume with another agent unless the switch is explicit, and records it", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      const run = await finished(await runtime.start(OPERATOR, id, { agent: scriptedAgent([{ kind: "ask", question: "go on?", rationale: "check" }]) }));
      const other = deterministicAgent();
      await expect(runtime.resume(OPERATOR, run.id, { agent: other, answer: "yes" })).rejects.toMatchObject({ code: "AGENT_SWITCH_REQUIRED" });
      const resumed = await finished(await runtime.resume(OPERATOR, run.id, { agent: other, answer: "yes", switchAgent: true }));
      expect(resumed.agent.provider).toBe("deterministic");
      expect(resumed.switches).toEqual([expect.objectContaining({ by: OPERATOR.id, from: expect.objectContaining({ provider: "fake" }), to: expect.objectContaining({ provider: "deterministic" }), afterTurn: 1 })]);
    } finally {
      await ws.close();
    }
  });

  it("keeps credentials out of every request, record and file", async () => {
    const { mirror } = notesRepository();
    const home = tempDir("ws-home-");
    const ws = await openWorkspace({ home });
    const secret = "sk-ant-api03-SECRETSECRETSECRET1234567890";
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000, secrets: [secret] });
    try {
      const id = await project(ws, mirror);
      const agent = scriptedAgent([
        { kind: "action", action: "workflow.acquire@1", arguments: {}, rationale: `my key is ${secret}` },
        { kind: "finish", outcome: "done", rationale: `also ghp_${"a".repeat(36)}` }
      ]);
      const run = await finished(await runtime.start(OPERATOR, id, { agent, task: `do it with ${secret}` }));
      expect(run.status).toBe("completed");
      expect(JSON.stringify(agent.requests)).not.toContain(secret);
      const files: string[] = [];
      const walk = (dir: string) => readdirSync(dir).forEach((n) => (statSync(join(dir, n)).isDirectory() ? (n === "workspaces" ? undefined : walk(join(dir, n))) : files.push(join(dir, n))));
      walk(home);
      const leaked = files.filter((f) => {
        const t = readFileSync(f, "latin1");
        return t.includes(secret) || t.includes(`ghp_${"a".repeat(36)}`);
      });
      expect(leaked).toEqual([]);
      expect((await turnsOf(runtime, run.id))[0]!.decision!.rationale).toBe("my key is [redacted]");
    } finally {
      await ws.close();
    }
  });
});

describe("read actions observe the pinned checkout and nothing else", () => {
  it("reads, lists and searches within the checkout, refusing credentials and escapes", async () => {
    const { mirror } = notesRepository({ ".env.production": "TOKEN=abc\n", "config/secrets.json": "{}\n", "docs/setup.md": "run on http://localhost:4123\napi key sk-test-ABCDEFGHIJKLMNOPQRSTUV\n" });
    const ws = await openWorkspace();
    const runtime = new AgentRuntime(ws, { leaseMs: 2_000 });
    try {
      const id = await project(ws, mirror);
      for (const s of ["acquire", "pin"]) await step(ws, OPERATOR, id, s);
      const agent = scriptedAgent([
        { kind: "action", action: "source.list@1", arguments: {}, rationale: "look" },
        { kind: "action", action: "source.read@1", arguments: { path: "docs/setup.md" }, rationale: "read" },
        { kind: "action", action: "source.read@1", arguments: { path: ".env.production" }, rationale: "secrets" },
        { kind: "action", action: "source.read@1", arguments: { path: "../../../etc/passwd" }, rationale: "escape" },
        { kind: "action", action: "source.search@1", arguments: { text: "localhost" }, rationale: "find" },
        { kind: "finish", outcome: "done", rationale: "seen" }
      ]);
      const run = await finished(await runtime.start(OPERATOR, id, { agent }));
      const turns = await turnsOf(runtime, run.id);
      const listed = (turns[0]!.result!.data as { entries: Array<{ name: string }> }).entries.map((e) => e.name);
      expect(listed).toContain("docs");
      expect(listed).not.toContain(".env.production");
      expect(listed).not.toContain(".git");
      expect(turns[1]!.result).toMatchObject({ status: "succeeded", class: "source-observation" });
      expect(JSON.stringify(turns[1]!.result!.data)).not.toContain("sk-test-ABCDEFGHIJKLMNOPQRSTUV");
      expect(turns[2]!.result).toMatchObject({ status: "refused", code: "PATH_REFUSED" });
      expect(turns[3]!.result).toMatchObject({ status: "refused", code: "PATH_REFUSED" });
      expect((turns[4]!.result!.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path)).toEqual(["docs/setup.md"]);
      expect((await ws.project(OPERATOR, id)).stage).toBe("revision-pinned"); // reads changed nothing
    } finally {
      await ws.close();
    }
  });
});

describe("advanceTo still works beside the agent", () => {
  it("lets a person run steps on a project no agent holds", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "reconcile");
      expect((await ws.project(OPERATOR, id)).agentRun).toBeUndefined();
    } finally {
      await ws.close();
    }
  });
});
