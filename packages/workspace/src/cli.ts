#!/usr/bin/env node
/**
 * The `appworks` command, extended with the project workspace. `assess`, `verify`, `extract` and `verify-extraction`
 * are @appport/extraction's command, unchanged; `project` and `serve` act on the workspace through the same action table
 * (`perform`) and the same project view the web workspace uses. There is one workflow implementation.
 *
 *   appworks recipe run|status|resume|reconcile|answer|expire ...   (see @appport/recipe-runtime)
  appworks package keygen|trust|publish|verify|install|list|show ...   (see @appport/recipe-distribution)
  appworks project create --github <owner>/<repo> [--ref <ref>] [--read-credential env:NAME] [--write-credential env:NAME]
 *   appworks project create --git <url-or-mirror> --owner <owner> --name <repo> [--ref <ref>] [--url <canonical url>]
 *   appworks project list [--json]
 *   appworks project show <id> [--json]
 *   appworks project <action> <id> [--<input> <value> ...]
 *        actions: acquire pin inspect discover [--endpoint] assess reconcile select --candidate [--rationale] plan
 *                 request-approval approval-subject --action approve --action --subject execute verify ready
 *                 assert-match --capability --candidate --rationale cancel [--reason] resume
 *                 pull-request --head --base | commit | push | promote | modify-integration
 *   appworks serve [--port 4300] [--host 127.0.0.1]
 *
 * Global options: --home <dir> (APPWORKS_HOME, default ~/.appworks), --extractions <dir> (APPWORKS_EXTRACTIONS, default
 * ./extractions). APPWORKS_LEASE_MS sets a run's lease (default 60000): how long a dead worker holds a project. The acting principal is the operating-system user; `<home>/policy.json` (principal → permitted
 * actions) restricts it, and without one the local operator may do everything a local policy grants. Approvals are
 * still required: being permitted to act is not having approved the action.
 *
 * Exit status: 0 done; 1 the step ran and failed (recorded on the project); 2 invalid arguments; 3 unauthorized;
 * 4 refused before running (wrong stage, approval required, ineligible, stale, conflict, ...).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { main as extractionMain } from "@appport/extraction";
import type { CliIO } from "@appport/assessment";
import { ACTIONS, perform } from "./actions.js";
import { environmentCredentials, localAuthority } from "./authority.js";
import { agentConfig, createAgent } from "./agent/config.js";
import { agentService, agentView, performAgent, type AgentView } from "./agent/operations.js";
import { describeAgent } from "./agent/runner.js";
import { WorkspaceError, type Principal } from "./model.js";
import { gitProvider, githubProvider } from "./repository.js";
import { createWorkspaceServer, parseRepository, projectSummary } from "./server.js";
import { projectView, type ProjectView } from "./view.js";
import { Workspace } from "./workflow.js";

const USAGE = `usage:
  appworks assess|verify|extract|verify-extraction ...      (see @appport/extraction)
  appworks project create --github <owner>/<repo> [--ref <ref>] [--read-credential env:NAME] [--write-credential env:NAME]
  appworks project create --git <url-or-mirror> --owner <owner> --name <repo> [--ref <ref>] [--url <canonical url>]
  appworks project list [--json]
  appworks project show <id> [--json]
  appworks project <action> <id> [--<input> <value> ...]      actions: ${ACTIONS.join(" ")}
  appworks agent run <id> [--end-to-end] [--agent <provider>] [--model <model>] [--task <text>] [--max-turns <n>] [--no-wait] [--json]
  appworks agent status <id> [--json]
  appworks agent stop <id> [--reason <text>]
  appworks agent resume <id> [--end-to-end] [--answer <text>] [--switch-agent --agent <provider> [--model <model>]] [--no-wait] [--json]
  appworks agent check [--agent <provider>] [--model <model>] [--json]
  appworks serve [--port <port>] [--host 127.0.0.1]
  global: [--home <dir>] [--extractions <dir>] [--env-file <path>] (default ./.env.local when present; never printed)`;

class UsageError extends Error {}

const FLAGS = new Set(["json", "switch-agent", "no-wait", "end-to-end"]);

/**
 * The environment commands read: the process environment over `.env.local` (or `--env-file`), which is optional and
 * only ever read, never printed or stored. Tests pass their own environment and no file is read.
 */
