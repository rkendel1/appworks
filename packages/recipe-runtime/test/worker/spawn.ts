/**
 * Runs worker.ts as a separate OS process under vite-node (which resolves the TypeScript sources and the workspace
 * aliases exactly as the tests do) and reports how it ended. `signal: "SIGKILL"` means it died by its own kill, i.e. a
 * real process death at the point the spec named, not a thrown error.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunView } from "../../src/index.js";
import type { WorkerSpec } from "./worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const viteNode = join(dirname(createRequire(require.resolve("vitest/package.json")).resolve("vite-node/package.json")), "vite-node.mjs");

export type WorkerResult = { ok: true; view: RunView } | { ok: false; code: string; message: string };

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  result?: WorkerResult;
  stderr: string;
}

export function runWorker(spec: WorkerSpec): Promise<WorkerExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteNode, "--root", root, "--config", join(root, "vitest.config.ts"), join(here, "worker.ts")], {
      cwd: root,
      env: { ...process.env, WORKER_SPEC: JSON.stringify(spec) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timed out\n${stderr}`));
    }, 90_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      resolve({ code, signal, ...(line ? { result: JSON.parse(line.slice(7)) as WorkerResult } : {}), stderr });
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
