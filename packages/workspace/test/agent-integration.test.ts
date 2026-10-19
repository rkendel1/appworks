import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFeltDB, parseFlowSpec } from "@feltdb/core";
import { agentService, AgentRuntime, eligibleActions, APPPORT_SDK_VERSION, createWorkspaceServer, deterministicAgent, endpointCandidates, main, MODEL, projectView, proposeInstallation, Store, type AgentView, type AppPortInstallation, type DiscoveryRecord } from "../src/index.js";
import { application } from "./application.js";
import { extractionsRoot, linkPackages, notesRepository, openWorkspace, OPERATOR, step, tempDir } from "./helpers.js";

async function project(ws: Awaited<ReturnType<typeof openWorkspace>>, mirror: string): Promise<string> {
  return (await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "" })).id;
}

describe("discovering the application's origin instead of asking for it", () => {
  it("ranks the ports the source names as loopback origins, and never takes a host from the source", () => {
    const root = tempDir("ws-endpoints-");
    mkdirSync(join(root, "bridge"), { recursive: true });
    writeFileSync(join(root, "bridge", ".env.example"), "PORT=4321\n");
    writeFileSync(join(root, "README.md"), "Open http://localhost:4321 or https://evil.example.com:9999/\n");
    writeFileSync(join(root, "server.py"), "app.run(port=8000)\n");
    writeFileSync(join(root, ".env"), "PORT=1111\n");
    const found = endpointCandidates(root, { integrationRoots: ["bridge"], configured: ["http://10.0.0.5:7000"] });
    expect(found.map((c) => c.origin)).toEqual(["http://10.0.0.5:7000", "http://127.0.0.1:4321", "http://127.0.0.1:8000"]);
    expect(found[1]!.sources.map((s) => s.path).sort()).toEqual(["README.md", "bridge/.env.example"]);
  });

  it("finds the running application from the pinned source and discovers it with no origin typed", async () => {
    const app = await application();
    const port = new URL(app.url).port;
    const { mirror } = notesRepository({
      "bridge/package.json": JSON.stringify({ name: "notes-bridge", dependencies: { "@appport/sdk": "1.2.2" } }),
      "bridge/.env.example": `PORT=${port}\n`,
      "README.md": "staging runs at https://staging.example.com:8443\n"
    });
    const seen: string[] = [];
    const ws = await openWorkspace({ fetch: async (url, init) => (seen.push(String(url)), fetch(url, init)) });
    try {
      const id = await project(ws, mirror);
      for (const s of ["acquire", "pin", "inspect", "discover"]) await step(ws, OPERATOR, id, s);
      const p = await ws.project(OPERATOR, id);
      expect(p.revision!.ref).toBe("main"); // no ref given: the default branch
      const record = (await ws.artifact<DiscoveryRecord>(OPERATOR, p.current.discovery))!.body;
      expect(record.outcome).toBe("discovered");
      expect(record.endpoint).toBe(`http://127.0.0.1:${port}`);
      expect(record.resolution).toMatchObject({ given: false, probes: [expect.objectContaining({ origin: `http://127.0.0.1:${port}`, sources: [expect.objectContaining({ path: "bridge/.env.example" })] })] });
      expect(seen.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true);
      expect(app.invocations()).toBe(0);
    } finally {
      await ws.close();
      await app.close();
    }
  });

  it("records every origin it tried when nothing answers, so a person knows to start the application", async () => {
    const { mirror } = notesRepository({ "bridge/package.json": JSON.stringify({ name: "b", dependencies: { "@appport/sdk": "1.2.2" } }), "bridge/.env.example": "PORT=1\nAPP_PORT=59997\n" });
    const ws = await openWorkspace();
    try {
      const id = await project(ws, mirror);
      for (const s of ["acquire", "pin", "inspect", "discover"]) await step(ws, OPERATOR, id, s);
      const p = await ws.project(OPERATOR, id);
      const record = (await ws.artifact<DiscoveryRecord>(OPERATOR, p.current.discovery))!.body;
      expect(record).toMatchObject({ outcome: "unavailable", reasons: ["endpoint.not-answering"], resolution: { given: false, probes: [expect.objectContaining({ origin: "http://127.0.0.1:59997" })] } });
      expect(p.condition.reasons.map((r) => r.code)).toContain("DISCOVERY_UNAVAILABLE");
    } finally {
      await ws.close();
    }
  }, 30_000);
});

