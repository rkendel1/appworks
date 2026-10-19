import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assessRepository } from "@appport/assessment";
import { syntheticApp, tempDir, writeTree } from "../../assessment/test/helpers.js";
import { planDirectory } from "../../extraction/test/fixtures.js";
import { environmentCredentials, gitProvider, localAuthority, Workspace, type Principal, type RepositoryProvider, type WorkspaceOptions } from "../src/index.js";

export { tempDir };
export const CANDIDATE = "cand-notes.v1.NoteService.GetNote";
export const OPERATOR: Principal = { id: "local:operator", kind: "user" };
export const VIEWER: Principal = { id: "local:viewer", kind: "user" };
export const ADVANCER: Principal = { id: "local:advancer", kind: "user" };

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/** The synthetic notes service as a real git repository on `main`, its bare mirror, and the commit. */
export function notesRepository(extra: Record<string, string> = {}): { work: string; mirror: string; sha: string } {
  const work = writeTree(tempDir("ws-notes-"), { ...syntheticApp(), "bridge/kit.mjs": "export const kit = 1;\n", ...extra });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "notes");
  const sha = git(work, "rev-parse", "HEAD");
  const mirror = join(tempDir("ws-mirror-"), "notes.git");
  git(work, "clone", "-q", "--bare", "--no-local", work, mirror);
  return { work, mirror, sha };
}

/** Adds a commit on a side branch of the mirror (a revision not on main). */
export function sideBranch(work: string, mirror: string, branch: string): string {
  git(work, "checkout", "-q", "-b", branch);
  writeFileSync(join(work, "NOTES.md"), "side\n");
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "side");
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", mirror, branch);
  git(work, "checkout", "-q", "main");
  return sha;
}

export function advanceMain(work: string, mirror: string): string {
  writeFileSync(join(work, "CHANGELOG.md"), `${Date.now()}\n`);
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "more");
  git(work, "push", "-q", mirror, "main");
  return git(work, "rev-parse", "HEAD");
}

/**
 * An extractions root holding one reviewed extraction of the notes service's GetNote (the extraction tests' plan),
 * whose runner is the stub (`fixtures/stub-runner.mjs`), set to `mode`.
 */
export function extractionsRoot(sourceRoot: string, options: { mode?: string; marker?: string; declaration?: (contract: unknown) => unknown } = {}): { root: string; dir: string; setMode(mode: string): void } {
  const assessment = assessRepository(sourceRoot);
  const planDir = planDirectory(assessment, () => {}, options.declaration);
  const root = tempDir("ws-extractions-");
  const dir = join(root, "notes-get");
  execFileSync("cp", ["-R", planDir, dir]);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const runner = pathToFileURL(join(import.meta.dirname, "fixtures", "stub-runner.mjs")).href;
  writeFileSync(join(dir, "scripts", "extract.mjs"), `import(${JSON.stringify(runner)}).then((m) => m.run(import.meta.url));\n`);
  const setMode = (mode: string) => writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode, ...(options.marker ? { marker: options.marker } : {}) }));
  setMode(options.mode ?? "pass");
  return { root, dir, setMode };
}

export const POLICY = {
  [OPERATOR.id]: ["*"],
  [VIEWER.id]: ["project.read"],
  [ADVANCER.id]: ["project.read", "project.create", "project.advance", "action:*", "github:*"]
};

export async function openWorkspace(options: Partial<WorkspaceOptions> & { home?: string } = {}): Promise<Workspace> {
  return Workspace.open({
    home: options.home ?? tempDir("ws-home-"),
    authority: options.authority ?? localAuthority(POLICY),
    credentials: options.credentials ?? environmentCredentials({}),
    providers: options.providers ?? { git: gitProvider() },
    leaseMs: options.leaseMs ?? 2_000,
    ...(options.extractionsRoot ? { extractionsRoot: options.extractionsRoot } : {}),
    ...(options.worker ? { worker: options.worker } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.runnerTimeoutMs ? { runnerTimeoutMs: options.runnerTimeoutMs } : {})
  });
}

/** Runs one step to completion and returns the project. */
export async function step(ws: Workspace, principal: Principal, id: string, name: string, input: Record<string, unknown> = {}) {
  const started = await ws.dispatch(principal, id, name, input);
  return started.done;
}

/** Creates a project for the mirror and runs it to `until` (inclusive), returning its id. */
export async function advanceTo(ws: Workspace, mirror: string, until: string, input: { ref?: string; endpoint?: string; candidate?: string } = {}): Promise<string> {
  const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: input.ref ?? "main" });
  const order = ["acquire", "pin", "inspect", "discover", "assess", "reconcile", "select", "plan", "request-approval", "approve", "execute", "verify", "ready"];
  for (const name of order) {
    if (name === "approve") {
      const { subject } = await ws.approvalSubject(OPERATOR, p.id, "generate-files");
      await ws.approve(OPERATOR, p.id, { action: "generate-files", subject });
    } else await step(ws, OPERATOR, p.id, name, name === "discover" && input.endpoint ? { endpoint: input.endpoint } : name === "select" ? { candidate: input.candidate ?? CANDIDATE } : {});
    if (name === until) break;
  }
  return p.id;
}

/** A provider that records every call, for the write-boundary tests. */
export function recordingProvider(base: RepositoryProvider, calls: string[], options: { failAfterCreate?: { once: boolean } } = {}): RepositoryProvider {
  let opened = 0;
  return {
    kind: base.kind,
    resolve: base.resolve.bind(base),
    async createPullRequest(_repository, input) {
      calls.push(`create ${input.head}->${input.base}`);
      opened++;
      if (options.failAfterCreate?.once) {
        options.failAfterCreate.once = false;
        throw new Error("connection lost after the pull request was created");
      }
      return { number: 7, url: "https://example.test/pr/7", existing: opened > 1 };
    }
  };
}
