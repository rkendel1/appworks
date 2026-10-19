/**
 * Promotion: a verified extraction, with its adopted contract, as a reviewable change to the target application
 * (`appworks.promotion/1`, spec/workspace-1.md §12).
 *
 * The change is described by a reviewed promotion plan next to the extraction plan (`promotion-plan.json`): which of
 * the extraction's verified files are added to the target, where, and which are not (with the reason), and how the
 * promoted copy is verified. The workspace generates no code: every promoted file is a byte-for-byte copy of a file
 * the extraction verified (its digest must equal the extraction artifact's adapter digest for it), the contract the
 * adoption proposal named, or a reviewed documentation file. The promotion artifact records each file's digest, the
 * exact verification subject the promoted copy must reproduce, and what runs. It is deterministic: no timestamps or
 * run identifiers, so the same inputs give the same digest. Its lifecycle (proposed, approved, applied, verified, ready
 * for review, submitted) is the FeltDB `Promotion` record, never the artifact.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { CapabilityExtraction } from "@appport/extraction";
import { capabilityDigest, contractDigest, digestOf, type AppPortManifest } from "@appport/protocol";
import type { QuestionDisposition } from "./adoption.js";
import { WorkspaceError } from "./model.js";
import type { ExtractionEntry } from "./runner.js";

export const PROMOTION_FORMAT = "appworks.promotion/1";
export const PROMOTION_PLAN_FORMAT = "appworks.promotion-plan/1";

export interface PromotionPlan {
  format: typeof PROMOTION_PLAN_FORMAT;
  extraction: string;
  target: {
    /** Repository-relative directory the files are added under. */
    directory: string;
    files: Array<{ source: string; path: string; role: "adapter" | "declaration" | "contract" | "documentation" }>;
    excluded: Array<{ source: string; reason: string }>;
  };
  verification: { runner: string; host: string; mutations: boolean };
  /** Where the target pins its packages (an npm lockfile), to check the runtime's packages against. */
  requirements?: { lockfile: string };
  /** How the promoted integration is started, for the reviewer and the README. */
  run: string;
  adoption: { questions: Record<string, QuestionDisposition> };
  limitations: Array<{ code: string; description: string }>;
}

export interface PromotionFile {
  path: string;
  source: string;
  role: PromotionPlan["target"]["files"][number]["role"];
  operation: "add";
  mode: "100644";
  sha256: string;
  bytes: number;
}

