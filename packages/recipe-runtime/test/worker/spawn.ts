/**
 * Runs worker.ts as a separate OS process under tsx (which runs the TypeScript sources and resolves the workspace aliases from
 * tsconfig.test.json, the same paths the tests use; vitest 5 no longer ships vite-node) and reports how it ended. `signal: "SIGKILL"` means it died by its own kill, i.e. a
 * real process death at the point the spec named, not a thrown error.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunView } from "../../src/index.js";
import type { WorkerSpec } from "./worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const require = createRequire(import.meta.url);
// tsx as a loader (`--import tsx`), not its CLI: the worker must be this process's own direct child, so that a SIGKILL it sends itself is the signal we see.
const tsx = pathToFileURL(require.resolve("tsx")).href;

export type WorkerResult = { ok: true; view: RunView } | { ok: false; code: string; message: string };

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  result?: WorkerResult;
  stderr: string;
}

export function runWorker(spec: WorkerSpec): Promise<WorkerExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, join(here, "worker.ts")], {
      cwd: root,
      env: { ...process.env, WORKER_SPEC: JSON.stringify(spec), TSX_TSCONFIG_PATH: join(root, "tsconfig.test.json") },
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
