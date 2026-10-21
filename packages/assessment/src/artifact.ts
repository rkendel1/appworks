/**
 * The `appport.application-assessment/1` artifact: its shape, its content digest and its verifier
 * (spec/assessment-1.md §3, §6–§8).
 *
 * An assessment describes what a static reading of a repository found. It is not a capability contract, a fulfillment
 * claim, a registry entry or an authorization grant, and nothing in it is verified behavior: `scope` states this, and
 * the verifier rejects an artifact that claims otherwise.
 */
import { canonicalize, digestOf, isDigest, sha256, type CapabilityEffect, type CapabilityVersionEntry } from "@appport/protocol";
import { lstatSync } from "node:fs";
import { gitIdentity, isInside, readRepositoryFile, repositoryRoot, type SkipReason } from "./files.js";

export const ASSESSMENT_FORMAT = "appport.application-assessment/1";
export const SCANNER_VERSION = "appport.assessment-scanner/1";
/**
 * Scanner 2 adds HTTP-route candidates read from JavaScript and TypeScript (`js.ts`), and needs a format that can say so: `/2`
 * is `/1` plus an `http` operation, an `http-route` entry point and the `js-static` collection method. Scanner 1 is unchanged
 * and still writes `/1`, byte for byte, so every existing assessment (and every extraction that records one's digest) reproduces.
 */
export const ASSESSMENT_FORMAT_2 = "appport.application-assessment/2";
export const SCANNER_VERSION_2 = "appport.assessment-scanner/2";
export const ASSESSMENT_FORMATS = [ASSESSMENT_FORMAT, ASSESSMENT_FORMAT_2] as const;
/** Which scanner each format is written by; a reader refuses a mismatch. */
export const SCANNER_OF_FORMAT: Record<string, string> = { [ASSESSMENT_FORMAT]: SCANNER_VERSION, [ASSESSMENT_FORMAT_2]: SCANNER_VERSION_2 };
export const TOOL_NAME = "@appport/assessment";
export const TOOL_VERSION = "0.1.0";

/**
 * - `observed`: a statement about what the repository text contains at a location (a declaration, a call, a literal).
 *   It can be checked by reading the cited lines.
 * - `inferred`: a conclusion drawn from observed evidence by a stated rule (a handler implements an RPC because name and
 *   request type match). It cites its basis and may be wrong.
 * - `unknown`: something the assessment looked for and could not determine. It is never evidence that a thing is absent.
 */