export interface Promotion {
  format: typeof PROMOTION_FORMAT;
  project: string;
  source: { repository: string; owner: string; name: string; revision: string };
  capability: { provider: { application: string; capability: string; version: number }; contract: { application: string; capability: string; version: number; capabilityDigest: string; contractDigest: string } };
  assessment: { digest: string; candidate: string };
  extraction: { name: string; directory: string; digest: string; format: string; identity: { name: string; revision: number }; adapterDigest: string };
  adoption: { digest: string };
  fulfillment: { declarationDigest: string };
  runtime: { packages: Record<string, string>; application: Record<string, string>; node: string };
  /** The runtime's packages against what the target's lockfile pins at the base revision. An unmet requirement is not
   * met by this patch: the promoted host was verified with the runtime's versions, and the target needs them too. */
  requirements: { lockfile: string | null; packages: Array<{ name: string; required: string; target: string | null; met: boolean }> };
  plan: { digest: string };
  target: { base: string; directory: string; files: PromotionFile[]; excluded: Array<{ source: string; reason: string }>; operations: "add-only" };
  verification: {
    required: string[];
    /** The subject the promoted copy must reproduce: the extraction's own, digest for digest. */
    subject: Record<string, string>;
    against: Record<string, string>;
    runner: { path: string; sha256: string };
    host: string;
    mutations: boolean;
  };
  approvals: Array<{ action: string; subject: string; supported: boolean; note: string }>;
  execution: string[];
  run: string;
  limitations: Array<{ code: string; description: string }>;
  questions: Array<{ id: string; question: string }>;
  scope: { grantsAuthority: false; modifiesExistingFiles: false; commits: false; pushes: false; deploys: false };
  digest: string;
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const contained = (root: string, relative: string) => {
  if (!relative || isAbsolute(relative) || normalize(relative).split(sep).includes("..") || normalize(relative).split(sep).includes(".git")) return undefined;
  const absolute = resolve(root, relative);
  return absolute.startsWith(resolve(root) + sep) ? absolute : undefined;
};

/** The reviewed promotion plan of an extraction, checked for shape and containment. */
export function readPromotionPlan(entry: ExtractionEntry): { plan: PromotionPlan; digest: string } {
  const path = join(entry.directory, "promotion", "promotion-plan.json");
  if (!existsSync(path)) throw new WorkspaceError("PROMOTION_PLAN_MISSING", `${entry.name} has no reviewed promotion plan (promotion/promotion-plan.json); the workspace does not invent one`);
  let plan: PromotionPlan;
  const text = readFileSync(path, "utf8");
  try {
    plan = JSON.parse(text) as PromotionPlan;
  } catch {
    throw new WorkspaceError("PROMOTION_PLAN_INVALID", `${path} is not JSON`);
  }
  const problems: string[] = [];
  if (plan.format !== PROMOTION_PLAN_FORMAT) problems.push(`format is ${PROMOTION_PLAN_FORMAT}`);
  if (plan.extraction !== entry.identity.name) problems.push(`the plan is for ${plan.extraction}, not ${entry.identity.name}`);
  if (!plan.target || !contained("/repo", plan.target.directory ?? "")) problems.push("target.directory is a relative path inside the repository, outside .git");
  const seen = new Set<string>();
  for (const f of plan.target?.files ?? []) {
    if (!contained(entry.directory, f.source)) problems.push(`source ${f.source} is not inside the extraction`);
    if (!contained("/repo", join(plan.target.directory, f.path))) problems.push(`target ${f.path} is not inside ${plan.target.directory}`);
    if (!["adapter", "declaration", "contract", "documentation"].includes(f.role)) problems.push(`${f.path}: unknown role ${f.role}`);
    if (seen.has(f.path)) problems.push(`${f.path} is listed twice`);
    seen.add(f.path);
  }
  if (!plan.verification || typeof plan.verification.runner !== "string" || !contained(entry.directory, plan.verification.runner)) problems.push("verification.runner is a file inside the extraction");
  if (plan.requirements && !contained("/repo", plan.requirements.lockfile ?? "")) problems.push("requirements.lockfile is a path inside the repository");
  if (problems.length) throw new WorkspaceError("PROMOTION_PLAN_INVALID", `promotion-plan.json: ${problems.join("; ")}`, { problems });
  return { plan, digest: `sha256:${sha(text)}` };
}

export interface PromotionInput {
  project: string;
  /** The pinned checkout, read for the target's lockfile. */
  checkout: string;
  repository: { url: string; owner: string; name: string };
  revision: string;
  entry: ExtractionEntry;
  extraction: CapabilityExtraction;
  adoptionDigest: string;
}

/** Builds the promotion artifact. Refuses with reason codes when the plan does not match the verified extraction. */
export function buildPromotion(input: PromotionInput): Promotion {
  const { entry, extraction: x } = input;
  const { plan, digest: planDigest } = readPromotionPlan(entry);
  const reasons: Array<{ code: string; message: string }> = [];
  if (x.source.revision !== input.revision) reasons.push({ code: "PROMOTION_REVISION_STALE", message: `the extraction is of ${x.source.revision}, the project is pinned to ${input.revision}` });
  if (!x.adapter || !x.fulfillment || !x.runtime) reasons.push({ code: "PROMOTION_EXTRACTION_INCOMPLETE", message: "only an implemented /2 extraction with an adapter, a declaration and a runtime can be promoted" });
  const adapterDigests = new Map((x.adapter?.files ?? []).map((f) => [f.path, f.digest]));
  const files: PromotionFile[] = [];
  for (const f of plan.target.files) {
    const absolute = contained(entry.directory, f.source)!;
    let bytes: Buffer;
    try {
      if (!lstatSync(absolute).isFile()) throw new Error();
      bytes = readFileSync(absolute);
    } catch {
      reasons.push({ code: "PROMOTION_SOURCE_MISSING", message: `${f.source} cannot be read` });
      continue;
    }
    const digest = sha(bytes);
    if (f.role === "adapter" || f.role === "declaration") {
      const verified = adapterDigests.get(f.source);
      if (!verified) reasons.push({ code: "PROMOTION_NOT_VERIFIED_FILE", message: `${f.source} is not one of the files the extraction verified` });
      else if (verified !== `sha256:${digest}`) reasons.push({ code: "PROMOTION_SOURCE_CHANGED", message: `${f.source} is not the file the extraction verified (${verified})` });
    }
    if (f.role === "declaration" && x.fulfillment && digestOf(JSON.parse(bytes.toString("utf8"))) !== digestOf({ extensions: x.fulfillment.extensions, attributes: x.fulfillment.attributes })) reasons.push({ code: "PROMOTION_DECLARATION_CHANGED", message: `${f.source} is not the declaration the extraction verified` });
    if (f.role === "contract") {
      try {
        const manifest = JSON.parse(bytes.toString("utf8")) as AppPortManifest;
        if (contractDigest(manifest) !== x.contract.contractDigest || capabilityDigest(manifest, x.contract.capability.name, x.contract.capability.version) !== x.contract.capabilityDigest) reasons.push({ code: "PROMOTION_CONTRACT_CHANGED", message: `${f.source} is not the contract the extraction verified` });
      } catch {
        reasons.push({ code: "PROMOTION_CONTRACT_CHANGED", message: `${f.source} is not a readable contract` });
      }
    }
    files.push({ path: `${plan.target.directory}/${f.path}`, source: f.source, role: f.role, operation: "add", mode: "100644", sha256: `sha256:${digest}`, bytes: bytes.length });
  }
  // Every file the extraction verified is either promoted or excluded with a reason.
  for (const path of adapterDigests.keys()) if (!plan.target.files.some((f) => f.source === path) && !plan.target.excluded.some((e) => e.source === path)) reasons.push({ code: "PROMOTION_FILE_UNACCOUNTED", message: `${path} is neither promoted nor excluded` });
  if (!plan.target.files.some((f) => f.role === "contract")) reasons.push({ code: "PROMOTION_CONTRACT_MISSING", message: "the adopted contract is not part of the promotion" });
  if (!plan.target.files.some((f) => f.role === "declaration")) reasons.push({ code: "PROMOTION_DECLARATION_MISSING", message: "the fulfillment declaration is not part of the promotion" });
  const runnerPath = contained(entry.directory, plan.verification.runner)!;
  if (!existsSync(runnerPath)) reasons.push({ code: "PROMOTION_RUNNER_MISSING", message: `${plan.verification.runner} does not exist` });
  if (reasons.length) throw new WorkspaceError(reasons[0]!.code, reasons.map((r) => r.message).join("; "), { reasons });

  const subject = x.verification.records[0]!.subject as unknown as Record<string, string>;
  // The runtime's packages, against the target's own pins at the base revision.
  let locked: Record<string, { version?: string }> = {};
  const lockfile = plan.requirements?.lockfile ?? null;
  if (lockfile) {
    try {
      locked = (JSON.parse(readFileSync(contained(input.checkout, lockfile)!, "utf8")) as { packages?: Record<string, { version?: string }> }).packages ?? {};
    } catch {
      throw new WorkspaceError("PROMOTION_PLAN_INVALID", `the target lockfile ${lockfile} cannot be read at ${input.revision}`);
    }
  }

  const requirements = Object.entries(x.runtime!.packages)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, required]) => {
      const target = locked[`node_modules/${name}`]?.version ?? null;
      return { name, required, target, met: target === required };
    });
  const content: Omit<Promotion, "digest"> = {
    format: PROMOTION_FORMAT,
    project: input.project,
    source: { repository: input.repository.url, owner: input.repository.owner, name: input.repository.name, revision: input.revision },
    capability: { provider: x.fulfillment!.provider, contract: { application: x.contract.capability.contract, capability: x.contract.capability.name, version: x.contract.capability.version, capabilityDigest: x.contract.capabilityDigest, contractDigest: x.contract.contractDigest } },
    assessment: { digest: x.assessment.digest, candidate: x.assessment.candidate.id },
    extraction: { name: entry.name, directory: `extractions/${entry.name}`, digest: x.digest, format: x.format, identity: { name: x.identity.name, revision: x.identity.revision }, adapterDigest: x.adapter!.digest },
    adoption: { digest: input.adoptionDigest },
    fulfillment: { declarationDigest: x.fulfillment!.digest },
    runtime: x.runtime!,
    requirements: { lockfile, packages: lockfile ? requirements : [] },
    plan: { digest: planDigest },
    target: { base: input.revision, directory: plan.target.directory, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)), excluded: plan.target.excluded, operations: "add-only" },
    verification: {
      required: [...x.verification.required],
      subject,
      against: Object.fromEntries(x.verification.records.map((r) => [r.behavior, r.against ?? "none"])),
      runner: { path: plan.verification.runner, sha256: `sha256:${sha(readFileSync(runnerPath))}` },
      host: `${plan.target.directory}/${plan.verification.host}`,
      mutations: plan.verification.mutations
    },
    approvals: [
      { action: "adopt-contract", subject: input.adoptionDigest, supported: true, note: "granted and consumed before this artifact was made" },
      { action: "modify-integration", subject: "this artifact's digest", supported: true, note: "adds exactly target.files to an isolated worktree, then runs the verification runner against it" },
      { action: "commit", subject: "the applied patch", supported: true, note: "a local commit in the isolated worktree; nothing leaves the workspace" },
      { action: "push", subject: "the commit", supported: false, note: "@appport/github has no push or commit contract" },
      { action: "pull-request", subject: "the pushed branch", supported: false, note: "needs the branch on GitHub, which needs push" },
      { action: "promote", subject: "a deployment", supported: false, note: "no deployment contract" }
    ],
    execution: [
      `the application is built with the extraction's declared build: ${x.runtime!.application.build ?? "(none declared)"}`,
      `node runs ${plan.verification.runner} (sha256 above): the extraction's behavioral suite against the promoted host in the isolated worktree${plan.verification.mutations ? ", then its mutation check against copies of the promoted host" : ""}`,
      "no other script of the target repository runs, nothing is installed into it, and nothing outside target.files is written to it"
    ],
    run: plan.run,
    limitations: [...plan.limitations, ...x.limitations],
    questions: x.questions,
    scope: { grantsAuthority: false, modifiesExistingFiles: false, commits: false, pushes: false, deploys: false }
  };
  return { ...content, digest: digestOf(content) };
}

