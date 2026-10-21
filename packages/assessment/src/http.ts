/**
 * HTTP-route candidates (scanner 2): the routes a JavaScript or TypeScript application registers, as assessment candidates.
 *
 * `js.ts` reads each file; this module composes them. A router's routes carry the prefixes of every `app.use(prefix, router)` that
 * leads to it, found across files through relative imports and the repository's own `jsconfig.json` / `tsconfig.json` path aliases.
 *
 * A route is evidence that an entry point exists. It is not evidence of what the entry point accepts or does: the handler's body is
 * not read, what a middleware enforces is not established, and the request and response shapes are unknown unless the route's own
 * text states them (a path parameter). So a route is at best `investigate`, never `exposure-candidate`, and says why. The effect
 * proposed for it follows the HTTP method by convention and is marked inferred.
 */
import { posix } from "node:path";
import {
  type Candidate,
  type Concern,
  type CriterionResult,
  type Evidence,
  type Finding,
  type Location,
  type MessageShape,
  type ReadinessClass,
  type SchemaField
} from "./artifact.js";
import { joinPaths, pathParameters, type Handler, type JsFile, type Middleware, type MountSite, type RouteSite } from "./js.js";

export interface HttpSources {
  /** Every analyzed JavaScript or TypeScript file's recognized content, by repository path. */
  files: ReadonlyMap<string, JsFile>;
  /** Every file the walk saw, for resolving imports. */
  paths: ReadonlySet<string>;
  /** The text of a repository file, or undefined. */
  text(path: string): string | undefined;
}

export interface HttpSink {
  record(e: Omit<Evidence, "id">): string;
  at(path: string, startLine: number, endLine?: number): Location;
  evidence: ReadonlyMap<string, Evidence>;
}

const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const SAFE = new Set(["get", "head", "options"]);