describe("an older workspace home", () => {
  it("upgrades without losing anything, and an agent picks the project up where it stopped", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    // A project carried to integration-inspected, as an earlier AppWorks left it.
    const before = tempDir("ws-old-");
    const writer = await openWorkspace({ home: before, extractionsRoot: ex.root });
    const id = await project(writer, mirror);
    for (const s of ["acquire", "pin", "inspect"]) await step(writer, OPERATOR, id, s);
    const records: Array<{ collection: string; value: Record<string, unknown> }> = [];
    for (const collection of ["Project", "StageEvent", "Run", "Artifact"] as const) for (const value of await writer.store.list<Record<string, unknown>>(collection)) records.push({ collection, value });
    await writer.close();
    // The same records in a home whose FeltDB holds the previous feltdb.flow (no agent collections, no agentRun).
    const home = tempDir("ws-older-");
    const previous = execFileSync("git", ["show", "0022689:packages/workspace/feltdb.flow"], { cwd: join(import.meta.dirname, "..", "..", ".."), encoding: "utf8" });
    const db = createFeltDB({ namespace: "appworks-workspace", mode: "local", path: join(home, "state") });
    await db.deployFlowSpec(parseFlowSpec(previous));
    await db.transaction({ operations: records.map(({ collection, value }) => {
      const { __version: _v, ...rest } = value;
      return { collection, id: String(rest.id), value: rest, requireAbsent: true };
    }) });
    await db.close();
    execFileSync("cp", ["-a", join(before, "workspaces"), join(before, "artifacts"), home]);

    const store = await Store.open(home);
    expect(await store.flowVersion()).toBe(2);
    expect(Object.keys(MODEL.collections)).toContain("AgentRun");
    await store.close();
    const ws = await openWorkspace({ home, extractionsRoot: ex.root });
    try {
      expect((await ws.project(OPERATOR, id)).stage).toBe("integration-inspected");
      const run = await (await new AgentRuntime(ws, { leaseMs: 2_000 }).start(OPERATOR, id, { agent: deterministicAgent() })).done;
      expect(run).toMatchObject({ status: "paused", pause: { approval: "modify-integration" } });
      expect((await ws.project(OPERATOR, id)).stage).toBe("integration-proposed");
    } finally {
      await ws.close();
    }
  }, 60_000);
});

