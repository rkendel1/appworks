#!/usr/bin/env node
// Builds, verifies and publishes every workspace package to npm. Versions already on the registry are skipped.
// Auth: NPM_TOKEN from the environment or .env.local; without one, falls back to your existing `npm login`.
//
//   pnpm publish:packages [--dry-run]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const readToken = () => {
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN;
  const file = join(root, ".env.local");
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("NPM_TOKEN="));
  return line?.slice("NPM_TOKEN=".length).trim().replace(/^["']|["']$/g, "") || undefined;
};

const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("pnpm", ["build"]);
run("pnpm", ["release:check"]);

let env = process.env;
let scratch;
const token = readToken();
if (token) {
  // A throwaway user config keeps the token out of the repository and out of ~/.npmrc.
  scratch = mkdtempSync(join(tmpdir(), "appworks-publish-"));
  const userconfig = join(scratch, ".npmrc");
  writeFileSync(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  env = { ...process.env, NPM_CONFIG_USERCONFIG: userconfig };
}

try {
  run("pnpm", ["publish", "-r", "--access", "public", "--no-git-checks", ...(dryRun ? ["--dry-run"] : [])], env);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
