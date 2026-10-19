/**
 * Static inspection of the pinned checkout for an existing AppPort integration, and the checkout's content hash.
 * Reads files only: nothing is installed, built or run, and nothing in the checkout is written.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * A content hash of a tree: every path, mode, mtime, link target and byte, `.git` included. The same definition the
 * Memos extraction's suite uses to prove a checkout unchanged, so the two can be compared.
 */
export function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(`${path.slice(root.length)}\0${stat.mode}\0${stat.mtimeMs}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

export interface IntegrationEvidence {
  kind: "appport-package" | "appport-config" | "appport-import";
  path: string;
  detail: string;
}

export interface IntegrationRecord {
  format: "appworks.integration-inspection/1";
  revision: string;
  status: "present" | "absent";
  /** One entry per directory that declares AppPort packages: a bridge, server or client of the application. */
  integrations: Array<{ root: string; name?: string; packages: Record<string, string>; entry?: string; files: string[] }>;
  evidence: IntegrationEvidence[];
  scanned: { files: number; truncated: boolean };
  note: string;
}

const SKIP = new Set([".git", "node_modules", "vendor", "dist", "build", "out", "target", ".next", "coverage"]);
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024;

/** Finds AppPort integrations by what the files declare: package manifests, AppPort configuration and imports. */
export function inspectIntegration(root: string, revision: string): IntegrationRecord {
  const evidence: IntegrationEvidence[] = [];
  const integrations: IntegrationRecord["integrations"] = [];
  let files = 0;
  let truncated = false;
  const sources: string[] = [];
  const visit = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (files >= MAX_FILES) {
        truncated = true;
        return;
      }
      const path = join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (!SKIP.has(name)) visit(path, rel);
        continue;
      }
      files++;
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      if (name === "package.json") {
        let manifest: { name?: string; main?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        try {
          manifest = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          continue;
        }
        const packages = Object.fromEntries(Object.entries({ ...manifest.dependencies }).filter(([k]) => k.startsWith("@appport/") || k === "appport"));
        if (Object.keys(packages).length) {
          const at = relative || ".";
          integrations.push({ root: at, ...(manifest.name ? { name: manifest.name } : {}), packages, ...(manifest.main ? { entry: manifest.main } : manifest.scripts?.start ? { entry: `scripts.start: ${manifest.scripts.start}` } : {}), files: [] });
          evidence.push({ kind: "appport-package", path: rel, detail: Object.entries(packages).map(([k, v]) => `${k}@${v}`).join(", ") });
        }
      } else if (name === "appport.toml" || name === "appport.flow" || name === "appport.json") {
        evidence.push({ kind: "appport-config", path: rel, detail: name });
      } else if (/\.(?:m?js|cjs|ts|mts|tsx)$/.test(name)) sources.push(rel);
    }
  };
  visit(root, "");
  for (const rel of sources) {
    const text = readFileSync(join(root, rel), "utf8");
    const m = /\bfrom\s+["'](@appport\/[a-z0-9-]+)["']|\bimport\s*\(\s*["'](@appport\/[a-z0-9-]+)["']/.exec(text);
    if (!m) continue;
    evidence.push({ kind: "appport-import", path: rel, detail: m[1] ?? m[2]! });
    const owner = integrations.filter((i) => i.root === "." || rel.startsWith(`${i.root}/`)).sort((a, b) => b.root.length - a.root.length)[0];
    owner?.files.push(rel);
  }
  const present = integrations.length > 0 || evidence.some((e) => e.kind === "appport-config");
  return {
    format: "appworks.integration-inspection/1",
    revision,
    status: present ? "present" : "absent",
    integrations,
    evidence,
    scanned: { files, truncated },
    note: present
      ? "The revision declares an AppPort integration. Its presence in source says nothing about what a running instance publishes; discovery establishes that."
      : "No AppPort package, configuration or import was found in the revision: it has no existing AppPort integration."
  };
}