describe("the agent from the CLI and the web workspace", () => {
  it("runs, shows and stops through the same operations, and both print the same agent view", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-cli-");
    const out: string[] = [];
    const err: string[] = [];
    const cli = async (argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const code = await main(argv, { out: (t) => void out.push(t), err: (t) => void err.push(t) }, { home, extractions: ex.root, principal: OPERATOR, env: {} });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const created = await cli(["project", "create", "--git", mirror, "--owner", "example", "--name", "notes", "--json"]);
    const id = JSON.parse(created.out).id as string;
    const unconfigured = await cli(["agent", "run", id]);
    expect([unconfigured.code, unconfigured.err]).toEqual([4, expect.stringMatching(/^AGENT_NOT_CONFIGURED: .*APPWORKS_AGENT_PROVIDER/)]);
    expect((await cli(["agent", "check"])).code).toBe(4);
    expect((await cli(["agent", "check", "--agent", "deterministic"])).out).toMatch(/^agent: deterministic \(appworks-deterministic@1\)/);
    const ran = await cli(["agent", "run", id, "--agent", "deterministic"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toMatch(/run .*\.agent\.1: paused; agent deterministic/);
    expect(ran.out).toMatch(/appworks project approve .* --action modify-integration --subject sha256:/);
    // A second run on the held project is refused.
    expect((await cli(["agent", "run", id, "--agent", "deterministic"])).err).toMatch(/AGENT_RUN_PAUSED/);
    const cliView = JSON.parse((await cli(["agent", "status", id, "--json"])).out) as AgentView;
    const ws = await openWorkspace({ home, extractionsRoot: ex.root });
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0, agents: agentService(ws, {}) });
    const origin = await server.listen();
    const post = (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1" }, body: JSON.stringify(body) });
    try {
      expect(await (await fetch(`${origin}/api/projects/${id}/agent`)).json()).toEqual(cliView);
      // Without the request header, a cross-site page cannot drive the agent.
      expect((await fetch(`${origin}/api/projects/${id}/agent/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      // The web resume uses the server's configured agent: none here, refused clearly.
      const resume = await post(`/api/projects/${id}/agent/resume`, {});
      expect(resume.status).toBe(422);
      expect(((await resume.json()) as { error: { code: string } }).error.code).toBe("AGENT_NOT_CONFIGURED");
      const stopped = await post(`/api/projects/${id}/agent/stop`, { reason: "from the page" });
      expect(stopped.status).toBe(200);
      expect(((await stopped.json()) as { status: string }).status).toBe("cancelled");
    } finally {
      await server.close();
      await ws.close();
    }
    const after = await cli(["agent", "status", id]);
    expect(after.out).toMatch(/: cancelled; agent deterministic/);
    expect(after.out).toMatch(/outcome: stopped by local:operator: from the page/);
  }, 60_000);
});

describe("installing AppPort in a revision that has none", () => {
  it("proposes the same files from the same revision, adds them only to an isolated worktree, and keeps a failed install's evidence", async () => {
    const { mirror } = notesRepository();
    let fail = true;
    const ws = await openWorkspace({ installPackages: async (directory) => (fail ? { exitCode: 1, signal: null, timedOut: false, output: "E404 not found" } : linkPackages(directory)) });
    try {
      const id = await project(ws, mirror);
      for (const s of ["acquire", "pin", "inspect", "propose-integration"]) await step(ws, OPERATOR, id, s);
      const p = await ws.project(OPERATOR, id);
      const proposal = (await ws.artifact<AppPortInstallation>(OPERATOR, p.current.integrationProposal))!.body;
      const checkout = ws.store.resolve(p.revision!.checkout);
      expect(proposal).toMatchObject({ directory: "appport", application: { id: "com.github.example.notes" }, packages: { "@appport/sdk": APPPORT_SDK_VERSION } });
      expect(proposeInstallation({ owner: "example", name: "notes", url: "https://github.com/example/notes", revision: p.revision!.sha, checkout }).digest).toBe(proposal.digest);
      expect(proposal.files.map((f) => f.path)).toEqual(["appport/package.json", "appport/server.mjs", "appport/.env.example", "appport/.gitignore", "appport/README.md"]);
      // Not approved: refused before anything is written.
      await expect(ws.dispatch(OPERATOR, id, "install-integration", {})).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      const { subject } = await ws.approvalSubject(OPERATOR, id, "modify-integration");
      expect(subject).toBe(proposal.digest);
      await ws.approve(OPERATOR, id, { action: "modify-integration", subject });
      await expect(step(ws, OPERATOR, id, "install-integration")).rejects.toMatchObject({ code: "INTEGRATION_NOT_VERIFIED" });
      const failed = await ws.project(OPERATOR, id);
      expect(failed.condition.state).toBe("failed");
      const evidence = (await ws.records<{ kind: string; summary: { verified: boolean } }>(OPERATOR, "Artifact", id)).filter((a) => a.kind === "integration-install");
      expect(evidence.map((a) => a.summary.verified)).toEqual([false]);
      // The approval was not used up by the failed install; resuming installs again, now with packages.
      fail = false;
      expect((await (await ws.resume(OPERATOR, id)).done).stage).toBe("integration-installed");
      expect((await ws.records<{ action: string; status: string }>(OPERATOR, "Approval", id)).map((a) => [a.action, a.status])).toEqual([["modify-integration", "consumed"]]);
      expect(existsSync(join(checkout, "appport"))).toBe(false); // the pinned checkout is never written
      expect((await step(ws, OPERATOR, id, "discover")).stage).toBe("capabilities-discovered");
      expect(APPPORT_SDK_VERSION).toBe(JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).devDependencies["@appport/sdk"]);
    } finally {
      await ws.close();
    }
  }, 60_000);

  it("is a person's action too: the CLI and the web workspace install through the same table", async () => {
    const { mirror } = notesRepository();
    const home = tempDir("ws-cli-");
    const out: string[] = [];
    const cli = async (argv: string[]) => {
      out.length = 0;
      const code = await main(argv, { out: (t) => void out.push(t), err: () => {} }, { home, principal: OPERATOR, env: {} });
      return { code, out: out.join("\n") };
    };
    const id = JSON.parse((await cli(["project", "create", "--git", mirror, "--owner", "example", "--name", "notes", "--json"])).out).id as string;
    for (const s of ["acquire", "pin", "inspect", "propose-integration"]) expect((await cli(["project", s, id])).code, s).toBe(0);
    const subject = JSON.parse((await cli(["project", "approval-subject", id, "--action", "modify-integration", "--json"])).out).subject as string;
    expect((await cli(["project", "approve", id, "--action", "modify-integration", "--subject", subject])).code).toBe(0);
    const ws = await openWorkspace({ home });
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    try {
      const view = (await (await fetch(`${origin}/api/projects/${id}`)).json()) as { next: { actions: Array<{ action: string }> } };
      expect(view.next.actions[0]!.action).toBe("install-integration");
      const started = await fetch(`${origin}/api/projects/${id}/actions/install-integration`, { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1" }, body: "{}" });
      expect(started.status).toBe(202);
      for (let i = 0; i < 100 && (await ws.project(OPERATOR, id)).stage !== "integration-installed"; i++) await new Promise((r) => setTimeout(r, 100));
      expect((await ws.project(OPERATOR, id)).stage).toBe("integration-installed");
    } finally {
      await server.close();
      await ws.close();
    }
  }, 60_000);

  it("is not proposed for a revision that already has an AppPort integration", async () => {
    const { mirror } = notesRepository({ "bridge/package.json": JSON.stringify({ name: "b", dependencies: { "@appport/sdk": "1.2.2" } }) });
    const ws = await openWorkspace();
    try {
      const id = await project(ws, mirror);
      for (const s of ["acquire", "pin", "inspect"]) await step(ws, OPERATOR, id, s);
      expect((await projectView(ws, OPERATOR, id)).next.actions.map((a) => a.action)).not.toContain("propose-integration");
      await expect(ws.dispatch(OPERATOR, id, "propose-integration", {})).rejects.toMatchObject({ code: "INTEGRATION_PRESENT" });
      // Refused before any run: the project is not failed, and the agent is not even offered it.
      expect((await ws.project(OPERATOR, id)).condition.state).toBe("active");
      expect(eligibleActions(await projectView(ws, OPERATOR, id)).specs.map((a) => a.id)).not.toContain("workflow.propose-integration@1");
    } finally {
      await ws.close();
    }
  });
});