/** `compilerOptions.paths` of the nearest `jsconfig.json` / `tsconfig.json` above `dir`, as `[prefix, targetDirectory]` pairs. */
function aliasesFor(dir: string, sources: HttpSources, cache: Map<string, Array<[string, string]>>): Array<[string, string]> {
  const hit = cache.get(dir);
  if (hit) return hit;
  let found: Array<[string, string]> = [];
  for (const name of ["jsconfig.json", "tsconfig.json"]) {
    const path = posix.join(dir, name);
    const text = sources.paths.has(path) ? sources.text(path) : undefined;
    if (text === undefined) continue;
    try {
      const options = (JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
      const base = posix.join(dir, options?.baseUrl ?? ".");
      for (const [alias, targets] of Object.entries(options?.paths ?? {})) {
        const target = targets[0];
        if (target) found.push([alias.replace(/\*$/, ""), posix.join(base, target.replace(/\*$/, ""))]);
      }
      if (options?.baseUrl && !found.length) found.push(["", base]);
      break;
    } catch {
      // A config this reader cannot parse contributes no aliases; imports through them stay unresolved.
    }
  }
  if (!found.length && dir !== "." && dir !== "") found = aliasesFor(posix.dirname(dir), sources, cache);
  cache.set(dir, found);
  return found;
}

export function httpCandidates(sources: HttpSources, sink: HttpSink): { candidates: Candidate[]; findings: Finding[]; routes: number; unresolvedHandlers: number } {
  const { record, at } = sink;
  const aliasCache = new Map<string, Array<[string, string]>>();
  const findings: Finding[] = [];

  const resolveModule = (from: string, specifier: string): string | undefined => {
    const candidates: string[] = [];
    if (specifier.startsWith(".")) candidates.push(posix.join(posix.dirname(from), specifier));
    else for (const [prefix, target] of aliasesFor(posix.dirname(from), sources, aliasCache)) if (prefix && specifier.startsWith(prefix)) candidates.push(posix.join(target, specifier.slice(prefix.length)));
    for (const base of candidates) for (const ext of EXTENSIONS) for (const path of [`${base}${ext}`, ...(ext ? [] : EXTENSIONS.slice(1).map((e) => `${base}/index${e}`))]) if (sources.paths.has(path)) return path;
    return undefined;
  };

  // ---- the mount graph: which router is mounted on which, with what prefix and middleware ----
  interface Node {
    file: string;
    receiver: string;
  }
  interface Edge {
    parent: Node;
    child: Node;
    mount: MountSite;
    file: string;
  }
  const edges: Edge[] = [];
  const key = (n: Node) => `${n.file}\0${n.receiver}`;
  for (const [file, js] of sources.files) {
    for (const mount of js.mounts) {
      let child: Node | undefined;
      if (js.receivers.has(mount.target)) child = { file, receiver: mount.target };
      else {
        const head = mount.target.split(".")[0]!;
        const imported = js.imports.get(head);
        const module = imported ? resolveModule(file, imported.specifier) : undefined;
        const target = module ? sources.files.get(module) : undefined;
        if (module && target) {
          const named = imported!.imported && imported!.imported !== "default" ? imported!.imported : mount.target.split(".")[1];
          if (named && target.receivers.has(named)) child = { file: module, receiver: named };
          else if (target.exports && target.receivers.has(target.exports)) child = { file: module, receiver: target.exports };
        }
      }
      if (child) edges.push({ parent: { file, receiver: mount.receiver }, child, mount, file });
    }
  }
  const parentsOf = new Map<string, Edge[]>();
  for (const e of edges) parentsOf.set(key(e.child), [...(parentsOf.get(key(e.child)) ?? []), e]);

  interface Context {
    chain: Edge[];
    root: "app" | "router";
  }
  /** Every way a receiver is reached from a root: the chain of mounts, outermost first. */
  const contexts = (node: Node, seen: Set<string> = new Set()): Context[] => {
    const k = key(node);
    const parents = parentsOf.get(k) ?? [];
    const kind = sources.files.get(node.file)?.receivers.get(node.receiver)?.kind;
    if (!parents.length || seen.has(k) || seen.size > 8) return [{ chain: [], root: kind === "app" ? "app" : "router" }];
    const next = new Set(seen).add(k);
    return parents.flatMap((edge) => contexts(edge.parent, next).map((c) => ({ chain: [...c.chain, edge], root: c.root })));
  };

  // ---- locating a handler's definition ----
  const lines = (path: string) => sources.text(path)?.split("\n");
  const definitionIn = (module: string, name: string): { line: number } | undefined => {
    const text = lines(module);
    if (!text) return undefined;
    const escaped = name.replace(/[$]/g, "\\$");
    const patterns = [
      new RegExp(`(?:module\\.)?exports\\.${escaped}\\s*=`),
      new RegExp(`\\b(?:const|let|var|function\\*?|async function)\\s+${escaped}\\b`),
      new RegExp(`^\\s*(?:async\\s+)?${escaped}\\s*\\(`),
      new RegExp(`^\\s*${escaped}\\s*:`),
      new RegExp(`^\\s*export\\s+(?:async\\s+)?(?:function|const)\\s+${escaped}\\b`)
    ];
    const at_ = text.findIndex((l) => patterns.some((p) => p.test(l)));
    return at_ >= 0 ? { line: at_ + 1 } : undefined;
  };

  const candidates: Candidate[] = [];
  const used = new Map<string, number>();
  let routes = 0;
  let unresolvedHandlers = 0;
  const dynamic: Array<{ file: string; line: number }> = [];
  const templated = new Set<string>();
  const unmounted = new Set<string>();

  for (const [file, js] of [...sources.files].sort(([a], [b]) => order(a, b))) {
    for (const route of js.routes) {
      const node: Node = { file, receiver: route.receiver };
      if (route.path.resolution === "unknown") {
        dynamic.push({ file, line: route.startLine });
        continue;
      }
      for (const ctx of route.controller ? [{ chain: [] as Edge[], root: "app" as const }] : contexts(node)) {
        if (ctx.root === "router" && !route.controller) unmounted.add(file);
        const prefixes = ctx.chain.map((e) => e.mount.prefix);
        if (prefixes.some((p) => p.resolution === "unknown")) {
          dynamic.push({ file, line: route.startLine });
          continue;
        }
        const placeholders = [...new Set([...prefixes.flatMap((p) => p.placeholders), ...route.path.placeholders])];
        for (const p of placeholders) templated.add(p);
        const path = joinPaths(...prefixes.map((p) => p.value), route.path.value);
        routes++;
        candidates.push(buildCandidate(file, js, route, path, placeholders, ctx));
      }
    }
  }

  function textHas(path: string, startLine: number, endLine: number, subject: string): boolean {
    return (lines(path) ?? []).slice(startLine - 1, endLine).join("\n").includes(subject);
  }

  function evidenceFor(path: string, startLine: number, endLine: number, e: Omit<Evidence, "id" | "location"> & { subject?: string }): string {
    // An observed record's subject must occur in the lines it cites; a subject that is not literally there is left out.
    const subject = e.subject !== undefined && textHas(path, startLine, endLine, e.subject) ? e.subject : undefined;
    const { subject: _drop, ...rest } = e;
    return record({ ...rest, ...(subject !== undefined ? { subject } : {}), location: at(path, startLine, endLine) });
  }

  function buildCandidate(file: string, js: JsFile, route: RouteSite, path: string, placeholders: string[], ctx: { chain: Edge[]; root: "app" | "router" }): Candidate {
    const method = route.method.toUpperCase();
    const subject = `${method} ${path}`;
    const routeEvidence = evidenceFor(file, route.startLine, route.endLine, {
      class: "observed",
      kind: "js.route",
      subject: route.path.raw || undefined,
      observation: `${route.framework} route ${subject} is registered on ${route.receiver}${ctx.chain.length ? ` (mounted through ${ctx.chain.map((e) => `${e.file}:${e.mount.line}`).join(" -> ")})` : ""}`,
      method: "js-static"
    } as never);
    const mountEvidence = ctx.chain.map((e) => evidenceFor(e.file, e.mount.line, e.mount.line, { class: "observed", kind: "js.mount", subject: e.mount.prefix.raw || undefined, observation: `${e.parent.receiver} mounts ${e.mount.target}${e.mount.prefix.raw ? ` at ${e.mount.prefix.raw}` : ""}`, method: "js-static" } as never));

    // Middleware: named, never characterized. What a middleware enforces is not established.
    const middleware: Array<{ m: Middleware; file: string; scope: string }> = [
      ...ctx.chain.flatMap((e) => e.mount.middleware.map((m) => ({ m, file: e.file, scope: "mount" }))),
      ...route.middleware.map((m) => ({ m, file, scope: "route" }))
    ];
    const middlewareEvidence = middleware.map(({ m, file: f, scope }) => evidenceFor(f, m.line, m.line, { class: "observed", kind: "js.middleware", subject: m.text.replace(/\(…\)$/, ""), observation: `${m.text} runs before the handler (registered on the ${scope})`, method: "js-static" } as never));

    // The handler: inline (its lines are the implementation), or a reference followed one import to a definition when it can be.
    let implementation: Candidate["implementation"];
    const handler: Handler | undefined = route.handler;
    const evidenceIds = [routeEvidence, ...mountEvidence, ...middlewareEvidence];
    if (handler?.kind === "inline") {
      const definitionEvidence = evidenceFor(file, handler.startLine, handler.endLine, { class: "observed", kind: "js.handler", observation: `an inline handler is defined here for ${subject}`, method: "js-static" } as never);
      implementation = { symbol: `${file}:${subject}`, location: at(file, handler.startLine, handler.endLine), link: "route-inline", evidence: [definitionEvidence] };
    } else if (handler?.kind === "reference" && handler.reference) {
      const [head, ...rest] = handler.reference.split(".");
      const imported = js.imports.get(head!);
      const member = rest.length ? rest[rest.length - 1]! : imported?.imported && imported.imported !== "default" ? imported.imported : head!;
      if (route.controller) {
        const definitionEvidence = evidenceFor(file, handler.startLine, handler.endLine, { class: "observed", kind: "js.handler", subject: member, observation: `${handler.reference} is the controller method for ${subject}`, method: "js-static" } as never);
        implementation = { symbol: `${file}:${handler.reference}`, location: at(file, handler.startLine, handler.endLine), link: "route-handler-reference", evidence: [definitionEvidence] };
      } else {
        const module = imported ? resolveModule(file, imported.specifier) : undefined;
        const found = module ? definitionIn(module, member) : !imported ? (() => { const d = definitionIn(file, member); return d ? { line: d.line } : undefined; })() : undefined;
        const where = module && found ? module : !imported && found ? file : undefined;
        if (where && found) {
          const definitionEvidence = evidenceFor(where, found.line, found.line, { class: "observed", kind: "js.definition", subject: member, observation: `${member} is defined here; ${subject} references it as ${handler.reference}`, method: "js-static" } as never);
          implementation = { symbol: `${where}#${member}`, location: at(where, found.line, found.line), link: "route-handler-reference", evidence: [definitionEvidence] };
        }
      }
    }
    if (!implementation) unresolvedHandlers++;
    if (implementation) evidenceIds.push(...implementation.evidence);

    // The proposed effect follows the method by convention. It is inferred, and says the handler was not read.
    const safe = SAFE.has(route.method);
    const effect = safe ? ("observation" as const) : ("consequential" as const);
    const effectEvidence = record({
      class: "inferred",
      kind: "http.effect",
      location: at(file, route.startLine, route.endLine),
      observation: safe ? `${method} is safe by HTTP convention; the handler was not read, so nothing says it has no side effect` : `${method} is not safe by HTTP convention, so it is assumed to change state; the handler was not read`,
      method: "derivation",
      basis: [routeEvidence],
      limitations: ["a handler can break the convention in either direction"]
    });
    evidenceIds.push(effectEvidence);

    // Everything the route text does not say is an unknown, recorded as such.
    const unknown = (kind: string, observation: string) => record({ class: "unknown", kind, location: at(file, route.startLine, route.endLine), subject: subject, observation, method: "js-static" });
    const unknownIds = [
      unknown("unknown.handler", implementation ? "the handler's body was not read: the assessment reads route registrations, not what a handler does" : `the handler${handler?.reference ? ` ${handler.reference}` : ""} could not be located (it is built by a function, imported through a re-export, or not a name this reader follows)`),
      unknown("unknown.request-shape", "the request body and query this route accepts are not stated in the route's text"),
      unknown("unknown.response-shape", "what this route returns is not stated in the route's text"),
      unknown("unknown.authorization", middleware.length ? `${middleware.map((x) => x.m.text).join(", ")} run before the handler; what they enforce is not established` : "no middleware is registered on this route or its mounts; whether the handler checks a caller is not established")
    ];
    for (const id of unknownIds) evidenceIds.push(id);
    if (placeholders.length) {
      const id = unknown("unknown.path-placeholder", `the path contains ${placeholders.map((p) => `{${p}}`).join(", ")}: names whose values come from code this reader did not evaluate`);
      unknownIds.push(id);
      evidenceIds.push(id);
    }

    // The request shape the route text does state: its path parameters.
    const fields: SchemaField[] = pathParameters(path).map((p) => ({ name: p.name, jsonName: p.name, type: "string", label: p.optional ? "optional" : "required", behaviors: ["path-parameter"], evidence: [routeEvidence] }));
    for (const read of handler?.kind === "inline" ? handler.reads : []) {
      const [where, name] = read.split(".") as [string, string];
      const id = evidenceFor(file, handler!.startLine, handler!.endLine, { class: "observed", kind: "js.request-read", subject: `${where}.${name}`, observation: `the inline handler reads request ${where}.${name}`, method: "js-static" } as never);
      evidenceIds.push(id);
      fields.push({ name, jsonName: name, type: "unknown", label: "optional", behaviors: [where === "body" ? "body" : where === "query" ? "query" : "path-parameter"], evidence: [id] });
    }
    const inputs: MessageShape = { message: `${subject} request`, resolved: false, fields, unresolvedTypes: [], evidence: [routeEvidence] };

    // Readiness: an entry point and (perhaps) a located handler are all the route text establishes.
    const satisfied = (criterion: CriterionResult["criterion"], ok: boolean, reason: string, ev: string[]): CriterionResult => ({ criterion, satisfied: ok, reason, evidence: ev });
    const criteria: CriterionResult[] = [
      satisfied("entry-point", true, "http-route-registered", [routeEvidence]),
      satisfied("implementation", Boolean(implementation), implementation ? (implementation.link === "route-inline" ? "inline-handler" : "handler-reference-located") : "handler-not-located", implementation?.evidence ?? [unknownIds[0]!]),
      satisfied("io-schema", false, "no-request-or-response-schema-in-source", [unknownIds[1]!, unknownIds[2]!]),
      satisfied("validation", false, "validation-not-established", [unknownIds[1]!]),
      satisfied("authorization", false, "authorization-not-established", [unknownIds[3]!]),
      satisfied("tests", false, "tests-not-searched-for-http-routes", []),
      satisfied("reachability-complete", false, "handler-body-not-analyzed", [unknownIds[0]!]),
      satisfied("small-surface", false, "handler-body-not-analyzed", [unknownIds[0]!])
    ];
    const concerns: Array<{ concern: Concern; evidence: string[] }> = safe ? [] : [{ concern: "writes-state", evidence: [effectEvidence] }];
    const readinessClass: ReadinessClass = implementation ? "investigate" : "insufficient-evidence";

    const slug = subject.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    let id = `cand-http.${slug}`;
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    if (n > 1) id = `${id}.${n}`;
    const operation: Candidate["operation"] = { kind: "http", method, path, framework: route.framework, placeholders };
    return {
      id,
      name: subject,
      description: `${route.framework} route ${subject}, registered on ${route.receiver} in ${file}`,
      operation,
      entryPoints: [{ kind: "http-route", subject, evidence: [routeEvidence, ...mountEvidence] }],
      ...(implementation ? { implementation } : {}),
      inputs,
      dependencies: { reachableFunctions: [], externalPackages: [], unresolvedCalls: 0, truncated: false },
      sideEffects: { persistence: [], outboundHttp: [], async: [] },
      authorization: { denials: [], policyReferences: [] },
      validation: { rejections: [] },
      tests: [],
      evidence: [...new Set(evidenceIds)].sort(order),
      confidence: implementation?.link === "route-inline" ? "linked" : implementation ? "weakly-linked" : "unlinked",
      readiness: { class: readinessClass, criteria, concerns },
      unknowns: [...new Set(unknownIds)].sort(order),
      exposure: {
        status: "proposed",
        authoritative: false,
        effectBasis: { effect, reasons: [safe ? "http-method-safe-by-convention" : "http-method-unsafe-by-convention", "handler-not-read"], evidence: [effectEvidence] },
        missing: ["capability-name", "input-schema", "output-schema", "permissions", "fulfillment-claim", "verification-method", "contract-tests"]
      }
    };
  }

  candidates.sort((a, b) => order(a.id, b.id));

  // ---- findings ----
  if (dynamic.length) findings.push({ code: "ROUTE_PATH_UNREADABLE", severity: "info", message: `${dynamic.length} route registrations have a path that is not a string, a template or a + of those, so no route was recorded for them (${dynamic.slice(0, 5).map((d) => `${d.file}:${d.line}`).join(", ")}${dynamic.length > 5 ? ", …" : ""})` });
  if (templated.size) findings.push({ code: "ROUTE_PATH_PLACEHOLDER", severity: "info", message: `paths contain names whose values were not evaluated (${[...templated].sort().map((p) => `{${p}}`).join(", ")}): each such route is one template, not one route per value` });
  if (unmounted.size) findings.push({ code: "ROUTER_NOT_MOUNTED", severity: "info", message: `routers in ${[...unmounted].sort().join(", ")} are not mounted by any file read here, so their routes carry no prefix` });
  const unreadable = [...sources.files].flatMap(([file, js]) => js.unreadable.map((u) => ({ file, ...u })));
  if (unreadable.length) findings.push({ code: "ROUTE_REGISTRATION_UNREADABLE", severity: "info", message: `${unreadable.length} registrations could not be read (${unreadable.slice(0, 3).map((u) => `${u.file}:${u.line} ${u.reason}`).join("; ")}${unreadable.length > 3 ? "; …" : ""})` });
  return { candidates, findings, routes, unresolvedHandlers };
}
