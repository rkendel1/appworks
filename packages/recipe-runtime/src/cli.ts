#!/usr/bin/env node
/**
 * `appworks recipe run | status | resume` (spec/runtime-1.md §10). The environment module is the operator's: it is the one
 * place that says where providers are and which grants exist. A recipe names none of that.
 *
 *   appworks recipe run <recipe.json> --input <json|@file> --environment <module> [--principal <name>] [--home <dir>] [--json]
 *   appworks recipe run --package <installed-dir> --input <json|@file> --environment <module> ...      (from an installed package)
 *   appworks recipe status <run> [--home <dir>] [--json]
 *   appworks recipe resume <run> --environment <module> [--home <dir>] [--json]
 *   appworks recipe reconcile <run> --environment <module> [--principal <name>] [--home <dir>] [--json]
 *   appworks recipe answer <run> <step> --response <json|@file> --environment <module> [--principal <name>] [--home <dir>] [--json]
 *   appworks recipe expire <run> <step> --environment <module> [--principal <name>] [--home <dir>] [--json]
 *
 * Exit status: 0 completed, 10 rejected, 11 failed, 12 uncertain, 20 waiting for a human task, 2 usage, 1 refused or error.
 * `status` lists pending tasks and reconciliations. `reconcile` looks up a lost consequential invocation by its operation key and
 * never submits anything (spec §6.5); it can leave the run uncertain.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { permissiveAuthority, unavailableGateway, type CapabilityGateway, type RuntimeAuthority } from "./gateway.js";
import { RecipeRuntime, type RunView } from "./engine.js";
import { RuntimeError } from "./model.js";
import { loadInstalledRecipe } from "./installed.js";

export interface LoadedEnvironment {
  gateway: CapabilityGateway;
  authority?: RuntimeAuthority;
  close?(): Promise<void> | void;
}

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export interface CliEnvironment {
  /** Loads an environment module; defaults to importing it. Tests inject one. */
  load?(modulePath: string, context: { home: string }): Promise<LoadedEnvironment>;
  now?: () => number;
}

const USAGE = `usage:
  appworks recipe run <recipe.json> --input <json|@file> --environment <module> [--principal <name>] [--home <dir>] [--json]
  appworks recipe run --package <installed-dir> --input <json|@file> --environment <module> [--principal <name>] [--home <dir>] [--json]
  appworks recipe status <run> [--home <dir>] [--json]
  appworks recipe resume <run> --environment <module> [--home <dir>] [--json]
  appworks recipe reconcile <run> --environment <module> [--principal <name>] [--home <dir>] [--json]
  appworks recipe answer <run> <step> --response <json|@file> --environment <module> [--principal <name>] [--home <dir>] [--json]
  appworks recipe expire <run> <step> --environment <module> [--principal <name>] [--home <dir>] [--json]
exit: 0 completed, 10 rejected, 11 failed, 12 uncertain, 20 waiting for a task, 2 usage, 1 refused or error`;

const EXIT = { completed: 0, rejected: 10, failed: 11, uncertain: 12 } as const;

function parse(args: string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (key === "json" || next === undefined || next.startsWith("--")) options[key] = true;
      else {
        options[key] = next;
        i++;
      }
    }
  }
  return { positional, options };
}

async function defaultLoad(modulePath: string, context: { home: string }): Promise<LoadedEnvironment> {
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as { default?: (context: { home: string }) => LoadedEnvironment | Promise<LoadedEnvironment> };
  if (typeof loaded.default !== "function") throw new RuntimeError("INVARIANT", `${modulePath} must default-export a function returning { gateway, authority?, close? }`);
  return loaded.default(context);
}

function describe(run: RunView): string[] {
  const lines = [`run ${run.id}: ${run.status}${run.outcome ? ` / ${run.outcome}` : ""}${run.interrupted ? " (interrupted: its worker's lease expired; resume takes it over)" : ""}`, `  recipe: ${run.recipeId} ${run.recipeDigest}`];
  if (run.origin) lines.push(`  origin: ${JSON.stringify(run.origin)}`);
  lines.push(`  assessment: ${run.assessment.state} - ${run.assessment.summary}`);
  for (const e of run.assessment.evidence.filter((x) => x.result !== "confirmed")) lines.push(`    ${e.stepId}/${e.methodId} (${e.source}): ${e.result}${e.reason ? ` - ${e.reason}` : ""}`);
  if (run.assessment.next) lines.push(`  next: ${run.assessment.next}`);
  if (run.assessment.rechecks) lines.push(`  verification recoveries so far: ${run.assessment.rechecks}`);
  if (run.endStep) lines.push(`  ended at: ${run.endStep}${run.reason ? ` (${run.reason})` : ""}`);
  else lines.push(`  at step: ${run.currentStep}`);
  if (run.output !== undefined) lines.push(`  output: ${JSON.stringify(run.output)}`);
  for (const i of run.invocations) lines.push(`  ${i.purpose === "verification" ? "probe" : "invoke"} ${i.stepId} [${i.effect}] ${i.status}${i.classification ? ` (${i.classification})` : ""}${i.cause ? ` cause=${i.cause}` : ""}`);
  for (const v of run.verifications) lines.push(`  verify ${v.stepId}/${v.methodId} (${v.source}): ${v.result}${v.reason ? ` - ${v.reason}` : ""}`);
  for (const r of run.reconciliations) lines.push(`  reconcile ${r.stepId}: ${r.resolution}${r.reason ? ` - ${r.reason}` : ""} (by ${r.by})`);
  for (const t of run.tasks) lines.push(`  task ${t.stepId} for ${t.role}${t.approval ? " (approval)" : ""}: ${t.status}${t.answeredBy ? ` by ${t.answeredBy}` : ""}`);
  return lines;
}

