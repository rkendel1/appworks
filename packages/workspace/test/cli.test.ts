import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceServer, main, type ProjectView, type Run } from "../src/index.js";
import { CANDIDATE, extractionsRoot, notesRepository, openWorkspace, OPERATOR, tempDir } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) }, out, err };
}

async function cli(argv: string[], env: { home: string; extractions?: string }) {
  const c = io();
  const code = await main(argv, c.io, { home: env.home, ...(env.extractions ? { extractions: env.extractions } : {}), principal: OPERATOR, env: {} });
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}

describe("the appworks CLI", () => {
  it("runs the workflow through the same actions as the web workspace, and shows the same view", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-cli-");
    const env = { home, extractions: ex.root };
    const created = await cli(["project", "create", "--git", mirror, "--owner", "example", "--name", "notes", "--url", "https://github.com/example/notes", "--ref", "main", "--json"], env);
    expect(created.code).toBe(0);
    const id = JSON.parse(created.out).id as string;
    for (const s of ["acquire", "pin", "inspect", "discover", "assess", "reconcile"]) expect((await cli(["project", s, id], env)).code).toBe(0);
    expect((await cli(["project", "select", id, "--candidate", CANDIDATE], env)).code).toBe(0);
    expect((await cli(["project", "plan", id], env)).code).toBe(0);
    expect((await cli(["project", "request-approval", id], env)).code).toBe(0);
    // refused at the boundary before running: exit 4, nothing recorded as a failure
    const refused = await cli(["project", "execute", id], env);
    expect(refused.code).toBe(4);
    expect(refused.err).toMatch(/APPROVAL_REQUIRED/);
    const subject = JSON.parse((await cli(["project", "approval-subject", id, "--action", "generate-files", "--json"], env)).out).subject;
    expect((await cli(["project", "approve", id, "--action", "generate-files", "--subject", subject], env)).code).toBe(0);
    for (const s of ["execute", "verify", "ready"]) expect((await cli(["project", s, id], env)).code).toBe(0);
    const shown = await cli(["project", "show", id], env);
    expect(shown.out).toMatch(/stage ready-for-promotion/);
    expect(shown.out).toMatch(/promotion: ready; deployed: no/);

    // parity: the JSON the CLI prints is the object the web API returns
    const cliView = JSON.parse((await cli(["project", "show", id, "--json"], env)).out) as ProjectView;
    const ws = await openWorkspace({ home, extractionsRoot: ex.root });
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    try {
      const webView = (await (await fetch(`${origin}/api/projects/${id}`)).json()) as ProjectView;
      expect(webView).toEqual(cliView);
      const list = (await (await fetch(`${origin}/api/projects`)).json()) as Array<{ id: string }>;
      expect(JSON.parse((await cli(["project", "list", "--json"], env)).out)).toEqual(list);
    } finally {
      await server.close();
      await ws.close();
    }
  });

  it("carries a promotion through the CLI with the subjects the advisor offers, and shows what the web API shows", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-cli-");
    const env = { home, extractions: ex.root };
    const id = JSON.parse((await cli(["project", "create", "--git", mirror, "--owner", "example", "--name", "notes", "--url", "https://github.com/example/notes", "--ref", "main", "--json"], env)).out).id as string;
    const run = async (...argv: string[]) => {
      const r = await cli(["project", ...argv], env);
      expect(r.code, `${argv.join(" ")}: ${r.err}`).toBe(0);
      return r;
    };
    // Approves through the subject the advisor offers, after checking it is the workflow's own.
    const approveAsAdvised = async (action: string) => {
      const view = JSON.parse((await run("show", id, "--json")).out) as ProjectView;
      const offered = view.next.actions.find((a) => a.action === "approve" && a.approval === action)!;
      const subject = offered.inputs!.find((i) => i.name === "subject")!.value!;
      expect(JSON.parse((await run("approval-subject", id, "--action", action, "--json")).out).subject, action).toBe(subject);
      await run("approve", id, "--action", action, "--subject", subject);
    };
    for (const s of ["acquire", "pin", "inspect", "discover", "assess", "reconcile"]) await run(s, id);
    await run("select", id, "--candidate", CANDIDATE);
    await run("plan", id);
    await run("request-approval", id);
    await approveAsAdvised("generate-files");
    for (const s of ["execute", "verify", "ready", "propose-contract"]) await run(s, id);
    await approveAsAdvised("adopt-contract");
    await run("adopt-contract", id);
    await run("propose-promotion", id);
    await approveAsAdvised("modify-integration");
    for (const s of ["apply-promotion", "verify-promotion", "prepare-review"]) await run(s, id);
    await approveAsAdvised("commit");
    await run("commit", id);
    const shown = (await run("show", id)).out;
    expect(shown).toMatch(/stage ready-for-review/);
    expect(shown).toMatch(/contract adoption: adopted/);
    expect(shown).toMatch(/integration change: ready-for-review/);
    expect(shown).toMatch(/committed locally: [0-9a-f]{40}/);
    await approveAsAdvised("pull-request");
    const submitted = await cli(["project", "submit-review", id], env);
    expect(submitted.code).toBe(4);
    expect(submitted.err).toMatch(/UNSUPPORTED/);
    const cliView = JSON.parse((await run("show", id, "--json")).out) as ProjectView;
    const ws = await openWorkspace({ home, extractionsRoot: ex.root });
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    try {
      expect((await (await fetch(`${origin}/api/projects/${id}`)).json()) as ProjectView).toEqual(cliView);
      expect(cliView.integrationChange!.patch!.diff).toMatch(/^diff --git a\/bridge\/appworks\/notes-get\/adapter.mjs/m);
    } finally {
      await server.close();
      await ws.close();
    }
  });

  it("exits 2 for invalid arguments, 3 when unauthorized, 4 when refused, and 1 when a step ran and failed", async () => {
    const { mirror } = notesRepository();
    const home = tempDir("ws-cli-");
    expect((await cli(["project"], { home })).code).toBe(2);
    expect((await cli(["project", "create", "--github", "nope", "--ref", "main"], { home })).code).toBe(2);
    expect((await cli(["project", "create", "--github", "a/b", "--ref", "main", "--read-credential", "ghp_secretvalue"], { home })).code).toBe(2);
    const id = JSON.parse((await cli(["project", "create", "--git", mirror, "--owner", "example", "--name", "notes", "--ref", "no-such-branch", "--json"], { home })).out).id;
    expect((await cli(["project", "assess", id], { home })).code).toBe(4);
    const failed = await cli(["project", "acquire", id], { home });
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/REF_NOT_FOUND/);
    writeFileSync(join(home, "policy.json"), JSON.stringify({ [OPERATOR.id]: ["project.read"] }));
    expect((await cli(["project", "resume", id], { home })).code).toBe(3);
    expect((await cli(["project", "show", id], { home })).code).toBe(0);
    // the extraction commands are @appport/extraction's, unchanged
    expect((await cli(["--version"], { home })).out).toMatch(/@appport\/extraction/);
  });

  it("recovers a run whose process was killed: the lease expires, resume abandons it and runs the step once more", async () => {
    if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
    const { mirror, work } = notesRepository();
    const marker = join(tempDir("ws-marker-"), "hung");
    const ex = extractionsRoot(work, { mode: "hang-once", marker });
    const home = tempDir("ws-cli-");
    const principal = { id: `local:${userInfo().username}`, kind: "user" as const };
    const ws = await openWorkspace({ home, extractionsRoot: ex.root, authority: { decide: async () => ({ allowed: true }) } });
    let id: string;
    try {
      const p = await ws.createProject(principal, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" });
      id = p.id;
      for (const s of ["acquire", "pin", "inspect", "discover", "assess", "reconcile"]) await (await ws.dispatch(principal, id, s, {})).done;
      await (await ws.dispatch(principal, id, "select", { candidate: CANDIDATE })).done;
      await (await ws.dispatch(principal, id, "plan", {})).done;
      await (await ws.dispatch(principal, id, "request-approval", {})).done;
      const { subject } = await ws.approvalSubject(principal, id, "generate-files");
      await ws.approve(principal, id, { action: "generate-files", subject });
    } finally {
      await ws.close();
    }
    const env = { ...process.env, APPWORKS_HOME: home, APPWORKS_EXTRACTIONS: ex.root, APPWORKS_LEASE_MS: "1500" };
    // A CLI process runs the step; its runner hangs; the process group is killed outright (no clean-up).
    const child = spawn(process.execPath, [CLI, "project", "execute", id], { env, detached: true, stdio: "ignore" });
    const started = Date.now();
    while (!existsSync(marker) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(marker)).toBe(true);
    process.kill(-child.pid!, "SIGKILL");
    const reader = await openWorkspace({ home, extractionsRoot: ex.root, authority: { decide: async () => ({ allowed: true }) } });
    try {
      const held = await reader.project(principal, id);
      expect(held.activeRun).toMatch(/\.execute\.1$/);
      // while the lease could still be renewed, nobody else may take the project
      await expect(reader.resume(principal, id)).rejects.toMatchObject({ code: "STEP_IN_PROGRESS" });
      await new Promise((r) => setTimeout(r, 2_000));
      const resumed = await reader.resume(principal, id);
      const p = await resumed.done;
      expect(p.stage).toBe("extraction-executed");
      const runs = (await reader.records<Run>(principal, "Run", id)).filter((r) => r.step === "execute").sort((a, b) => a.attempt - b.attempt);
      expect(runs.map((r) => [r.attempt, r.status])).toEqual([
        [1, "abandoned"],
        [2, "succeeded"]
      ]);
      expect(runs[0]!.error!.code).toBe("LEASE_EXPIRED");
    } finally {
      await reader.close();
    }
  }, 60_000);
});