export const EVIDENCE_CLASSES = ["observed", "inferred", "unknown"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const COLLECTION_METHODS = ["scanner", "manifest-parse", "proto-static", "go-static", "path-convention", "git-metadata", "derivation", "js-static"] as const;
/** Methods only `/2` may use. */
export const FORMAT_2_METHODS: readonly string[] = ["js-static"];
export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

export interface Location {
  /** Repository-relative, `/`-separated. */
  path: string;
  startLine: number;
  endLine: number;
}

export interface Evidence {
  /** `ev-` and 16 hex characters of the record's content hash: the same fact always has the same id. */
  id: string;
  class: EvidenceClass;
  /** What kind of fact, e.g. `proto.rpc`, `go.function`, `go.call`, `sql.statement`, `link.rpc-handler`. */
  kind: string;
  location?: Location;
  /** The symbol, route, key or literal the record is about. For observed evidence it occurs in the cited lines. */
  subject?: string;
  observation: string;
  method: CollectionMethod;
  /** For inferred evidence: the evidence it was derived from, including at least one observed record. */
  basis?: string[];
  limitations?: string[];
}

export const READINESS_CLASSES = ["exposure-candidate", "investigate", "insufficient-evidence"] as const;
export type ReadinessClass = (typeof READINESS_CLASSES)[number];

export const CRITERIA = ["entry-point", "implementation", "io-schema", "validation", "authorization", "tests", "reachability-complete", "small-surface"] as const;
export type Criterion = (typeof CRITERIA)[number];
export const CONCERNS = ["outbound-http", "async-work", "writes-state", "unresolved-interface"] as const;
export type Concern = (typeof CONCERNS)[number];
/** Concerns that prevent `exposure-candidate`; the rest only order candidates. */
export const BLOCKING_CONCERNS: readonly Concern[] = ["outbound-http", "async-work", "unresolved-interface"];

export interface CriterionResult {
  criterion: Criterion;
  satisfied: boolean;
  /** Stable reason code, e.g. `handler-matched-by-name-and-request-type`. */
  reason: string;
  evidence: string[];
}

export interface Readiness {
  class: ReadinessClass;
  criteria: CriterionResult[];
  concerns: Array<{ concern: Concern; evidence: string[] }>;
}

export interface SchemaField {
  name: string;
  jsonName: string;
  type: string;
  label: "singular" | "optional" | "repeated" | "required";
  behaviors: string[];
  oneof?: string;
  evidence: string[];
}

export interface MessageShape {
  /** Fully qualified message name. */
  message: string;
  resolved: boolean;
  fields: SchemaField[];
  /** Nested type references that could not be resolved. */
  unresolvedTypes: string[];
  evidence: string[];
}

/**
 * A proposed AppPort capability shape: published `@appport/protocol` types, filled from the assessment. Proposed, never
 * authoritative: it has no permissions, no fulfillment claim and no verification method, and it registers nothing.
 */
export type ProposedCapability = { name: string } & Pick<CapabilityVersionEntry, "version" | "kind" | "inputSchema" | "outputSchema" | "effect">;

export interface ExposureProposal {
  status: "proposed";
  authoritative: false;
  /** Absent when no valid AppPort name could be derived. */
  capability?: ProposedCapability;
  effectBasis: { effect: CapabilityEffect; reasons: string[]; evidence: string[] };
  /** What a contract needs that the assessment cannot supply. */
  missing: string[];
}

/** `/2` only: an HTTP route registered in source. `path` is the full path with mounts applied; `{name}` marks a name in it whose value is not known. */
export interface HttpOperation {
  kind: "http";
  method: string;
  path: string;
  framework: string;
  /** Names standing in the path whose values the assessment did not establish (`/${entity}/list` has `entity`). */
  placeholders: string[];
}

export interface Candidate {
  /** Stable: derived from the entry point, e.g. `cand-memos.api.MemoService.GetMemo`. */
  id: string;
  name: string;
  /** Describes the construct, never what it does: names and comments are not semantic evidence. */
  description: string;
  operation: { kind: "rpc"; service: string; method: string; fullMethod: string; streaming: boolean } | HttpOperation;
  entryPoints: Array<{ kind: "proto-rpc" | "http-binding" | "http-route"; subject: string; evidence: string[] }>;
  implementation?: { symbol: string; location: Location; link: "name-and-request-type" | "name-only" | "route-inline" | "route-handler-reference"; evidence: string[] };
  inputs?: MessageShape;
  outputs?: MessageShape;
  dependencies: {
    /** Repository functions statically reachable from the implementation, within the configured limits. */
    reachableFunctions: Array<{ symbol: string; path: string; depth: number; evidence: string[] }>;
    /** External packages called, by import path. */
    externalPackages: Array<{ importPath: string; evidence: string[] }>;
    /** Call sites the static reader could not resolve (calls through values, closures, fields of function type). */
    unresolvedCalls: number;
    truncated: boolean;
  };
  sideEffects: {
    persistence: Array<{ operation: "read" | "write" | "unknown"; statement: string; evidence: string[] }>;
    outboundHttp: string[];
    async: string[];
  };
  authorization: { denials: string[]; policyReferences: string[] };
  validation: { rejections: string[] };
  tests: Array<{ symbol: string; path: string; evidence: string[] }>;
  evidence: string[];
  /** How the implementation was linked: the strongest link determines it; it is not a probability. */
  confidence: "linked" | "weakly-linked" | "unlinked";
  readiness: Readiness;
  unknowns: string[];
  exposure: ExposureProposal;
}

export interface Finding {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  evidence?: string[];
}

export interface Question {
  id: string;
  candidate?: string;
  question: string;
  evidence: string[];
}

export interface Recommendation {
  candidate: string;
  readiness: ReadinessClass;
  /** Criteria the candidate satisfies, and the ranking rules that put it first. */
  reasons: string[];
  ranking: { rules: string[]; position: 1; of: number; alternatives: string[] };
  /** Unknowns and questions to resolve before exposure. */
  beforeExposure: string[];
}

export interface Coverage {
  filesSeen: number;
  filesAnalyzed: number;
  languages: Array<{ language: string; files: number; supported: boolean }>;
  skipped: Array<{ path: string; reason: SkipReason }>;
  malformed: Array<{ path: string; line: number; message: string }>;
  unsupportedIgnorePatterns: string[];
  partial: boolean;
  partialReasons: string[];
}

export interface AssessmentConfiguration {
  scanner: typeof SCANNER_VERSION | typeof SCANNER_VERSION_2;
  maxFileBytes: number;
  excludedDirectories: string[];
  maxCallDepth: number;
  maxReachableFunctions: number;
  smallSurface: { maxHandlerLines: number; maxReachableFunctions: number };
}

export interface Inventory {
  manifests: Array<{ path: string; kind: "go.mod" | "package.json"; name?: string; evidence: string[] }>;
  constructs: { protoServices: number; protoMethods: number; goPackages: number; goFunctions: number; goTestFunctions: number; httpRoutes: number };
  entryPoints: Array<{ candidate: string; kind: string; subject: string; evidence: string[] }>;
  persistence: Array<{ operation: "read" | "write" | "unknown"; path: string; evidence: string[] }>;
  integrations: Array<{ kind: "outbound-http" | "module-dependency"; subject: string; evidence: string[] }>;
  configuration: Array<{ source: "env" | "flag" | "viper"; key: string; evidence: string[] }>;
  authorization: Array<{ kind: "policy-reference" | "denial"; subject: string; evidence: string[] }>;
  tests: { files: number; functions: number };
}

export interface ApplicationAssessment {
  format: typeof ASSESSMENT_FORMAT | typeof ASSESSMENT_FORMAT_2;
  /** Volatile: excluded from the digest. */
  assessment: { id: string; createdAt: string };
  tool: { name: string; version: string };
  target: { name: string; nameSource: "go.mod" | "package.json" | "directory"; repository?: string; revision?: string; ref?: string };
  configuration: AssessmentConfiguration;
  coverage: Coverage;
  evidence: Evidence[];
  inventory: Inventory;
  candidates: Candidate[];
  recommendation: Recommendation | null;
  findings: Finding[];
  limitations: Array<{ code: string; description: string }>;
  questions: Question[];
  scope: { grantsAuthority: false; verifiesBehavior: false; modifiesTarget: false };
  digest: string;
}

/** The evidence id rule: a hash of everything in the record except the id itself. */
export function evidenceId(record: Omit<Evidence, "id">): string {
  return `ev-${sha256(canonicalize(record)).slice(0, 16)}`;
}

/** The content digest: `digestOf` (RFC 8785, sha256) over the artifact without `digest` and the volatile `assessment`. */
export function assessmentDigest(artifact: Omit<ApplicationAssessment, "digest"> | ApplicationAssessment): string {
  const { digest: _digest, assessment: _volatile, ...content } = artifact as ApplicationAssessment;
  return digestOf(content);
}

export interface VerificationFinding {
  code: string;
  /** JSON pointer into the artifact. */
  path: string;
  message: string;
}

const TOP_LEVEL = ["format", "assessment", "tool", "target", "configuration", "coverage", "evidence", "inventory", "candidates", "recommendation", "findings", "limitations", "questions", "scope", "digest"];
const EVIDENCE_MEMBERS = ["id", "class", "kind", "location", "subject", "observation", "method", "basis", "limitations"];
const CANDIDATE_MEMBERS = ["id", "name", "description", "operation", "entryPoints", "implementation", "inputs", "outputs", "dependencies", "sideEffects", "authorization", "validation", "tests", "evidence", "confidence", "readiness", "unknowns", "exposure"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every evidence reference outside the evidence list: string arrays under a member named `evidence`. */
function evidenceReferences(value: unknown, pointer: string, out: Array<{ id: unknown; pointer: string }>) {
  if (Array.isArray(value)) value.forEach((v, k) => evidenceReferences(v, `${pointer}/${k}`, out));
  else if (isObject(value))
    for (const [key, v] of Object.entries(value)) {
      if (key === "evidence" && Array.isArray(v)) v.forEach((id, k) => out.push({ id, pointer: `${pointer}/evidence/${k}` }));
      else evidenceReferences(v, `${pointer}/${key}`, out);
    }
}

/**
 * Verifies an assessment artifact's integrity and honesty. Without `repository` it checks structure, references,
 * evidence classes and the digest. With `repository` it also checks every observed location against the files: the
 * path exists inside the root, the lines exist, and the subject occurs in them.
 */
export function verifyAssessment(value: unknown, options: { repository?: string } = {}): { ok: boolean; findings: VerificationFinding[] } {
  const findings: VerificationFinding[] = [];
  const add = (code: string, path: string, message: string) => findings.push({ code, path, message });
  if (!isObject(value)) {
    add("ASSESSMENT_MALFORMED", "", "an assessment is a JSON object");
    return { ok: false, findings };
  }
  if (!(ASSESSMENT_FORMATS as readonly unknown[]).includes(value.format)) add("ASSESSMENT_FORMAT", "/format", `unsupported format ${JSON.stringify(value.format)}; this reader implements ${ASSESSMENT_FORMATS.join(" and ")}`);
  for (const key of Object.keys(value)) if (!TOP_LEVEL.includes(key)) add("ASSESSMENT_MEMBER", `/${key}`, `undocumented member "${key}"`);
  for (const key of TOP_LEVEL) if (!(key in value)) add("ASSESSMENT_MEMBER", `/${key}`, `missing member "${key}"`);
  if (findings.length) return { ok: false, findings };

  const configuredScanner = isObject(value.configuration) ? value.configuration.scanner : undefined;
  if (configuredScanner !== SCANNER_OF_FORMAT[value.format as string]) add("ASSESSMENT_SCANNER", "/configuration/scanner", `${String(value.format)} is written by ${SCANNER_OF_FORMAT[value.format as string]}, not ${JSON.stringify(configuredScanner)}`);
  const evidence = value.evidence;
  const candidates = value.candidates;
  if (!Array.isArray(evidence) || !Array.isArray(candidates)) {
    add("ASSESSMENT_MALFORMED", "/evidence", "evidence and candidates are arrays");
    return { ok: false, findings };
  }

  // Evidence records.
  const byId = new Map<string, Record<string, unknown>>();
  evidence.forEach((record, k) => {
    const at = `/evidence/${k}`;
    if (!isObject(record)) return add("EVIDENCE_MALFORMED", at, "an evidence record is an object");
    for (const key of Object.keys(record)) if (!EVIDENCE_MEMBERS.includes(key)) add("EVIDENCE_MEMBER", `${at}/${key}`, `undocumented member "${key}"`);
    const id = record.id;
    if (typeof id !== "string") return add("EVIDENCE_MALFORMED", `${at}/id`, "id is a string");
    if (byId.has(id)) add("EVIDENCE_DUPLICATE", `${at}/id`, `duplicate evidence id ${id}`);
    byId.set(id, record);
    const { id: _id, ...content } = record;
    if (evidenceId(content as Omit<Evidence, "id">) !== id) add("EVIDENCE_ID", `${at}/id`, `${id} is not the content id of this record`);
    if (!EVIDENCE_CLASSES.includes(record.class as EvidenceClass)) add("EVIDENCE_CLASS", `${at}/class`, `unknown evidence class ${JSON.stringify(record.class)}`);
    if (!COLLECTION_METHODS.includes(record.method as CollectionMethod) || (value.format === ASSESSMENT_FORMAT && FORMAT_2_METHODS.includes(record.method as string))) add("EVIDENCE_METHOD", `${at}/method`, `unknown collection method ${JSON.stringify(record.method)} for ${String(value.format)}`);
    if (typeof record.kind !== "string" || typeof record.observation !== "string") add("EVIDENCE_MALFORMED", at, "kind and observation are strings");
    const location = record.location;
    if (location !== undefined) {
      if (
        !isObject(location) ||
        typeof location.path !== "string" ||
        location.path.startsWith("/") ||
        location.path.split("/").includes("..") ||
        !Number.isInteger(location.startLine) ||
        !Number.isInteger(location.endLine) ||
        (location.startLine as number) < 1 ||
        (location.endLine as number) < (location.startLine as number)
      )
        add("EVIDENCE_LOCATION", `${at}/location`, "a location is a repository-relative path and a line range starting at 1");
    }
    if (record.class === "observed" && location === undefined && record.method !== "scanner") add("EVIDENCE_LOCATION", at, "observed evidence cites a location");
  });
  evidence.forEach((record, k) => {
    if (!isObject(record)) return;
    const at = `/evidence/${k}`;
    const basis = record.basis;
    if (record.class === "inferred") {
      if (!Array.isArray(basis) || basis.length === 0) return add("EVIDENCE_BASIS", `${at}/basis`, "inferred evidence cites its basis");
      if (!basis.some((b) => byId.get(b as string)?.class === "observed")) add("EVIDENCE_BASIS", `${at}/basis`, "inferred evidence cites at least one observed record");
    }
    if (Array.isArray(basis))
      basis.forEach((b, j) => {
        const target = byId.get(b as string);
        if (!target) add("EVIDENCE_REFERENCE", `${at}/basis/${j}`, `unknown evidence ${JSON.stringify(b)}`);
        else if (target.class === "unknown") add("EVIDENCE_BASIS", `${at}/basis/${j}`, "an unknown cannot be the basis of anything");
      });
    else if (basis !== undefined) add("EVIDENCE_MALFORMED", `${at}/basis`, "basis is an array");
  });

  // References from everywhere else.
  const references: Array<{ id: unknown; pointer: string }> = [];
  for (const key of TOP_LEVEL.filter((k) => k !== "evidence")) evidenceReferences(value[key], `/${key}`, references);
  for (const { id, pointer } of references) if (typeof id !== "string" || !byId.has(id)) add("EVIDENCE_REFERENCE", pointer, `unknown evidence ${JSON.stringify(id)}`);

  // Candidates and their readiness.
  const candidateIds = new Set<string>();
  candidates.forEach((candidate, k) => {
    const at = `/candidates/${k}`;
    if (!isObject(candidate)) return add("CANDIDATE_MALFORMED", at, "a candidate is an object");
    for (const key of Object.keys(candidate)) if (!CANDIDATE_MEMBERS.includes(key)) add("CANDIDATE_MEMBER", `${at}/${key}`, `undocumented member "${key}"`);
    if (typeof candidate.id !== "string" || candidateIds.has(candidate.id)) add("CANDIDATE_ID", `${at}/id`, "candidate ids are unique strings");
    else candidateIds.add(candidate.id);
    const operation = candidate.operation;
    if (!isObject(operation) || !(operation.kind === "rpc" || (operation.kind === "http" && value.format === ASSESSMENT_FORMAT_2))) add("CANDIDATE_OPERATION", `${at}/operation/kind`, `an operation is an rpc${value.format === ASSESSMENT_FORMAT_2 ? " or an http route" : " (http routes are appport.application-assessment/2)"}`);
    const readiness = candidate.readiness;
    if (!isObject(readiness) || !READINESS_CLASSES.includes(readiness.class as ReadinessClass)) add("READINESS_CLASS", `${at}/readiness/class`, `readiness is one of ${READINESS_CLASSES.join(", ")}; an assessment never establishes that a capability is verified`);
    const exposure = candidate.exposure;
    if (!isObject(exposure) || exposure.status !== "proposed" || exposure.authoritative !== false) add("EXPOSURE_CLAIM", `${at}/exposure`, "an exposure is a non-authoritative proposal");
  });
  // A verified claim anywhere: a string "verified" as any readiness, status, link or confidence.
  const claims: string[] = [];
  const scan = (v: unknown, pointer: string) => {
    if (Array.isArray(v)) v.forEach((x, k) => scan(x, `${pointer}/${k}`));
    else if (isObject(v)) for (const [key, x] of Object.entries(v)) (["class", "status", "confidence", "readiness", "link"].includes(key) && x === "verified" ? claims.push(`${pointer}/${key}`) : scan(x, `${pointer}/${key}`));
  };
  scan(candidates, "/candidates");
  scan(value.recommendation, "/recommendation");
  for (const pointer of claims) add("VERIFIED_CLAIM", pointer, "an assessment never establishes verified behavior");

  const scope = value.scope;
  if (!isObject(scope) || scope.grantsAuthority !== false || scope.verifiesBehavior !== false || scope.modifiesTarget !== false || Object.keys(scope).length !== 3)
    add("SCOPE_CLAIM", "/scope", "an assessment grants no authority, verifies no behavior and modifies no target");

  const recommendation = value.recommendation;
  if (recommendation !== null) {
    const candidate = isObject(recommendation) ? candidates.find((c) => isObject(c) && c.id === recommendation.candidate) : undefined;
    if (!candidate) add("RECOMMENDATION", "/recommendation/candidate", "the recommendation names a candidate in this assessment");
    else if ((candidate.readiness as Record<string, unknown>)?.class !== "exposure-candidate") add("RECOMMENDATION", "/recommendation", "only an exposure candidate is recommended");
  }
  if (Array.isArray(value.questions))
    value.questions.forEach((q, k) => {
      if (isObject(q) && q.candidate !== undefined && !candidateIds.has(q.candidate as string)) add("QUESTION_REFERENCE", `/questions/${k}/candidate`, "a question names a candidate in this assessment");
    });

  if (!isDigest(value.digest)) add("DIGEST_FORMAT", "/digest", "digest is sha256:<64 hex>");
  else if (assessmentDigest(value as unknown as ApplicationAssessment) !== value.digest) add("DIGEST_MISMATCH", "/digest", "the content does not match its digest");

  if (options.repository !== undefined) verifyLocations(value, options.repository, add);
  return { ok: findings.length === 0, findings };
}

function verifyLocations(value: Record<string, unknown>, repository: string, add: (code: string, path: string, message: string) => void) {
  const root = repositoryRoot(repository);
  const target = value.target as Record<string, unknown> | undefined;
  const identity = gitIdentity(root);
  if (target?.revision !== undefined && identity.revision !== target.revision) add("REVISION_MISMATCH", "/target/revision", `the repository is at ${identity.revision ?? "an unknown revision"}, the assessment at ${String(target.revision)}`);
  const cache = new Map<string, string[] | null>();
  const lines = (path: string) => {
    if (!cache.has(path)) {
      try {
        const absolute = `${root}/${path}`;
        cache.set(path, isInside(root, absolute) && lstatSync(absolute).isFile() ? readRepositoryFile(root, path).split("\n") : null);
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path)!;
  };
  (value.evidence as Array<Record<string, unknown>>).forEach((record, k) => {
    const location = record.location as Location | undefined;
    if (record.class !== "observed" || !location) return;
    const at = `/evidence/${k}/location`;
    const file = lines(location.path);
    if (!file) return add("LOCATION_MISSING", at, `${location.path} is not a readable file in the repository`);
    if (location.endLine > file.length) return add("LOCATION_RANGE", at, `${location.path} has ${file.length} lines; the evidence cites ${location.startLine}-${location.endLine}`);
    const subject = record.subject;
    if (typeof subject === "string" && !file.slice(location.startLine - 1, location.endLine).join("\n").includes(subject)) add("LOCATION_SUBJECT", at, `${JSON.stringify(subject)} does not occur in ${location.path}:${location.startLine}-${location.endLine}`);
  });
}