const principalOf = (options: Record<string, string | true>): string => (typeof options["principal"] === "string" ? options["principal"] : userInfo().username);

const exitFor = (run: RunView): number => (run.status === "waiting" ? 20 : run.outcome ? EXIT[run.outcome] : 1);

export async function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }, environment: CliEnvironment = {}): Promise<number> {
  const args = argv[0] === "recipe" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (!["run", "status", "resume", "reconcile", "answer", "expire"].includes(command ?? "")) {
    io.err(USAGE);
    return 2;
  }
  const { positional, options } = parse(rest);
  const target = positional[0] ?? (command === "run" && typeof options["package"] === "string" ? "(installed package)" : undefined);
  if (!target) {
    io.err(USAGE);
    return 2;
  }
  const home = resolve(String(options["home"] ?? process.env["APPWORKS_RECIPE_HOME"] ?? join(homedir(), ".appworks", "recipe-runs")));
  const needsEnvironment = command !== "status";
  const modulePath = typeof options["environment"] === "string" ? options["environment"] : undefined;
  if (needsEnvironment && !modulePath) {
    io.err("--environment <module> is required: a recipe names no provider, so the operator says where they are");
    return 2;
  }
  let loaded: LoadedEnvironment | undefined;
  let runtime: RecipeRuntime | undefined;
  try {
    loaded = needsEnvironment ? await (environment.load ?? defaultLoad)(modulePath!, { home }) : undefined;
    runtime = await RecipeRuntime.open({ home, gateway: loaded?.gateway ?? unavailableGateway, authority: loaded?.authority ?? permissiveAuthority, ...(environment.now ? { now: environment.now } : {}) });
    let run: RunView;
    if (command === "run") {
      // From an installed package the recipe is the package's own, re-verified now; never a file the operator could have edited since.
      const installed = typeof options["package"] === "string" ? loadInstalledRecipe(resolve(options["package"])) : undefined;
      const recipe = installed ? installed.recipe : (JSON.parse(readFileSync(resolve(target), "utf8")) as unknown);
      const raw = options["input"];
      if (typeof raw !== "string") {
        io.err("--input <json|@file> is required");
        return 2;
      }
      const input = JSON.parse(raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw) as unknown;
      run = await runtime.start(recipe, input, principalOf(options), installed ? { origin: installed.origin } : {});
    } else if (command === "resume") run = await runtime.resume(target);
    else if (command === "reconcile") run = await runtime.reconcile(target, principalOf(options));
    else if (command === "answer" || command === "expire") {
      const step = positional[1];
      if (!step) {
        io.err(USAGE);
        return 2;
      }
      if (command === "expire") run = await runtime.expireTask(target, step, principalOf(options));
      else {
        const raw = options["response"];
        if (typeof raw !== "string") {
          io.err("--response <json|@file> is required");
          return 2;
        }
        run = await runtime.answerTask(target, step, JSON.parse(raw.startsWith("@") ? readFileSync(resolve(raw.slice(1)), "utf8") : raw), principalOf(options));
      }
    } else run = await runtime.status(target);
    io.out(options["json"] === true ? JSON.stringify(run, null, 2) : describe(run).join("\n"));
    return command === "status" && run.status === "running" ? 0 : exitFor(run);
  } catch (error) {
    const e = error as RuntimeError;
    io.err(options["json"] === true ? JSON.stringify({ error: { code: e.code ?? "ERROR", message: e.message, ...(e.details ? { details: e.details } : {}) } }) : `${e.code ?? "error"}: ${e.message}`);
    return 1;
  } finally {
    await runtime?.close();
    await loaded?.close?.();
  }
}

const invoked = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
      } catch {
        return false;
      }
    })()
  : false;
if (invoked) void main(process.argv.slice(2)).then((code) => (process.exitCode = code));
