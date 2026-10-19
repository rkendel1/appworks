/**
 * Finding where a running instance of the application can be asked what it advertises, so nobody has to type its
 * origin. The pinned source says which ports the application listens on (configuration, compose files, Dockerfiles,
 * scripts, README instructions, code); each port becomes a loopback origin, ranked by how much of the source points at
 * it and whether it is inside the AppPort integration. Hosts named in the source are never contacted: repository
 * content chooses at most a port, and only on this machine. Operator-configured origins come first.
 *
 * Reads files only; the probe itself is AppPort's discovery (`discovery.ts`), which sends no credential and invokes
 * nothing.
 */
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface EndpointCandidate {
  origin: string;
  /** Where it came from: `configured` (the operator's), or the source lines that name its port. */
  sources: Array<{ kind: "configured" | "source"; path?: string; line?: number; detail: string }>;
  score: number;
}

const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", "out", "target", ".next", "coverage", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 5_000;
const MAX_BYTES = 256 * 1024;
const MAX_CANDIDATES = 8;
/** Files whose names say they configure or run the application. */
const CONFIG = /^(\.env\.(example|sample|template|defaults?)|docker-compose[\w.-]*\.ya?ml|compose[\w.-]*\.ya?ml|Dockerfile[\w.-]*|Procfile|package\.json|appport\.(json|toml|flow)|[\w.-]*\.(ya?ml|toml|ini|cfg|conf)|README[\w.-]*|Makefile)$/i;
const CODE = /\.(m?[jt]sx?|cjs|py|go|rb|java|kt|rs|php|cs)$/;

/** Port mentions, each with the weight of what kind of mention it is. */
const PATTERNS: Array<{ re: RegExp; weight: number; detail: string }> = [
  { re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{2,5}))\b/g, weight: 3, detail: "a loopback URL" },
  { re: /\b(?:APP_)?PORT\s*[=:]\s*["']?(\d{2,5})\b/gi, weight: 3, detail: "a PORT setting" },
  { re: /\bEXPOSE\s+(\d{2,5})\b/g, weight: 2, detail: "a Dockerfile EXPOSE" },
  { re: /["']?(\d{2,5}):\d{2,5}["']?\s*$/gm, weight: 2, detail: "a published container port" },
  { re: /--port[= ](\d{2,5})\b/g, weight: 2, detail: "a --port option" },
  { re: /\.listen\(\s*(\d{2,5})\b/g, weight: 2, detail: "a listen() call" },
  { re: /\bport\s*[=:]\s*(\d{2,5})\b/g, weight: 1, detail: "a port setting" }
];

const isPort = (n: number) => Number.isInteger(n) && n >= 80 && n <= 65535 && n !== 443 && n !== 5432 && n !== 3306 && n !== 6379 && n !== 27017;

/** Ranked loopback origins to probe: configured ones first, then the ports the pinned source names. */
export function endpointCandidates(root: string, options: { configured?: string[]; integrationRoots?: string[] } = {}): EndpointCandidate[] {
  const byOrigin = new Map<string, EndpointCandidate>();
  for (const origin of options.configured ?? []) {
    const o = origin.trim().replace(/\/$/, "");
    if (/^https?:\/\/[^\s/@]+(?::\d+)?$/.test(o)) byOrigin.set(o, { origin: o, sources: [{ kind: "configured", detail: "APPWORKS_DISCOVERY_ORIGINS" }], score: 1_000 });
  }
  const roots = (options.integrationRoots ?? []).filter((r) => r && r !== ".");
  let files = 0;
  const visit = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (files >= MAX_FILES) return;
      const path = join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!SKIP.has(name) && !name.startsWith(".")) visit(path, rel);
        continue;
      }
      files++;
      if (!stat.isFile() || stat.size > MAX_BYTES || (!CONFIG.test(name) && !CODE.test(name)) || /\.env$/.test(name)) continue;
      const inIntegration = roots.some((r) => rel.startsWith(`${r}/`));
      const isTest = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?)\//i.test(rel);
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.length > 400) return;
          for (const p of PATTERNS) {
            p.re.lastIndex = 0;
            for (const m of line.matchAll(p.re)) {
              const port = Number(m[1]);
              if (!isPort(port)) continue;
              const origin = `http://127.0.0.1:${port}`;
              const c = byOrigin.get(origin) ?? { origin, sources: [], score: 0 };
              c.score += p.weight * (CONFIG.test(name) ? 2 : 1) * (inIntegration ? 3 : 1) * (isTest ? 0.25 : 1);
              if (c.sources.length < 5) c.sources.push({ kind: "source", path: rel, line: i + 1, detail: p.detail });
              byOrigin.set(origin, c);
            }
          }
        });
    }
  };
  visit(root, "");
  return [...byOrigin.values()].sort((a, b) => b.score - a.score || a.origin.localeCompare(b.origin)).slice(0, MAX_CANDIDATES);
}
