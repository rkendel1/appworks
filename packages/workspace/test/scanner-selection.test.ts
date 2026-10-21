/**
 * Explicit scanner selection. The scanner is an input of `assess`, recorded on the run and in the assessment, never chosen by what a scanner
 * finds. Fixtures that tell the scanners apart: Express only, Protocol Buffers and Go only, both together, and a Go proxy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessRepository, verifyAssessment, type ApplicationAssessment } from "@appport/assessment";
import { createWorkspaceServer, eligibleActions, main, nothingExtractable, projectView, scannerOf, type ProjectView, type Run } from "../src/index.js";
import { syntheticApp, tempDir, writeTree } from "../../assessment/test/helpers.js";
import { OPERATOR, openWorkspace, step } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
function mirrorOf(files: Record<string, string>): string {
  const work = writeTree(tempDir("ws-scanner-"), files);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const mirror = join(tempDir("ws-mirror-"), "repo.git");
  git(work, "clone", "-q", "--bare", "--no-local", work, mirror);
  return mirror;
}

/** An Express application: an app mounting a router under `/api`, behind a guard. Not a line of Go or Protocol Buffers. */
const EXPRESS: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop-api", dependencies: { express: "^4" } }),
  "src/app.js": "const express = require('express');\nconst api = require('./api');\nconst app = express();\napp.use('/api', guard, api);\nmodule.exports = app;\n",
  "src/api.js": "const router = require('express').Router();\nconst orders = require('./orders');\nrouter.get('/orders', orders.list);\nrouter.post('/orders', orders.create);\nmodule.exports = router;\n",
  "src/orders.js": "exports.list = async (req, res) => {};\nexports.create = async (req, res) => {};\n"
};
/** Protocol Buffers and Go (the synthetic notes service), plus the same Express application under web/. */
const MIXED: Record<string, string> = { ...syntheticApp(), ...Object.fromEntries(Object.entries(EXPRESS).map(([k, v]) => [`web/${k}`, v])) };
/** A Go reverse proxy: one catch-all route. Nothing for either scanner, and no JavaScript. */
const GO_PROXY: Record<string, string> = {
  "go.mod": "module example.com/router\n\ngo 1.22\n",
  "cmd/main.go": 'package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {})\n\t_ = http.ListenAndServe(":12000", nil)\n}\n'
};

async function project(files: Record<string, string>, options: { home?: string } = {}) {
  const ws = await openWorkspace(options.home ? { home: options.home } : {});
  const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "repo", url: "https://github.com/example/repo", fetchFrom: mirrorOf(files), ref: "main" });
  for (const name of ["acquire", "pin", "inspect", "discover"]) await step(ws, OPERATOR, p.id, name);
  return { ws, id: p.id };
}
const view = (ws: Awaited<ReturnType<typeof project>>["ws"], id: string) => projectView(ws, OPERATOR, id);
const actions = (v: ProjectView) => v.next.actions.map((a) => a.action + (a.inputs?.find((i) => i.name === "scanner") ? `:${a.inputs.find((i) => i.name === "scanner")!.value}` : ""));
const artifact = async (ws: Awaited<ReturnType<typeof project>>["ws"], id: string) => (await ws.artifact<ApplicationAssessment>(OPERATOR, (await ws.project(OPERATOR, id)).current.assessment))!.body;
const refusal = async (promise: () => Promise<unknown>) => {
  try {
    await promise();
  } catch (error) {
    return error as { code: string; message: string };
  }
  return undefined;
};