/**
 * Checks a stored promotion artifact against what is current: its own digest, the pinned revision, the extraction and
 * adoption it names, and the bytes of every file it would add. Every mismatch is a reason code; any one refuses.
 */
export function promotionProblems(value: unknown, current: { revision?: string; extractionDigest?: string; adoptionDigest?: string; extractionDirectory?: string }): Array<{ code: string; message: string }> {
  const a = value as Promotion;
  if (!a || typeof a !== "object" || a.format !== PROMOTION_FORMAT) return [{ code: "PROMOTION_FORMAT", message: `not ${PROMOTION_FORMAT}` }];
  const out: Array<{ code: string; message: string }> = [];
  const { digest, ...content } = a;
  if (digestOf(content) !== digest) out.push({ code: "PROMOTION_DIGEST_MISMATCH", message: "the artifact's content does not match its digest" });
  if (current.revision !== undefined && a.source.revision !== current.revision) out.push({ code: "PROMOTION_REVISION_STALE", message: `the artifact is for ${a.source.revision}; the project is pinned to ${current.revision}` });
  if (current.extractionDigest !== undefined && a.extraction.digest !== current.extractionDigest) out.push({ code: "PROMOTION_EXTRACTION_MISMATCH", message: "the artifact names another extraction than the project's current one" });
  if (current.adoptionDigest !== undefined && a.adoption.digest !== current.adoptionDigest) out.push({ code: "PROMOTION_ADOPTION_MISMATCH", message: "the artifact names another contract adoption than the one adopted" });
  for (const f of a.target.files) {
    if (!contained("/repo", f.path)) out.push({ code: "PROMOTION_PATH_INVALID", message: `${f.path} is not a path inside the repository` });
    if (current.extractionDirectory) {
      const absolute = contained(current.extractionDirectory, f.source);
      let actual = "";
      try {
        actual = `sha256:${sha(readFileSync(absolute!))}`;
      } catch {
        /* reported below */
      }
      if (actual !== f.sha256) out.push({ code: "PROMOTION_SOURCE_CHANGED", message: `${f.source} changed since the artifact was made` });
    }
  }
  return out;
}

