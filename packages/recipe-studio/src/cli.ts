#!/usr/bin/env node
/**
 * `appworks studio ...`: the Studio from a terminal. Every command calls the same functions the page does.
 *
 *   studio serve    --dir <projects> --environment <[name=]module[,…]> [--principal <name>] [--port <n>] [--home <dir>]
 *   studio new      <project> --dir <projects> --id <reverse.domain.id> --name <text> --objective <text> [--product <id>] [--version <semver>]
 *   studio import   <project> <recipe.json> --dir <projects> [--product <id>] [--version <semver>]
 *   studio validate <project> --dir <projects> [--environment <[name=]module>] [--principal <name>] [--json]
 *   studio card     <project> --dir <projects> [--json]
 *   studio package  <project> --dir <projects> --environment <[name=]module> [--json]
 *
 * Publishing, trust, installation and running are not here: they are `appworks package ...` and `appworks recipe run --package`.
 * Exit status: 0 done (`validate`: ready or ready with unresolved facts), 1 refused, invalid or blocked, 2 usage.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import type { RecipeSource } from "@appport/recipe";
import { recipeCard } from "./card.js";
import { moduleLoader, type EnvironmentLoader, type StudioEnvironment } from "./environment.js";
import { newRecipe } from "./edit.js";
import { packageProject } from "./package.js";
import { StudioStore } from "./project.js";
import { assess } from "./readiness.js";
import { createStudioServer } from "./server.js";

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}
export interface CliEnvironment {
  /** Loads an environment module; tests inject one. */
  load?: (modulePath: string, context: { home: string }) => Promise<Omit<StudioEnvironment, "name">>;
  /** Called with the running server's origin; tests use it to learn the port and to stop it. */
  onServing?: (origin: string, stop: () => Promise<void>) => void;
}

const USAGE = `usage:
  appworks studio serve    --dir <projects> --environment <[name=]module[,…]> [--principal <name>] [--port <n>] [--home <dir>]
  appworks studio new      <project> --dir <projects> --id <reverse.domain.id> --name <text> --objective <text> [--product <id>] [--version <semver>]
  appworks studio import   <project> <recipe.json> --dir <projects> [--product <id>] [--version <semver>]
  appworks studio validate <project> --dir <projects> [--environment <[name=]module>] [--principal <name>] [--json]
  appworks studio card     <project> --dir <projects> [--json]
  appworks studio package  <project> --dir <projects> --environment <[name=]module> [--json]`;

class Usage extends Error {}

function parse(args: string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else {
      const next = args[i + 1];
      if (a === "--json" || next === undefined || next.startsWith("--")) options[a.slice(2)] = true;
      else {
        options[a.slice(2)] = next;
        i++;
      }
    }
  }
  return { positional, options };
}

const need = (options: Record<string, string | true>, name: string): string => {
  const v = options[name];
  if (typeof v !== "string") throw new Usage(`--${name} is required`);
  return v;
};

async function defaultLoad(modulePath: string, context: { home: string }) {
  return (moduleLoader(modulePath) as EnvironmentLoader)(context);
}

