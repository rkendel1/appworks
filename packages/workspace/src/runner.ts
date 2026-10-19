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
import { spawn } from "node:child_process";
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

/** A digest over every file of an extraction directory (node_modules excepted): what an approval of it covers. */
export function directoryDigest(directory: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === "node_modules") continue;
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
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ALLOWED_ENV.test(k)));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [entry.runner, "--repo", resolve(input.checkout), "--output", resolve(input.output)], { cwd: entry.directory, env, stdio: ["ignore", "pipe", "pipe"] });
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
    }, input.timeoutMs ?? 30 * 60_000);
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new WorkspaceError("RUNNER_FAILED", `the extraction runner could not start: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      done({ exitCode, signal, output: chunks.join(""), timedOut });
    });
  });
}