export function commandEnvironment(options: Record<string, string | true>, environment: CliEnvironment): NodeJS.ProcessEnv {
  const path = typeof options["env-file"] === "string" ? resolve(options["env-file"]) : environment.env ? undefined : resolve(".env.local");
  const base = environment.env ?? process.env;
  if (!path || !existsSync(path)) {
    if (typeof options["env-file"] === "string") throw new UsageError(`--env-file ${options["env-file"]} does not exist`);
    return base;
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    throw new UsageError(`${path} is not a dotenv file`);
  }
  return { ...parsed, ...base };
}

function parse(args: string[]) {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (FLAGS.has(name)) options[name] = true;
      else {
        const v = args[++k];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        options[name] = v;
      }
    } else positional.push(a);
  }
  return { positional, options };
}

export interface CliEnvironment {
  home?: string;
  extractions?: string;
  env?: NodeJS.ProcessEnv;
  principal?: Principal;
  /** Tests: keep the server running and hand it back instead of waiting for a signal. */
  onServe?: (origin: string, close: () => Promise<void>) => void;
}

export async function openWorkspace(options: Record<string, string | true>, environment: CliEnvironment = {}): Promise<{ ws: Workspace; principal: Principal; extractions?: string }> {
  const env = environment.env ?? process.env;
  const home = resolve(String(options.home ?? environment.home ?? env.APPWORKS_HOME ?? join(homedir(), ".appworks")));
  const extractions = String(options.extractions ?? environment.extractions ?? env.APPWORKS_EXTRACTIONS ?? resolve("extractions"));
  const principal = environment.principal ?? { id: `local:${userInfo().username}`, kind: "user" as const };
  const policyPath = join(home, "policy.json");
  const policy = existsSync(policyPath) ? (JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, string[]>) : { [principal.id]: ["*"] };
  const leaseMs = Number(env.APPWORKS_LEASE_MS ?? 60_000);
  const ws = await Workspace.open({ home, authority: localAuthority(policy), credentials: environmentCredentials(env), providers: { github: githubProvider(), git: gitProvider() }, leaseMs: Number.isFinite(leaseMs) && leaseMs >= 1_000 ? leaseMs : 60_000, ...(env.APPWORKS_DISCOVERY_ORIGINS ? { discoveryOrigins: env.APPWORKS_DISCOVERY_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) } : {}), ...(existsSync(extractions) ? { extractionsRoot: extractions } : {}) });
  return { ws, principal, ...(existsSync(extractions) ? { extractions } : {}) };
}

