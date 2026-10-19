/**
 * Extractions the workspace can plan and execute: the reviewed extraction directories under `extractions/` (one plan,
 * contract, adapter, declaration and behavioral suite each). The workspace generates no code: it validates a plan with
 * the extraction library and, once approved, runs that extraction's own runner.
 *
 * The runner contract: `node <dir>/scripts/extract.mjs --repo <checkout> --output <file>` builds and verifies against
 * the checkout, writes the `appport.capability-extraction` artifact to `<file>` (also when a behavior failed) and never
 * writes to the checkout. It runs as a child process with an allow-listed environment: no repository credential, no
 * workspace variable, and nothing from the project's records.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WorkspaceError } from "./model.js";

export interface ExtractionEntry {
  /** Directory name under the extractions root, e.g. `memos-reactions`. */
  name: string;
  directory: string;
  planPath: string;
  candidate: string;
  identity: { name: string; revision: number; previous?: string };
  /** The committed artifact of the previous revision, when the plan names one. */
  previousPath?: string;
  runner: string;
}

/** Every extraction directory with a plan and a runner. */
export function listExtractions(root: string): ExtractionEntry[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const directory = join(root, name);
      const planPath = join(directory, "extraction-plan.json");
      const runner = join(directory, "scripts", "extract.mjs");
      if (!existsSync(planPath) || !existsSync(runner)) return [];
      let plan: { candidate?: string; identity?: ExtractionEntry["identity"] };
      try {
        plan = JSON.parse(readFileSync(planPath, "utf8"));
      } catch {
        return [];
      }
      if (typeof plan.candidate !== "string" || !plan.identity) return [];
      const previousPath = plan.identity.revision > 1 ? join(directory, "revisions", String(plan.identity.revision - 1), "extraction.json") : undefined;
      return [{ name, directory, planPath, candidate: plan.candidate, identity: plan.identity, ...(previousPath && existsSync(previousPath) ? { previousPath } : {}), runner }];
    });
}

/**
 * A digest over every file of an extraction directory: what an approval of the extraction covers. `node_modules` is
 * excepted, and so is the top-level `promotion/` directory, which the promotion artifact covers itself (its plan and
 * runner digests): changing how an extraction is promoted does not change the extraction.
 */
export function directoryDigest(directory: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules" || name === ".mutations" || (dir === directory && name === "promotion")) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) hash.update(`${relative(directory, path)}\0`).update(readFileSync(path)).update("\0");
    }
  };
  visit(directory);
  return `sha256:${hash.digest("hex")}`;
}

const ALLOWED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TZ|GO[A-Z0-9_]*|CGO_[A-Z_]+|CC|CXX|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|PNPM_HOME)$/;

export interface RunnerResult {
  exitCode: number | null;
  signal: string | null;
  output: string;
  timedOut: boolean;
}

/** Runs an extraction's runner. Resolves when it exits; never throws for a non-zero exit (that is a result). */
export function runExtraction(entry: ExtractionEntry, input: { checkout: string; output: string; timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }): Promise<RunnerResult> {
  return runScript(entry.directory, entry.runner, ["--repo", resolve(input.checkout), "--output", resolve(input.output)], input);
}

/**
 * Runs an extraction's promotion verification runner (the promotion plan's `verification.runner`):
 * `--repo <worktree> --host <promoted host directory> --output <file> [--mutations]`. Same environment rules.
 */
export function runPromotionVerification(entry: ExtractionEntry, runner: string, input: { worktree: string; host: string; output: string; mutations: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<RunnerResult> {
  return runScript(entry.directory, join(entry.directory, runner), ["--repo", resolve(input.worktree), "--host", resolve(input.host), "--output", resolve(input.output), ...(input.mutations ? ["--mutations"] : [])], input);
}

function runScript(cwd: string, script: string, args: string[], input: { timeoutMs?: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }): Promise<RunnerResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOWED_ENV.test(k)));
  return collect(spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }), { ...input, timeoutMs: input.timeoutMs ?? 30 * 60_000 }, "the extraction runner");
}

function collect(child: ChildProcessByStdio<null, Readable, Readable>, input: { timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }, what: string): Promise<RunnerResult> {
  return new Promise((done, fail) => {
    const chunks: string[] = [];
    let size = 0;
    const keep = (data: Buffer) => {
      const text = data.toString("utf8");
      input.onOutput?.(text);
      chunks.push(text);
      size += text.length;
      while (size > 512 * 1024 && chunks.length > 1) size -= chunks.shift()!.length;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new WorkspaceError("RUNNER_FAILED", `${what} could not start: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      done({ exitCode, signal, output: chunks.join(""), timedOut });
    });
  });
}

// ---- an installed AppPort integration --------------------------------------------------------------------------

/** npm's own configuration (registry, cache, CA) is passed to the package installer, and to nothing else. */
const INSTALL_ENV = /^(npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+)$/;

/**
 * Installs an AppPort integration's pinned packages: `npm install` with lifecycle scripts disabled, so no package code
 * runs while installing. Never throws for a failed install (that is a result).
 */
export function installPackages(directory: string, input: { timeoutMs?: number; signal?: AbortSignal; npm?: string } = {}): Promise<RunnerResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOWED_ENV.test(k) || INSTALL_ENV.test(k)));
  return collect(spawn(input.npm ?? "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=dev"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] }), { timeoutMs: input.timeoutMs ?? 10 * 60_000, ...(input.signal ? { signal: input.signal } : {}) }, "the package installer");
}

export interface RunningIntegration {
  origin: string;
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts an installed AppPort integration (`node server.mjs` in its directory) on a free loopback port, with the
 * allow-listed environment and nothing else, and resolves with its origin once it says where it listens.
 */
export function startIntegration(directory: string, input: { timeoutMs?: number } = {}): Promise<RunningIntegration> {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOWED_ENV.test(k))), APPPORT_PORT: "0" };
  const child = spawn(process.execPath, ["server.mjs"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  };
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      void stop();
      fail(new WorkspaceError("INTEGRATION_NOT_STARTED", `the installed integration did not report where it listens within ${input.timeoutMs ?? 30_000}ms: ${output.slice(-2_000)}`));
    }, input.timeoutMs ?? 30_000);
    const read = (data: Buffer) => {
      output = (output + data.toString("utf8")).slice(-64 * 1024);
      const m = /\bon (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        done({ origin: m[1]!, output: () => output, stop });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(new WorkspaceError("INTEGRATION_NOT_STARTED", `the installed integration could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      fail(new WorkspaceError("INTEGRATION_NOT_STARTED", `the installed integration exited (${code}) before listening: ${output.slice(-2_000)}`));
    });
  });
}