export async function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }, env: CliEnvironment = {}): Promise<number> {
  const args = argv[0] === "studio" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  const { positional, options } = parse(rest);
  const json = options["json"] === true;
  const say = (human: string[], machine: unknown) => io.out(json ? JSON.stringify(machine, null, 2) : human.join("\n"));
  const home = resolve(String(options["home"] ?? "."));
  const environments = async (required: boolean): Promise<StudioEnvironment[]> => {
    const spec = options["environment"];
    if (typeof spec !== "string") {
      if (required) throw new Usage("--environment <[name=]module> is required");
      return [];
    }
    return Promise.all(
      spec.split(",").map(async (part) => {
        const at = part.indexOf("=");
        const [name, modulePath] = at > 0 ? [part.slice(0, at), part.slice(at + 1)] : [basename(part).replace(/\.[cm]?[jt]s$/, ""), part];
        return { name, ...(await (env.load ?? defaultLoad)(modulePath, { home })) };
      })
    );
  };
  const principal = typeof options["principal"] === "string" ? options["principal"] : userInfo().username;
  const release = { ...(typeof options["product"] === "string" ? { product: options["product"] } : {}), ...(typeof options["version"] === "string" ? { version: options["version"] } : {}) };

  if (!["serve", "new", "import", "validate", "card", "package"].includes(command ?? "")) {
    io.err(USAGE);
    return 2;
  }
  try {
    const store = new StudioStore(resolve(need(options, "dir")));
    switch (command) {
      case "serve": {
        const envs = await environments(true);
        const app = createStudioServer({ store, environments: envs, principal, ...(typeof options["port"] === "string" ? { port: Number(options["port"]) } : {}) });
        const origin = await app.listen();
        const stop = async () => {
          await app.close();
          await Promise.all(envs.map((e) => e.close?.()));
        };
        io.out(`Recipe Studio on ${origin} (loopback only; acts as ${principal}); projects in ${store.root}`);
        env.onServing?.(origin, stop);
        if (!env.onServing) await new Promise<void>((done) => process.once("SIGINT", () => void stop().then(done)));
        return 0;
      }
      case "new": {
        const slug = positional[0];
        if (!slug) throw new Usage("a project name is required");
        const project = store.create(slug, newRecipe({ id: need(options, "id"), name: need(options, "name"), objective: need(options, "objective") }), release);
        say([`created ${project.slug} (${store.recipePath(slug)})`], { slug, recipe: store.recipePath(slug) });
        return 0;
      }
      case "import": {
        const [slug, file] = positional;
        if (!slug || !file) throw new Usage("a project name and a recipe file are required");
        const project = store.import(slug, readFileSync(resolve(file), "utf8"), release);
        say([`imported ${file} as ${project.slug}: saved, granting nothing`], { slug, recipe: store.recipePath(slug) });
        return 0;
      }
      case "validate":
      case "card":
      case "package": {
        const slug = positional[0];
        if (!slug) throw new Usage("a project name is required");
        const project = store.open(slug);
        if (command === "card") {
          const card = recipeCard(project.recipe as RecipeSource);
          say([card.title, `  (${card.purpose})`, ...card.setup.map((s) => `  - ${s}`), ...card.columns.map((c) => `  step ${c.step}: ${c.action} [rows ${c.from}-${c.to}]`)], card);
          return 0;
        }
        const envs = await environments(command === "package");
        if (command === "package") {
          const result = await packageProject(store, slug, envs[0]!);
          if (!result.ok) {
            io.err(json ? JSON.stringify(result) : [`not packaged (${result.stage}):`, ...result.reasons.map((r) => `  ${r}`)].join("\n"));
            return 1;
          }
          say([`package ${result.digest}`, `  ${result.file}`, `  executable: false (a source package; the runtime decides at start)`, "  next:", ...result.next.map((n) => `    ${n}`)], result);
          return 0;
        }
        const readiness = await assess(project.recipe, envs[0], { principal, ...(project.meta.lastPackage ? { previous: project.meta.lastPackage } : {}) });
        say(
          [`${readiness.verdict}${readiness.environment ? ` in ${readiness.environment}` : ""}`, ...readiness.findings.map((f) => `  ${f.severity} ${f.code} ${f.step ? `step ${f.step}` : f.dependency ? `dependency ${f.dependency}` : f.path ?? ""}: ${f.message}\n      -> ${f.action}`), ...readiness.unresolved.map((u) => `  unresolved ${u.subject}: ${u.why}`)],
          readiness
        );
        return readiness.verdict === "ready" || readiness.verdict === "ready-with-unresolved" ? 0 : 1;
      }
      default:
        io.err(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${(error as Error).message}`);
    return 1;
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