function showText(v: ProjectView): string[] {
  const p = v.project;
  const lines = [
    `${p.repository.owner}/${p.repository.name} (${p.repository.provider}) project ${p.id}`,
    `  status: ${v.status.label}${v.status.detail ? ` (${v.status.detail})` : ""}; stage ${p.stage} (${p.stageIndex + 1} of ${v.stages.length})`,
    `  ref ${p.ref}; ${p.revision ? `pinned ${p.revision.sha}${p.revision.treeDigest ? ` (checkout ${p.revision.treeDigest})` : " (not pinned yet)"}; on ${p.repository.defaultBranch ?? "default branch"}: ${p.revision.onDefaultBranch}` : "not acquired"}`
  ];
  if (v.revisionNotice) lines.push(`  notice: ${v.revisionNotice}`);
  for (const r of p.condition.reasons) lines.push(`  ${r.code}: ${r.message}`);
  if (v.integration) lines.push(`  integration: ${v.integration.status}${v.integration.integrations.length ? ` (${v.integration.integrations.map((i) => i.root).join(", ")})` : ""}`);
  if (v.discovery) lines.push(`  discovery: ${v.discovery.outcome}${v.discovery.endpoint ? ` at ${v.discovery.endpoint}` : ""}: ${v.discovery.capabilities.map((c) => `${c.name}@${c.version}`).join(", ") || "none"}; nothing invoked or granted`);
  if (v.assessment) lines.push(`  assessment: ${v.assessment.digest}${v.assessment.partial.length ? ` (partial: ${v.assessment.partial.join(", ")})` : ""}; ${v.assessment.candidates} candidates`);
  if (v.inventory) {
    const s = v.inventory.summary;
    lines.push(`  inventory: ${s.confirmed} confirmed, ${s.probable} probable, ${s.ambiguous} ambiguous, ${s.unresolved} unresolved; ${s.candidates} candidates (${s.exposed} exposed, ${s.notExposed} not exposed, ${s.unknown} unknown)`);
    for (const c of v.inventory.capabilities) lines.push(`    ${c.name}@${c.version}: ${c.status}${c.candidates[0] ? ` → ${c.candidates.slice(0, 3).map((x) => x.id).join(", ")}${c.candidates.length > 3 ? ", …" : ""}` : ""} (${c.basis})`);
  }
  if (v.selection) lines.push(`  selected: ${v.selection.candidate}`);
  if (v.plan) lines.push(`  plan: ${v.plan.extraction} ${v.plan.identity}, ${v.plan.digest}`);
  for (const a of v.approvals) lines.push(`  approval ${a.action}: ${a.status} ${a.subject}${a.grantedBy ? ` by ${a.grantedBy}` : ""}${a.consumedBy ? `, used by ${a.consumedBy}` : ""}`);
  if (v.extraction) lines.push(`  extraction: ${v.extraction.identity} ${v.extraction.digest}; ${v.extraction.summary.passed} passed, ${v.extraction.summary.failed} failed, ${v.extraction.summary["not-run"]} not run`);
  if (v.verification) lines.push(`  verification: ${v.verification.status}${v.verification.fresh ? "" : ` but stale (${v.verification.staleReasons.join("; ")})`}; ${v.verification.behaviors.passed} of ${v.verification.behaviors.required} behaviors (${v.verification.behaviors.againstReal} against the real application); checkout ${v.verification.checkoutUnchanged ? "unchanged" : "CHANGED"}`);
  if (v.promotion) lines.push(`  promotion: ${v.promotion.status}; deployed: ${v.promotion.deployed ? "yes" : "no"}`);
  if (v.adoption) {
    const a = v.adoption;
    lines.push(`  contract adoption: ${a.adopted ? "adopted" : a.blocking.length ? `BLOCKED (${a.blocking.length})` : "proposed"} ${a.contract.application} ${a.contract.capability}@${a.contract.version} ${a.digest}`);
    for (const d of a.differences) lines.push(`    ${d.blocking ? "BLOCKING " : ""}${d.kind} ${d.subject}: ${d.support}, ${d.impact}${d.reason ? "" : ` (${d.description})`}`);
    for (const q of a.questions) lines.push(`    question ${q.id}: ${q.disposition} (${q.impact})`);
    for (const b of a.blocking) lines.push(`    ${b.code} ${b.subject}: ${b.message}`);
  }
  if (v.integrationChange) {
    const c = v.integrationChange;
    lines.push(`  integration change: ${c.state}; promotion ${c.promotion.digest}; adds ${c.promotion.target.files.length} files under ${c.promotion.target.directory} on ${c.promotion.target.base.slice(0, 12)}`);
    for (const f of c.promotion.target.files) lines.push(`    + ${f.path} (${f.role}, ${f.sha256.slice(0, 19)}…)`);
    for (const r of c.promotion.requirements.packages) lines.push(`    requirement ${r.name}: verified with ${r.required}, target pins ${r.target ?? "nothing"}${r.met ? "" : " (NOT MET by this patch)"}`);
    if (c.patch) lines.push(`    patch ${c.patch.digest} (worktree ${c.worktree}); show it with --json or in the web workspace`);
    if (c.verification) lines.push(`    verification: ${c.verification.status}; ${c.verification.behaviors.passed} of ${c.verification.behaviors.required} behaviors (${c.verification.behaviors.againstReal} against the real application); mutants ${c.verification.mutations ? `${c.verification.mutations.caught} of ${c.verification.mutations.total}` : "not run"}${c.verification.reasons.length ? `; ${c.verification.reasons.map((r) => r.code).join(", ")}` : ""}`);
    if (c.commit) lines.push(`    committed locally: ${c.commit} on ${c.branch} (not pushed)`);
    for (const r of c.reasons) lines.push(`    ${r.code}: ${r.message}`);
  }
  if (p.activeRun) lines.push(`  run: ${p.activeRun.id} ${p.activeRun.expired ? "interrupted (lease expired)" : "running"}`);
  lines.push(`  next: ${v.next.summary}`);
  for (const a of v.next.actions) lines.push(`    appworks project ${a.action} ${p.id}${(a.inputs ?? []).map((i) => ` ${i.required ? "" : "["}--${i.name} ${i.value ?? `<${i.name}>`}${i.required ? "" : "]"}`).join("")}  # ${a.reason}`);
  return lines;
}