describe("the default and the explicit choice", () => {
  it("assesses with scanner 1 unless told otherwise, whatever the repository holds", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess");
      const body = await artifact(ws, id);
      expect(body).toMatchObject({ format: "appport.application-assessment/1", configuration: { scanner: "appport.assessment-scanner/1" } });
      expect(body.candidates).toEqual([]); // an Express application has nothing for scanner 1, and the workspace did not go looking with another
      expect((await view(ws, id)).assessment).toMatchObject({ scanner: 1, candidates: 0 });
    } finally {
      await ws.close();
    }
  });

  it("assesses with scanner 2 only when asked, and records the choice on the run, in the assessment and in the view", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess", { scanner: "2" });
      const body = await artifact(ws, id);
      expect(body).toMatchObject({ format: "appport.application-assessment/2", configuration: { scanner: "appport.assessment-scanner/2" } });
      expect(body.candidates.map((c) => c.name).sort()).toEqual(["GET /api/orders", "POST /api/orders"]);
      expect(scannerOf(body)).toBe(2);
      const runs = await ws.records<Run & { input?: Record<string, unknown> }>(OPERATOR, "Run", id);
      expect(runs.find((r) => r.step === "assess")!.input).toEqual({ scanner: "2" });
      const v = await view(ws, id);
      expect(v.assessment).toMatchObject({ scanner: 2, candidates: 2, operations: { rpc: 0, http: 2 } });
      // scanner 2's assessment still verifies against the pinned checkout
      expect(verifyAssessment(body, { repository: ws.store.resolve(v.project.revision!.checkout) }).ok).toBe(true);
    } finally {
      await ws.close();
    }
  });

  it("refuses a scanner that is neither 1 nor 2, before anything is claimed", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      expect(await refusal(() => ws.dispatch(OPERATOR, id, "assess", { scanner: "3" }))).toMatchObject({ code: "INVALID_INPUT" });
      expect(await refusal(() => ws.dispatch(OPERATOR, id, "assess", { scanner: "two" }))).toMatchObject({ code: "INVALID_INPUT" });
      expect((await ws.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "assess")).toEqual([]);
      expect((await ws.project(OPERATOR, id)).condition.state).toBe("active");
    } finally {
      await ws.close();
    }
  });
});

describe("the scanner is not inferred from what is found", () => {
  it("a repository with both RPCs and HTTP routes is assessed by the scanner named, and never switches", async () => {
    const one = await project(MIXED);
    try {
      await step(one.ws, OPERATOR, one.id, "assess");
      expect((await view(one.ws, one.id)).assessment).toMatchObject({ scanner: 1, operations: { rpc: 2, http: 0 } }); // the routes are not read, and nothing falls back to reading them
    } finally {
      await one.ws.close();
    }
    const two = await project(MIXED);
    try {
      await step(two.ws, OPERATOR, two.id, "assess", { scanner: "2" });
      const v = await view(two.ws, two.id);
      expect(v.assessment).toMatchObject({ scanner: 2 });
      expect(v.assessment!.operations.rpc).toBe(2); // scanner 2 keeps every RPC scanner 1 finds
      expect(v.assessment!.operations.http).toBeGreaterThan(0);
    } finally {
      await two.ws.close();
    }
  });

  it("scanner 1's assessment is exactly what the library makes with scanner 1: the workspace adds and removes nothing", async () => {
    const { ws, id } = await project(MIXED);
    try {
      await step(ws, OPERATOR, id, "assess");
      const p = await ws.project(OPERATOR, id);
      const direct = assessRepository(ws.store.resolve(p.revision!.checkout));
      expect((await artifact(ws, id)).digest).toBe(direct.digest);
    } finally {
      await ws.close();
    }
  });

  it("the workspace contains no implicit fallback: one assessment call, with the scanner it was given", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "workflow.ts"), "utf8");
    expect(source.match(/assessRepository\(/g)).toHaveLength(1);
    expect(source).toContain("assessRepository(checkout, { scanner })");
    expect(source).not.toMatch(/candidates\.length\)\s*assessment\s*=/);
  });
});

describe("assessing again with the other scanner", () => {
  it("is explicit, replaces the current evidence, clears what was made from it, and keeps the old assessment on record", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess");
      const first = (await ws.project(OPERATOR, id)).current.assessment!;
      await step(ws, OPERATOR, id, "reconcile");
      expect((await ws.project(OPERATOR, id)).current.inventory).toBeDefined();

      await step(ws, OPERATOR, id, "assess", { scanner: "2" });
      const p = await ws.project(OPERATOR, id);
      expect(p.stage).toBe("assessment-completed");
      expect(p.current.assessment).not.toBe(first);
      expect(p.current.inventory).toBeUndefined(); // made from the old assessment: cleared
      // the old assessment is still there, with its own scanner, and so is the history of both runs
      const old = await ws.artifact<ApplicationAssessment>(OPERATOR, first);
      expect(old && scannerOf(old.body)).toBe(1);
      const runs = (await ws.records<Run & { input?: Record<string, unknown> }>(OPERATOR, "Run", id)).filter((r) => r.step === "assess").sort((a, b) => a.attempt - b.attempt);
      expect(runs.map((r) => r.input)).toEqual([{}, { scanner: "2" }]);
      expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    } finally {
      await ws.close();
    }
  });

  it("with no scanner named, keeps the one the project has instead of falling back to the default; assessing again with the same scanner is refused without recording a failure", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess", { scanner: "2" });
      for (const input of [{}, { scanner: "2" }]) {
        expect(await refusal(() => ws.dispatch(OPERATOR, id, "assess", input))).toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("already assessed with scanner 2") });
      }
      const p = await ws.project(OPERATOR, id);
      expect(p.condition.state).not.toBe("failed"); // a mistaken request is not a failed run (the assessment's own partial coverage is not one either)
      expect((await ws.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "assess")).toHaveLength(1);
      expect(scannerOf(await artifact(ws, id))).toBe(2);
    } finally {
      await ws.close();
    }
  });

  it("is not available once a plan exists, as the flow declares", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess");
      expect(await refusal(() => ws.dispatch(OPERATOR, id, "assess", { scanner: "2" }).then((s) => s.done))).toBeUndefined(); // from assessment-completed
      await ws.cancel(OPERATOR, id, "done");
      expect(await refusal(() => ws.dispatch(OPERATOR, id, "assess", { scanner: "1" }))).toMatchObject({ code: "PROJECT_CANCELLED" });
    } finally {
      await ws.close();
    }
  });
});

