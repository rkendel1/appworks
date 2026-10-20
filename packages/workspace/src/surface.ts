/**
 * The capabilities an application could publish, found without running it.
 *
 * Two sources, both bound to evidence in the pinned checkout:
 *  - a static scan for HTTP routes (Go net/http and common routers, Express-style JavaScript and TypeScript, Flask and
 *    FastAPI), which reads files only;
 *  - capabilities an agent proposes from the README, configuration and code, each citing a file, a line and the text on
 *    that line, which is checked here: a citation that does not match the pinned file is refused.
 *
 * Nothing here grants anything. A proposal only becomes part of the installation proposal, whose digest a person's
 * `modify-integration` approval covers (`install.ts`).
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { WorkspaceError } from "./model.js";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export interface Citation {
  path: string;
  line: number;
  /** Text that appears on that line of the pinned file. */
  quote: string;
}

export interface ProposedCapability {
  /** AppPort capability name: `<namespace>.<operation>`, lower-case ASCII letters and digits. */
  name: string;
  method: Method;
  /** The application's own HTTP path; `{param}` marks a path parameter. */
  path: string;
  description: string;
  source: "route-scan" | "agent";
  evidence: Citation[];
}

export const MAX_CAPABILITIES = 50;
const NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", "out", "target", ".next", "coverage", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 5_000;
const MAX_BYTES = 256 * 1024;
const TEST_FILE = /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|(^|\/)test_[^/]*\.py|_test\.py)$/;

const METHOD = "GET|POST|PUT|PATCH|DELETE";
const PATTERNS: Array<{ ext: RegExp; re: RegExp; method: (m: RegExpExecArray) => Method | undefined; path: (m: RegExpExecArray) => string }> = [
  // Go 1.22 pattern ("GET /things/{id}") and the plain forms.
  { ext: /\.go$/, re: new RegExp(`\\.(?:Handle|HandleFunc)\\(\\s*"(?:(${METHOD})\\s+)?(/[^"\\s]*)"`), method: (m) => m[1] as Method | undefined, path: (m) => m[2]! },
  { ext: /\.go$/, re: new RegExp(`\\.(${METHOD}|Get|Post|Put|Patch|Delete)\\(\\s*"(/[^"\\s]*)"`), method: (m) => m[1]!.toUpperCase() as Method, path: (m) => m[2]! },
  { ext: /\.(m?[jt]sx?|cjs)$/, re: /\b(?:app|router|server|api|fastify|route|r)\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`\s]*)['"`]/, method: (m) => m[1]!.toUpperCase() as Method, path: (m) => m[2]! },
  { ext: /\.py$/, re: /@\w+\.(get|post|put|patch|delete)\(\s*['"](\/[^'"\s]*)['"]/, method: (m) => m[1]!.toUpperCase() as Method, path: (m) => m[2]! },
  { ext: /\.py$/, re: /@\w+\.route\(\s*['"](\/[^'"\s]*)['"](?:[^)]*methods\s*=\s*\[\s*['"](\w+)['"])?/, method: (m) => (m[2] ? (m[2].toUpperCase() as Method) : "GET"), path: (m) => m[1]! }
];

export interface Route {
  method: Method | undefined;
  path: string;
  citation: Citation;
}

/** HTTP routes the source registers. A route with no method (Go's plain `Handle`) answers any method. */
export function scanRoutes(root: string): { routes: Route[]; scanned: number } {
  const routes: Route[] = [];
  let scanned = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (scanned >= MAX_FILES) return;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!SKIP.has(name)) visit(path);
        continue;
      }
      const rel = relative(root, path).split(sep).join("/");
      if (!stat.isFile() || stat.size > MAX_BYTES || TEST_FILE.test(rel)) continue;
      const patterns = PATTERNS.filter((p) => p.ext.test(name));
      if (!patterns.length) continue;
      scanned++;
      readFileSync(path, "utf8").split("\n").forEach((text, index) => {
        for (const p of patterns) {
          const m = p.re.exec(text);
          if (m) routes.push({ method: p.method(m), path: p.path(m), citation: { path: rel, line: index + 1, quote: text.trim().slice(0, 200) } });
        }
      });
    }
  };
  visit(root);
  return { routes, scanned };
}

/**
 * `GET /v1/users/{id}` → `users.getbyid`; deterministic, so the same source gives the same proposal. AppPort names are
 * `<namespace>.<operation>` in lower-case ASCII letters and digits.
 */
export function nameFor(method: Method, path: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isParam = (s: string) => /^(\{.*\}|:.*|<.*>)$/.test(s);
  const segments = path.split("/").filter(Boolean).filter((s) => !/^v\d+$/.test(s));
  const words = segments.filter((s) => !isParam(s)).map(clean).filter(Boolean);
  const [first = "app", ...rest] = words;
  const namespace = /^[a-z]/.test(first) ? first : `x${first}`;
  return `${namespace}.${method.toLowerCase()}${rest.join("")}${segments.some(isParam) ? "byid" : ""}`;
}