function agentText(v: AgentView): string[] {
  const lines = ["error" in v.configured ? `configured agent: none (${v.configured.error.code}: ${v.configured.error.message})` : `configured agent: ${v.configured.provider}${v.configured.model ? ` ${v.configured.model}` : ""} (${v.configured.implementation})`];
  const c = v.current;
  if (!c) return [...lines, `no agent run on ${v.project}; start one with: appworks agent run ${v.project}`];
  const r = c.run;
  lines.push(`run ${r.id}: ${r.interrupted ? "interrupted (its worker stopped renewing its lease)" : r.status}${r.cancelRequested ? " (stop requested)" : ""}; agent ${describeAgent(r.agent)}; ${r.turns} of ${r.limits.maxTurns} turns${r.usage?.inputTokens ? `; ${r.usage.inputTokens} input / ${r.usage.outputTokens} output tokens` : ""}`);
  for (const s of r.switches ?? []) lines.push(`  agent switched after turn ${s.afterTurn} by ${s.by}: ${describeAgent(s.from)} -> ${describeAgent(s.to)}`);
  for (const t of c.turns) {
    const d = t.decision;
    const what = !d ? "(no readable decision)" : d.kind === "action" ? `${d.action} ${JSON.stringify(d.arguments)}` : d.kind === "ask" ? `ask: ${d.question}` : `finish ${d.outcome}`;
    lines.push(`  ${String(t.turn).padStart(2)} ${t.status.padEnd(11)} ${what}`);
    if (d?.rationale) lines.push(`     agent's rationale (not evidence): ${d.rationale.slice(0, 300)}`);
    if (t.result) lines.push(`     recorded: ${t.result.summary.slice(0, 400)}${t.result.evidence?.length ? ` [${t.result.evidence.join(", ")}]` : ""}`);
  }
  if (r.pause?.kind === "approval") lines.push(`paused: ${r.pause.action} needs the ${r.pause.approval} approval${r.pause.subject ? ` of ${r.pause.subject}` : ""}${r.pause.description ? ` (${r.pause.description})` : ""}.`, `  approve: appworks project approve ${v.project} --action ${r.pause.approval} --subject ${r.pause.subject ?? "<subject>"}`, `  then:    appworks agent resume ${v.project}`);
  if (r.pause?.kind === "question") lines.push(`paused with a question: ${r.pause.question}`, `  answer: appworks agent resume ${v.project} --answer "<answer>"`);
  if (r.interrupted) lines.push(`  resume it: appworks agent resume ${v.project}`);
  if (r.outcome) lines.push(`outcome: ${r.outcome.reason}; project at ${r.outcome.stage} (${r.outcome.condition})${r.outcome.claimed ? `; the agent reported ${r.outcome.claimed}` : ""}`);
  for (const b of r.outcome?.blockers ?? []) lines.push(`  blocker: ${b}`);
  if (r.error) lines.push(`error: ${r.error.code}: ${r.error.message}`);
  return lines;
}