describe("the choice survives the lifecycle", () => {
  it("is still recorded after the workspace is closed and opened again", async () => {
    const home = tempDir("ws-home-");
    const first = await project(EXPRESS, { home });
    await step(first.ws, OPERATOR, first.id, "assess", { scanner: "2" });
    const digest = (await artifact(first.ws, first.id)).digest;
    await first.ws.close();
    const ws = await openWorkspace({ home });
    try {
      const v = await view(ws, first.id);
      expect(v.assessment).toMatchObject({ scanner: 2, digest });
      expect(scannerOf(await artifact(ws, first.id))).toBe(2);
      expect((await ws.records<Run & { input?: Record<string, unknown> }>(OPERATOR, "Run", first.id)).find((r) => r.step === "assess")!.input).toEqual({ scanner: "2" });
    } finally {
      await ws.close();
    }
  });
});

describe("what the advisor says, and what the CLI and the page show", () => {
  it("under scanner 1 it does not claim to have read JavaScript, and offers scanner 2 only where JavaScript or TypeScript was left unread", async () => {
    const express = await project(EXPRESS);
    try {
      await step(express.ws, OPERATOR, express.id, "assess");
      const v = await view(express.ws, express.id);
      expect(v.next.summary).toMatch(/Scanner 1 reads Protocol Buffers services and Go entry points; this repository has \d+ JavaScript or TypeScript files it did not read/);
      expect(v.next.summary).not.toMatch(/Scanner 2 reads/);
      expect(actions(v)).toEqual(["assess:2", "cancel"]);
      const offer = v.next.actions.find((a) => a.action === "assess")!;
      expect(offer.label).toBe("Re-assess with scanner 2");
      expect(offer.reason).toMatch(/did not analyze \d+ JavaScript\/TypeScript files/);
      expect(offer.reason).toMatch(/cleared; this assessment stays in the record/);
    } finally {
      await express.ws.close();
    }
    // no JavaScript at all: nothing for scanner 2 to read, so it is not offered, and the summary does not mention it
    const proxy = await project(GO_PROXY);
    try {
      await step(proxy.ws, OPERATOR, proxy.id, "assess");
      const v = await view(proxy.ws, proxy.id);
      expect(actions(v)).toEqual(["cancel"]);
      expect(v.next.summary).toMatch(/Nothing to extract/);
      expect(v.next.summary).not.toMatch(/scanner 2|JavaScript/i);
    } finally {
      await proxy.ws.close();
    }
    // a repository scanner 1 assessed fully (RPCs) with a web front end: scanner 2 is still on offer, with what it would change, and nothing is switched
    const mixed = await project(MIXED);
    try {
      await step(mixed.ws, OPERATOR, mixed.id, "assess");
      expect(actions(await view(mixed.ws, mixed.id))).toEqual(expect.arrayContaining(["reconcile", "assess:2"]));
    } finally {
      await mixed.ws.close();
    }
  });

  it("under scanner 2 it says so, and offers the way back", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess", { scanner: "2" });
      await step(ws, OPERATOR, id, "reconcile");
      const v = await view(ws, id);
      expect(v.project.stage).toBe("inventory-reconciled");
      expect(v.next.summary).toMatch(/2 candidates were found \(2 HTTP routes, 0 RPCs\) and none can be extracted yet/);
      expect(actions(v)).toEqual(["assess:1", "cancel"]);
      expect(v.next.actions.find((a) => a.action === "assess")!.label).toBe("Re-assess with scanner 1");
    } finally {
      await ws.close();
    }
  });

  it("the CLI, the web API and the page's source agree on the scanner, and a flag selects it", async () => {
    const home = tempDir("ws-cli-");
    const extractions = tempDir("ws-extractions-"); // none: the CLI and the web workspace must see the same reviewed extractions
    const mirror = mirrorOf(EXPRESS);
    const run = async (...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(argv, { out: (t) => void out.push(t), err: (t) => void err.push(t) }, { home, extractions, principal: OPERATOR, env: {} });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const id = JSON.parse((await run("project", "create", "--git", mirror, "--owner", "example", "--name", "repo", "--url", "https://github.com/example/repo", "--ref", "main", "--json")).out).id as string;
    for (const s of ["acquire", "pin", "inspect", "discover"]) expect((await run("project", s, id)).code).toBe(0);
    expect((await run("project", "assess", id)).code).toBe(0);
    expect((await run("project", "show", id)).out).toMatch(/assessment: sha256:[0-9a-f]{64} \(scanner 1\)/);
    expect((await run("project", "assess", id, "--scanner", "2")).code).toBe(0);
    expect((await run("project", "show", id)).out).toMatch(/assessment: sha256:[0-9a-f]{64} \(scanner 2\).*2 candidates/);
    expect((await run("project", "assess", id, "--scanner", "9")).code).not.toBe(0);

    const cliView = JSON.parse((await run("project", "show", id, "--json")).out) as ProjectView;
    const ws = await openWorkspace({ home, extractionsRoot: extractions });
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    try {
      const web = (await (await fetch(`${origin}/api/projects/${id}`)).json()) as ProjectView;
      expect(web.assessment!.scanner).toBe(2);
      expect(web).toEqual(cliView);
      const posted = await fetch(`${origin}/api/projects/${id}/actions/assess`, { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1", origin }, body: JSON.stringify({ scanner: "1" }) });
      expect(posted.status).toBeLessThan(300);
    } finally {
      await server.close();
      await ws.close();
    }
    // the page renders the scanner from the same field
    expect(readFileSync(join(import.meta.dirname, "..", "ui", "workspace.js"), "utf8")).toContain("a.scanner");
  });
});

describe("what scanner selection does not change", () => {
  it("HTTP candidates stay unselectable, and the advisor does not offer to select them", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      await step(ws, OPERATOR, id, "assess", { scanner: "2" });
      await step(ws, OPERATOR, id, "reconcile");
      const v = await view(ws, id);
      expect(nothingExtractable(v)).toBe(true);
      expect(actions(v)).not.toContain("select");
      const candidate = (await artifact(ws, id)).candidates[0]!.id;
      const refused = await refusal(async () => (await ws.dispatch(OPERATOR, id, "select", { candidate })).done);
      expect(refused).toMatchObject({ code: "CANDIDATE_INELIGIBLE", message: expect.stringContaining("CANDIDATE_NOT_RPC") });
      expect((await view(ws, id)).project.stage).toBe("inventory-reconciled");
    } finally {
      await ws.close();
    }
  });

  it("the existing RPC workflow still reaches a validated plan under either scanner", async () => {
    for (const scanner of [undefined, "2"]) {
      const { ws, id } = await project(MIXED_RPC_ONLY());
      try {
        await step(ws, OPERATOR, id, "assess", scanner ? { scanner } : {});
        await step(ws, OPERATOR, id, "reconcile");
        const v = await view(ws, id);
        expect(v.assessment!.operations.rpc).toBe(2);
        expect(actions(v)).toContain("select");
      } finally {
        await ws.close();
      }
    }
  });

  it("the agent can make the first assessment but cannot assess again or choose a scanner", async () => {
    const { ws, id } = await project(EXPRESS);
    try {
      let v = await view(ws, id);
      const first = eligibleActions(v).definitions.find((d) => d.id === "workflow.assess@1")!;
      expect(first).toBeDefined();
      expect(JSON.stringify(first.input(v))).not.toContain("scanner"); // no scanner input is offered to the agent
      await step(ws, OPERATOR, id, "assess");
      v = await view(ws, id);
      expect(eligibleActions(v).definitions.map((d) => d.id)).not.toContain("workflow.assess@1");
      await step(ws, OPERATOR, id, "reconcile");
      expect(eligibleActions(await view(ws, id)).definitions.map((d) => d.id)).not.toContain("workflow.assess@1");
    } finally {
      await ws.close();
    }
  });
});

function MIXED_RPC_ONLY(): Record<string, string> {
  return syntheticApp();
}