/** The digest of an applied patch: the base and every added file's path, mode and bytes. Independent of git formatting. */
export const patchDigest = (base: string, files: Array<{ path: string; sha256: string; mode: string }>) => digestOf({ base, files: [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map(({ path, sha256, mode }) => ({ path, sha256, mode })) });

/** Writes the artifact's files into the worktree; a file already there with the same bytes is left alone. */
export function writePromotionFiles(a: Promotion, extractionDirectory: string, worktree: string): { written: string[]; present: string[] } {
  const written: string[] = [];
  const present: string[] = [];
  for (const f of a.target.files) {
    const bytes = readFileSync(contained(extractionDirectory, f.source)!);
    if (`sha256:${sha(bytes)}` !== f.sha256) throw new WorkspaceError("PROMOTION_SOURCE_CHANGED", `${f.source} changed since the artifact was made`);
    const target = contained(worktree, f.path);
    if (!target) throw new WorkspaceError("PROMOTION_PATH_INVALID", `${f.path} is not inside the worktree`);
    if (existsSync(target)) {
      if (`sha256:${sha(readFileSync(target))}` !== f.sha256) throw new WorkspaceError("DESTINATION_DIRTY", `${f.path} already exists in the worktree with other content`);
      present.push(f.path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    written.push(f.path);
  }
  return { written, present };
}

/** Each listed worktree file's digest as it is now (undefined when absent). */
export function worktreeFileDigests(worktree: string, paths: string[]): Record<string, string | undefined> {
  return Object.fromEntries(
    paths.map((p) => {
      const absolute = contained(worktree, p);
      try {
        return [p, absolute && lstatSync(absolute).isFile() ? `sha256:${sha(readFileSync(absolute))}` : undefined];
      } catch {
        return [p, undefined];
      }
    })
  );
}