function exitFor(error: unknown, io: CliIO, ran: boolean): number {
  if (error instanceof UsageError) {
    io.err(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (error instanceof WorkspaceError) {
    io.err(`${error.code}: ${error.message}`);
    if (error.code === "INVALID_INPUT") return 2;
    if (error.code === "UNAUTHORIZED") return 3;
    return ran ? 1 : 4;
  }
  io.err(`failed: ${(error as Error)?.message ?? String(error)}`);
  return 1;
}

/** Runs the CLI. Returns the exit status; never calls `process.exit`. */
export async function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }, environment: CliEnvironment = {}): Promise<number> {
  const [command, ...rest] = argv;
  // `recipe` belongs to the recipe runtime. It is reached by a lazy import through an optional peer dependency, so the
  // workspace takes no hard dependency on it and shares no state with it.
  if (command === "recipe") {
    const runtime = await import("@appport/recipe-runtime/cli").catch(() => undefined);
    if (!runtime) {
      io.err("appworks recipe needs @appport/recipe-runtime, which is not installed");
      return 1;
    }
    return runtime.main(rest, io);
  }
  // `package` (publish, verify, install) belongs to @appport/recipe-distribution, reached the same way.
  if (command === "package") {
    const distribution = await import("@appport/recipe-distribution/cli").catch(() => undefined);
    if (!distribution) {
      io.err("appworks package needs @appport/recipe-distribution, which is not installed");
      return 1;
    }
    return distribution.main(rest, io);
  }
  if (command !== "project" && command !== "serve" && command !== "agent") return extractionMain(argv, io);
  let ws: Workspace | undefined;
  let ran = false;
  try {
    const { positional, options } = parse(rest);
    const env = commandEnvironment(options, environment);
    environment = { ...environment, env };
    if (command === "agent") {
      const [sub, id, ...extra] = positional;
      if (sub === "check") {
        if (id) throw new UsageError("agent check takes no project");
        const override = { ...(typeof options.agent === "string" ? { provider: options.agent } : {}), ...(typeof options.model === "string" ? { model: options.model } : {}) };
        const config = agentConfig(env, override);
        const made = createAgent(config, env);
        const shown = { provider: config.provider, ...(config.model ? { model: config.model } : {}), implementation: made.agent.identity.implementation, capabilities: made.agent.capabilities, limits: config.limits, ...(config.key ? { key: config.key } : {}) };
        io.out(options.json ? JSON.stringify(shown, null, 2) : `agent: ${describeAgent(made.agent.identity)}; key ${config.key ? `${config.key.variable} is set` : "not needed"}; limits ${config.limits.maxTurns} turns, ${config.limits.decisionTimeoutMs}ms per decision, ${config.limits.maxRetries} retries`);
        return 0;
      }
      if (!sub || !["run", "status", "stop", "resume"].includes(sub)) throw new UsageError("agent needs run, status, stop, resume or check");
      if (!id || extra.length) throw new UsageError(`agent ${sub} takes exactly one project id`);
      const opened = await openWorkspace(options, environment);
      ws = opened.ws;
      const service = agentService(ws, env);
      if (sub === "status") {
        const view = await agentView(service, opened.principal, id);
        if (options.json) io.out(JSON.stringify(view, null, 2));
        else for (const line of agentText(view)) io.out(line);
        return 0;
      }
      const input = Object.fromEntries(Object.entries(options).filter(([k]) => !["home", "extractions", "json", "env-file", "no-wait"].includes(k)));
      const performed = await performAgent(service, opened.principal, id, sub === "run" ? "start" : sub, input);
      if (performed.kind === "done") {
        io.out(options.json ? JSON.stringify(performed.result, null, 2) : `agent run ${performed.result.id}: ${performed.result.cancelRequested ? "stop requested" : performed.result.status}`);
        return 0;
      }
      io.err(`agent ${sub}: ${performed.run}`);
      if (options["no-wait"]) return 0;
      ran = true;
      const finished = await performed.done;
      const view = await agentView(service, opened.principal, id);
      if (options.json) io.out(JSON.stringify(view, null, 2));
      else for (const line of agentText(view)) io.out(line);
      return finished.status === "failed" ? 1 : 0;
    }
    if (command === "serve") {
      if (positional.length) throw new UsageError("serve takes no arguments");
      const opened = await openWorkspace(options, environment);
      ws = opened.ws;
      const server = createWorkspaceServer({ workspace: ws, principal: opened.principal, agents: agentService(ws, env), host: String(options.host ?? "127.0.0.1"), port: Number(options.port ?? 4300) });
      const origin = await server.listen();
      io.out(`AppWorks workspace on ${origin} (loopback only), acting as ${opened.principal.id}`);
      io.out(`  state: ${opened.ws.home}; extractions: ${opened.extractions ?? "none"}. Press Ctrl-C to stop.`);
      const opened_ws = ws;
      ws = undefined; // closed with the server
      const close = async () => {
        await server.close();
        await opened_ws.close();
      };
      if (environment.onServe) {
        environment.onServe(origin, close);
        return 0;
      }
      await new Promise<void>((done) => {
        for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void close().then(done));
      });
      return 0;
    }
    const [sub, ...args] = positional;
    if (!sub) throw new UsageError("project needs a subcommand");
    const opened = await openWorkspace(options, environment);
    ws = opened.ws;
    const principal = opened.principal;
    if (sub === "create") {
      let input: Parameters<Workspace["createProject"]>[1];
      const opt = (k: string) => (typeof options[k] === "string" ? (options[k] as string) : undefined);
      if (opt("github")) {
        let named: { owner: string; name: string };
        try {
          named = parseRepository(opt("github")!);
        } catch {
          throw new UsageError("--github is <owner>/<repo> or a https://github.com/<owner>/<repo> URL");
        }
        input = { provider: "github", owner: named.owner, name: named.name, ref: opt("ref") ?? "" };
      } else if (opt("git")) {
        if (!opt("owner") || !opt("name")) throw new UsageError("--git needs --owner and --name (the repository's identity)");
        input = { provider: "git", owner: opt("owner")!, name: opt("name")!, ref: opt("ref") ?? "", fetchFrom: /^[a-z]+:\/\//.test(opt("git")!) ? opt("git")! : resolve(opt("git")!), ...(opt("url") ? { url: opt("url")! } : {}) };
      } else throw new UsageError("create needs --github <owner>/<repo> or --git <url-or-mirror>");
      const created = await ws.createProject(principal, { ...input, ...(opt("read-credential") ? { readCredential: opt("read-credential")! } : {}), ...(opt("write-credential") ? { writeCredential: opt("write-credential")! } : {}) });
      io.out(options.json ? JSON.stringify(projectSummary(created), null, 2) : `created project ${created.id}: ${created.repository.owner}/${created.repository.name} at ${created.ref}`);
      return 0;
    }
    if (sub === "list") {
      const projects = (await ws.listProjects(principal)).map(projectSummary);
      if (options.json) io.out(JSON.stringify(projects, null, 2));
      else for (const p of projects) io.out(`${p.id}  ${p.repository}  ${p.ref}  ${p.sha ? p.sha.slice(0, 12) : "-"}  ${p.stage}  ${p.condition}${p.activeRun ? " (running)" : ""}`);
      return 0;
    }
    const [id, ...extra] = args;
    if (!id || extra.length) throw new UsageError(`${sub} takes exactly one project id`);
    if (sub === "show") {
      const view = await projectView(ws, principal, id);
      if (options.json) io.out(JSON.stringify(view, null, 2));
      else for (const line of showText(view)) io.out(line);
      return 0;
    }
    if (!ACTIONS.includes(sub)) throw new UsageError(`unknown project subcommand ${sub}`);
    const input = Object.fromEntries(Object.entries(options).filter(([k]) => !["home", "extractions", "json"].includes(k)).map(([k, v]) => [k, String(v)]));
    const performed = await perform(ws, principal, id, sub, input);
    if (performed.kind === "done") {
      io.out(options.json ? JSON.stringify(performed.result, null, 2) : `${sub}: done`);
      if (!options.json && sub === "approval-subject") io.out(JSON.stringify(performed.result, null, 2));
      return 0;
    }
    io.err(`${sub}: started ${performed.run}`);
    ran = true;
    await performed.done;
    const view = await projectView(ws, principal, id);
    if (options.json) io.out(JSON.stringify(view, null, 2));
    else for (const line of showText(view)) io.out(line);
    return 0;
  } catch (error) {
    return exitFor(error, io, ran);
  } finally {
    await ws?.close();
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