const normalizePath = (path: string) => path.replace(/:(\w+)/g, "{$1}").replace(/<(?:\w+:)?(\w+)>/g, "{$1}");

/**
 * Route-scan proposals: one capability per distinct method and path. A bare `/` is not proposed: a catch-all handler
 * has no surface to describe, and the person (or the agent, citing the docs) names what it serves.
 */
export function routeProposals(root: string): { proposals: ProposedCapability[]; catchAll: Route[]; scanned: number } {
  const { routes, scanned } = scanRoutes(root);
  const proposals = new Map<string, ProposedCapability>();
  const catchAll: Route[] = [];
  for (const route of routes) {
    const path = normalizePath(route.path);
    if (path === "/" || path === "/*") {
      catchAll.push(route);
      continue;
    }
    for (const method of route.method ? [route.method] : (["GET", "POST"] as Method[])) {
      const name = nameFor(method, path);
      if (proposals.has(name) || !NAME.test(name)) continue;
      proposals.set(name, { name, method, path, description: `${method} ${path}, found in ${route.citation.path}:${route.citation.line}.`, source: "route-scan", evidence: [route.citation] });
    }
  }
  return { proposals: [...proposals.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_CAPABILITIES), catchAll, scanned };
}

/**
 * Checks proposals against the pinned checkout and returns them in canonical form. Every citation must name a regular
 * file inside the checkout, a line that exists, and text that appears on that line; the path must be an application
 * path, never a URL. Anything else is refused whole, so a proposal is never half-trusted.
 */
export function verifyProposals(root: string, input: unknown): ProposedCapability[] {
  if (!Array.isArray(input)) throw new WorkspaceError("INVALID_INPUT", "capabilities is a list");
  if (input.length > MAX_CAPABILITIES) throw new WorkspaceError("INVALID_INPUT", `at most ${MAX_CAPABILITIES} capabilities can be proposed`);
  const base = resolve(root);
  const seen = new Set<string>();
  return input.map((raw, i): ProposedCapability => {
    const c = raw as Partial<ProposedCapability>;
    const fail = (why: string): never => {
      throw new WorkspaceError("INVALID_INPUT", `capability ${i + 1}${typeof c?.name === "string" ? ` (${c.name})` : ""}: ${why}`);
    };
    if (!c || typeof c !== "object") return fail("is not an object");
    if (typeof c.name !== "string" || !NAME.test(c.name) || c.name.length > 80) return fail("name is <namespace>.<operation> in lower-case letters and digits, such as chat.createcompletion");
    if (seen.has(c.name)) return fail("name is proposed twice");
    seen.add(c.name);
    if (!METHODS.includes(c.method as Method)) return fail(`method is one of ${METHODS.join(", ")}`);
    if (typeof c.path !== "string" || !/^\/[A-Za-z0-9._~\-/{}:%]*$/.test(c.path) || c.path.includes("..")) return fail("path is an application path such as /v1/models, never a URL");
    if (typeof c.description !== "string" || !c.description.trim() || c.description.length > 400) return fail("description is 1 to 400 characters");
    if (!Array.isArray(c.evidence) || !c.evidence.length || c.evidence.length > 5) return fail("evidence is 1 to 5 citations of the pinned source");
    const evidence = c.evidence.map((e): Citation => {
      const cite = e as Partial<Citation>;
      if (typeof cite?.path !== "string" || !Number.isInteger(cite.line) || typeof cite.quote !== "string" || !cite.quote.trim()) return fail("a citation needs path, line and quote");
      const file = resolve(base, cite.path);
      if (file !== base && !file.startsWith(base + sep)) return fail(`${cite.path} is outside the repository`);
      let text: string;
      try {
        if (!lstatSync(file).isFile()) return fail(`${cite.path} is not a regular file`);
        const size = lstatSync(file).size;
        if (size > 2 * 1024 * 1024) return fail(`${cite.path} is too large to cite`);
        text = readFileSync(file, "utf8");
      } catch {
        return fail(`${cite.path} does not exist in the pinned revision`);
      }
      const lines = text.split("\n");
      const line = cite.line as number;
      if (line < 1 || line > lines.length) return fail(`${cite.path} has no line ${line}`);
      const quote = cite.quote.trim().slice(0, 200);
      if (!lines[line - 1]!.includes(quote)) return fail(`line ${line} of ${cite.path} does not contain the quoted text`);
      return { path: cite.path.split(sep).join("/"), line, quote };
    });
    return { name: c.name, method: c.method as Method, path: c.path, description: c.description.trim(), source: "agent", evidence };
  });
}

/** The proposals of both sources, route-scan first; an agent's proposal of a name the scan already found replaces it. */
export function mergeProposals(scanned: ProposedCapability[], proposed: ProposedCapability[]): ProposedCapability[] {
  const byName = new Map(scanned.map((p) => [p.name, p]));
  for (const p of proposed) byName.set(p.name, p);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, MAX_CAPABILITIES);
}
