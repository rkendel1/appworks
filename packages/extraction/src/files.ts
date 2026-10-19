/**
 * Reading an extraction's inputs from disk: the plan, its contract and adapter sources, and the boundary files and
 * revision of the application checkout. Reads only; never writes, executes, imports or fetches. Paths are contained:
 * adapter files inside the plan's directory, boundary files inside the repository (no symbolic links followed).
 */
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gitIdentity, readRepositoryFile, repositoryRoot, verifyAssessment, type ApplicationAssessment } from "@appport/assessment";
import { verifyExtraction, type CapabilityExtraction, type VerificationFinding } from "./artifact.js";
import type { ExtractInput, ExtractionPlan } from "./extract.js";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

export function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new InputError(`cannot read ${what} ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`${what} ${path} is not JSON: ${(error as Error).message}`);
  }
}

/** Reads a file inside `base`, refusing absolute paths, escapes and symbolic links. */
function readContained(base: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const absolute = resolve(base, path);
  const rel = relative(base, absolute);
  if (rel.startsWith("..") || rel.startsWith(sep) || isAbsolute(rel)) return undefined;
  try {
    if (lstatSync(absolute).isSymbolicLink()) return undefined;
    return readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
}

/** Everything `createExtraction` needs from a plan file. */
export function readPlan(planPath: string, repository: string): NonNullable<ExtractInput["plan"]> {
  const plan = readJson(planPath, "extraction plan") as ExtractionPlan;
  if (plan === null || typeof plan !== "object" || !plan.adapter || !Array.isArray(plan.adapter.files) || !Array.isArray(plan.adapter.boundary?.files) || typeof plan.contract !== "string")
    throw new InputError(`${planPath} is not an extraction plan`);
  const base = dirname(resolve(planPath));
  const contractText = readContained(base, plan.contract);
  if (contractText === undefined) throw new InputError(`the plan's contract ${plan.contract} cannot be read inside ${base}`);
  let contract: unknown;
  try {
    contract = JSON.parse(contractText);
  } catch (error) {
    throw new InputError(`the plan's contract ${plan.contract} is not JSON: ${(error as Error).message}`);
  }
  const root = repositoryRoot(repository);
  const adapterFiles: Record<string, string> = {};
  for (const path of plan.adapter.files) {
    const text = readContained(base, path);
    if (text !== undefined) adapterFiles[path] = text;
  }
  const boundaryFiles: Record<string, string> = {};
  for (const path of plan.adapter.boundary.files) {
    try {
      boundaryFiles[path] = readRepositoryFile(root, path);
    } catch {
      /* reported as BOUNDARY_FILE_MISSING */
    }
  }
  return { plan, contract, adapterFiles, boundaryFiles };
}

/** The checkout's revision and the assessment's location check against it. */
export function observeCheckout(assessment: unknown, repository: string): ExtractInput["checkout"] {
  const root = repositoryRoot(repository);
  const result = verifyAssessment(assessment, { repository: root });
  const location = result.findings.filter((f) => f.code.startsWith("LOCATION_"));
  return { revision: gitIdentity(root).revision, locationsVerified: { ok: location.length === 0, codes: [...new Set(location.map((f) => f.code))] } };
}

/**
 * Verifies an extraction against what is on disk: optionally the assessment it names, the repository at the source
 * revision (revision and boundary files), and the adapter sources next to its plan.
 */
export function verifyExtractionAt(extraction: unknown, options: { assessment?: ApplicationAssessment; repository?: string; planDirectory?: string }): { ok: boolean; findings: VerificationFinding[] } {
  const x = extraction as CapabilityExtraction;
  const adapter = x && typeof x === "object" ? x.adapter : null;
  const adapterFiles: Record<string, string> | undefined = options.planDirectory && adapter ? {} : undefined;
  if (adapterFiles && adapter && Array.isArray(adapter.files))
    for (const f of adapter.files) {
      const text = readContained(resolve(options.planDirectory!), f.path);
      if (text !== undefined) adapterFiles[f.path] = text;
    }
  let boundaryFiles: Record<string, string> | undefined;
  let repositoryRevision: string | undefined;
  if (options.repository !== undefined) {
    const root = repositoryRoot(options.repository);
    repositoryRevision = gitIdentity(root).revision ?? "";
    if (adapter && Array.isArray(adapter.boundary?.files)) {
      boundaryFiles = {};
      for (const f of adapter.boundary.files)
        try {
          boundaryFiles[f.path] = readRepositoryFile(root, f.path);
        } catch {
          /* reported as BOUNDARY_MISMATCH */
        }
    }
  }
  const result = verifyExtraction(extraction, { ...(options.assessment ? { assessment: options.assessment } : {}), ...(adapterFiles ? { adapterFiles } : {}), ...(boundaryFiles ? { boundaryFiles } : {}), ...(repositoryRevision !== undefined ? { repositoryRevision } : {}) });
  if (options.assessment) {
    const assessed = verifyAssessment(options.assessment);
    for (const f of assessed.findings) result.findings.push({ code: "ASSESSMENT_INVALID", path: `/assessment${f.path}`, message: `${f.code}: ${f.message}` });
  }
  return { ok: result.findings.length === 0, findings: result.findings };
}
