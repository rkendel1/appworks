/**
 * The `appport.capability-extraction/1` artifact: its shape, the behaviors an extraction must verify, its content digest
 * and its verifier (spec/extraction-1.md).
 *
 * An extraction binds one assessed operation of an existing application, a proposed AppPort contract, the adapter that
 * exposes the operation through the application's existing AppPort boundary, and the verification of named behaviors.
 * It is a description and provenance record: not a program, not an authorization grant, and not proof of equivalence
 * beyond the behaviors whose verification records say `passed` for exactly this source, contract and adapter.
 */
import {
  FULFILLMENT_EXTENSION,
  canonicalize,
  claimFor,
  fulfillmentAttributes,
  fulfillmentClaims,
  getFulfillment,
  capabilityDigest,
  compareSchemas,
  contractDigest,
  digestOf,
  findCapabilityVersion,
  isCanonicalContract,
  isDigest,
  isValidName,
  lintIntegration,
  sha256,
  type AppPortManifest,
  type JsonValue,
  type JSONSchema,
  type ManifestChange
} from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import type { Evidence, Location } from "@appport/assessment";

/** The format `createExtraction` writes. `/2` adds the fulfillment declaration and the runtime configuration (§9). */
export const EXTRACTION_FORMAT = "appport.capability-extraction/2";
/** Read, never written: artifacts in this format are verified with the `/1` rules, unchanged. */
export const EXTRACTION_FORMAT_V1 = "appport.capability-extraction/1";
export const EXTRACTION_FORMATS = [EXTRACTION_FORMAT_V1, EXTRACTION_FORMAT] as const;
export type ExtractionFormat = (typeof EXTRACTION_FORMATS)[number];
export const EXTRACTION_PLAN_FORMAT = "appport.capability-extraction-plan/2";
export const EXTRACTION_PLAN_FORMAT_V1 = "appport.capability-extraction-plan/1";
export const VERIFICATION_RESULTS_FORMAT = "appport.capability-verification-results/2";
export const TOOL_NAME = "@appport/extraction";
export const TOOL_VERSION = "0.1.0";

export const VERIFICATION_STATUSES = ["not-run", "passed", "failed", "inconclusive"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const PROCEDURE_KINDS = ["integration-test", "unit-test", "static-check", "protocol-check"] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];
/** What a `/2` result was obtained against: the real application, a stub standing in for it, or neither (static and protocol checks). */
export const VERIFICATION_TARGETS = ["real-application", "stub-application", "none"] as const;
export type VerificationTarget = (typeof VERIFICATION_TARGETS)[number];

/**
 * The behaviors every read-only extraction must account for. Each is verified separately; none implies another. A
 * schema check is not behavioral verification, an invocation is not authorization correctness, and a passing run
 * establishes the behavior for the states it exercised, not for every state of the application.
 */
export const BEHAVIORS_V1 = {
  "contract.output-shape": { category: "contract", description: "Valid input produces output of the contracted shape, equal to the source operation's answer." },
  "contract.invalid-input": { category: "contract", description: "Invalid input is rejected, by the contract or by the source operation, and never answered as success." },
  "contract.optional-fields": { category: "contract", description: "Missing and optional fields keep the source operation's semantics; absent proto3 fields map to their defaults, nothing becomes null." },
  "contract.empty-and-multiple": { category: "contract", description: "Empty and multi-element results are returned as such, in the source operation's order." },
  "contract.no-field-omitted": { category: "contract", description: "Every field of the source operation's answer appears in the capability output." },
  "contract.interface-conformance": { category: "contract", description: "The capability the boundary advertises has exactly the contract's schemas, kind and effect (AppPort compareSchemas, both directions)." },
  "authorization.permitted-results": { category: "authorization", description: "An authorized caller receives exactly what the source operation returns to that caller, and no more." },
  "authorization.unauthenticated-denied": { category: "authorization", description: "A caller without a valid credential is denied." },
  "authorization.resource-restriction": { category: "authorization", description: "Resource-specific restrictions of the source operation remain effective: a caller denied by the application is denied through the capability." },
  "authorization.discovery-not-authority": { category: "authorization", description: "Discovering the capability confers no authority to invoke it." },
  "authorization.no-bypass": { category: "authorization", description: "The adapter holds no credential, reads no database and calls only the application's own boundary with the caller's credential." },
  "errors.deliberate-mapping": { category: "error", description: "Application errors map to deliberate AppPort errors (not found, invalid input, internal)." },
  "errors.denial-distinguishable": { category: "error", description: "Authorization denials remain distinguishable from unrelated failures where the source interface distinguishes them." },
  "errors.failure-not-success": { category: "error", description: "An application failure, an unreachable application or an unexpected answer is an error, never a fabricated success." },
  "integration.discoverable": { category: "integration", description: "The capability is discoverable through the application's actual AppPort boundary." },
  "integration.real-operation": { category: "integration", description: "Invocation reaches the real source operation, confirmed independently of the adapter's answer." },
  "integration.source-revision": { category: "integration", description: "The application tested is the recorded source revision, unchanged by the test run." },
  "integration.fulfillment-claim": { category: "integration", description: "The boundary publishes a fulfillment claim for the contract that AppPort's evaluateFulfillment accepts." }
} as const satisfies Record<string, { category: "contract" | "authorization" | "error" | "integration"; description: string }>;

/**
 * The `/2` behaviors: the `/1` behaviors with the fulfillment claim stated precisely, and three more for the
 * declaration and the data a capability may return.
 */
export const BEHAVIORS = {
  ...BEHAVIORS_V1,
  "integration.fulfillment-claim": { category: "integration", description: "The boundary publishes the extraction's fulfillment declaration in its manifest, AppPort client discovery returns it, and AppPort's evaluateFulfillment finds the claim valid against the contract." },
  "integration.declaration-fails-closed": { category: "integration", description: "A missing, malformed, mismatched, stale or unpublished fulfillment declaration is refused with a reason code; nothing falls back to an undeclared or permissive capability." },
  "authorization.claim-not-authority": { category: "authorization", description: "A published fulfillment claim confers no authority: callers without a valid credential, or denied by the application, stay denied." },
  "contract.no-sensitive-data": { category: "contract", description: "Outputs carry only the contracted fields: no credential, secret or unrelated personal data, and no echo of the caller's credential." }
} as const satisfies Record<string, { category: "contract" | "authorization" | "error" | "integration"; description: string }>;
export type BehaviorId = keyof typeof BEHAVIORS;
export const REQUIRED_BEHAVIORS = Object.keys(BEHAVIORS).sort() as BehaviorId[];
export const REQUIRED_BEHAVIORS_V1 = Object.keys(BEHAVIORS_V1).sort() as BehaviorId[];
/** The behavior catalog of a format. */
export const behaviorsOf = (format: string): Record<string, { category: string; description: string }> => (format === EXTRACTION_FORMAT_V1 ? BEHAVIORS_V1 : BEHAVIORS);

export interface VerificationRecord {
  behavior: BehaviorId;
  category: (typeof BEHAVIORS)[BehaviorId]["category"];
  description: string;
  status: VerificationStatus;
  /** How it is verified: the kind of procedure and where it is (test file and name). Absent while `not-run` with no procedure. */
  procedure?: { kind: ProcedureKind; reference: string };
  /** `/2`: what the result was obtained against. */
  against?: VerificationTarget;
  /** What was verified. A result applies only while every member equals the artifact's own (`/2` adds the declaration and runtime digests). */
  subject: { sourceRevision: string; capabilityDigest: string; adapterDigest: string | null; declarationDigest?: string | null; runtimeDigest?: string };
  /** The individual results (test names, checks) that produced the status. Required unless `not-run`. */
  results: string[];
  limitations: string[];
}

export interface SchemaChangeExplanation {
  direction: "input" | "output";
  kind: string;
  target: string;
  reason: string;
}

export interface Mapping {
  /** Every AppPort compareSchemas difference between the assessment's proposal and the contract, each with its reason. */
  changes: SchemaChangeExplanation[];
  /** Decisions compareSchemas does not report (naming, closed objects, defaults), each with its reason. */
  decisions: Array<{ subject: string; decision: string; reason: string }>;
  /** Field-by-field correspondence between the contract and the source operation's messages. */
  fields: Array<{ direction: "input" | "output"; contract: string; source: string; rule: "identity" | "default-if-absent" }>;
}

export interface FileDigest {
  path: string;
  digest: string;
}

export interface AdapterIdentity {
  name: string;
  version: string;
  /** Adapter sources, relative to the extraction plan, with content digests. */
  files: FileDigest[];
  /** Exact published packages the adapter runs on. */
  packages: Record<string, string>;
  /** The application's existing AppPort boundary that hosts the adapter, at the source revision. */
  boundary: { name: string; description: string; files: FileDigest[]; invocation: { method: string; path: string } };
  /** digestOf of everything above. */
  digest: string;
}

/** The fulfillment declaration the adapter's host publishes: AppPort manifest extensions and attributes (`appport.fulfillment/1`). */
export interface FulfillmentDeclaration {
  /** The provider capability that makes the claim, in the application whose boundary publishes it. */
  provider: { application: string; capability: string; version: number };
  extensions: string[];
  attributes: Record<string, JsonValue>;
  /** digestOf of provider, extensions and attributes. */
  digest: string;
}

/** The runtime the verification ran on, as declared: exact packages, how the application was built and stored, the Node range. */
export interface RuntimeConfiguration {
  packages: Record<string, string>;
  application: Record<string, string>;
  node: string;
}

export interface CapabilityExtraction {
  format: ExtractionFormat;
  /** Volatile: excluded from the digest. */
  extraction: { id: string; createdAt: string; verificationRun?: { startedAt: string; finishedAt: string; runner: string } };
  tool: { name: string; version: string };
  /** A stable name and a revision that increases whenever source, contract or adapter change (§7). */
  identity: { name: string; revision: number; previous?: string };
  stage: "proposed" | "implemented";
  assessment: { format: string; digest: string; tool: { name: string; version: string }; scanner: string; candidate: { id: string; digest: string } };
  source: {
    name: string;
    repository?: string;
    revision: string;
    operation: { kind: "rpc"; service: string; method: string; fullMethod: string; http?: string };
    entryPoints: Array<{ kind: string; subject: string; evidence: string[] }>;
    implementation: { symbol: string; location: Location; evidence: string[] };
    tests: Array<{ symbol: string; path: string; evidence: string[] }>;
  };
  contract: {
    canonical: AppPortManifest;
    capability: { contract: string; name: string; version: number };
    contractDigest: string;
    capabilityDigest: string;
    /** The assessment's non-authoritative proposal the contract was derived from. */
    proposal: { name: string; inputSchema: JSONSchema; outputSchema: JSONSchema };
    mapping: Mapping;
  };
  adapter: AdapterIdentity | null;
  /** `/2` only. */
  fulfillment?: FulfillmentDeclaration | null;
  /** `/2` only. */
  runtime?: RuntimeConfiguration;
  dependencies: { packages: Record<string, string>; application: string[]; environment: string[] };
  authorization: { requirements: string[]; restrictions: string[]; evidence: string[] };
  sideEffects: { effect: "observation"; persistence: Array<{ operation: "read"; statement: string; evidence: string[] }>; evidence: string[] };
  verification: { required: BehaviorId[]; records: VerificationRecord[]; summary: Record<VerificationStatus, number> };
  evidence: Evidence[];
  findings: Array<{ code: string; message: string }>;
  limitations: Array<{ code: string; description: string }>;
  questions: Array<{ id: string; question: string }>;
  scope: { grantsAuthority: false; executable: false; establishesEquivalence: false; modifiesTarget: false; deploys: false };
  digest: string;
}

/** The content digest: `digestOf` (RFC 8785, sha256) without `digest` and the volatile `extraction` block. */
export function extractionDigest(artifact: Omit<CapabilityExtraction, "digest"> | CapabilityExtraction): string {
  const { digest: _digest, extraction: _volatile, ...content } = artifact as CapabilityExtraction;
  return digestOf(content);
}

/** The digest of a file's bytes, as text: `sha256:` and AppPort's sha256 of the UTF-8 content. */
export const fileDigest = (text: string) => `sha256:${sha256(text)}`;

export function declarationDigest(declaration: Omit<FulfillmentDeclaration, "digest">): string {
  const { digest: _d, ...content } = declaration as FulfillmentDeclaration;
  return digestOf(content);
}

export const runtimeDigest = (runtime: RuntimeConfiguration): string => digestOf(runtime);

/**
 * Problems with a fulfillment declaration for a contract: the codes `FULFILLMENT_MALFORMED`, `FULFILLMENT_MISSING` (no
 * claim for the provider capability), `FULFILLMENT_MISMATCH` (another contract, capability or version, or anything beyond
 * the one claim `claimFor` makes), `FULFILLMENT_STALE` (a digest other than the contract's current capability digest).
 */
export function fulfillmentProblems(declaration: unknown, canonical: AppPortManifest, capability: { name: string; version: number }): Array<{ code: string; message: string }> {
  const d = declaration as FulfillmentDeclaration;
  if (!isObject(d) || !isObject(d.provider) || typeof d.provider.capability !== "string" || !Number.isInteger(d.provider.version) || typeof d.provider.application !== "string" || !Array.isArray(d.extensions) || !isObject(d.attributes))
    return [{ code: "FULFILLMENT_MALFORMED", message: "a declaration has a provider, extensions and attributes" }];
  const manifest = { extensions: d.extensions, attributes: d.attributes } as Pick<AppPortManifest, "extensions" | "attributes">;
  if (!d.extensions.includes(FULFILLMENT_EXTENSION) || !getFulfillment(manifest)) return [{ code: "FULFILLMENT_MALFORMED", message: `the declaration does not advertise ${FULFILLMENT_EXTENSION} with a capabilities map` }];
  const claims = fulfillmentClaims(manifest, d.provider.capability, d.provider.version);
  if (!claims.length) return [{ code: "FULFILLMENT_MISSING", message: `no claim for ${d.provider.capability}@${d.provider.version}` }];
  let expected;
  try {
    expected = claimFor(canonical, capability.name, capability.version);
  } catch (error) {
    return [{ code: "FULFILLMENT_MISMATCH", message: (error as Error).message }];
  }
  const out: Array<{ code: string; message: string }> = [];
  for (const claim of claims) {
    if (claim?.contract !== expected.contract || claim.capability !== expected.capability || claim.version !== expected.version)
      out.push({ code: "FULFILLMENT_MISMATCH", message: `the claim names ${claim?.contract} ${claim?.capability}@${claim?.version}; the contract defines ${expected.contract} ${expected.capability}@${expected.version}` });
    else if (claim.digest !== expected.digest) out.push({ code: "FULFILLMENT_STALE", message: `the claim pins ${claim.digest}; the contract's capability is ${expected.digest}` });
  }
  if (!out.length && canonicalize(manifest) !== canonicalize(fulfillmentAttributes({ capabilities: { [`${d.provider.capability}@${d.provider.version}`]: [expected] } })))
    out.push({ code: "FULFILLMENT_MISMATCH", message: "the declaration contains more than the one claim the contract supports" });
  return out;
}

export function adapterDigest(adapter: Omit<AdapterIdentity, "digest">): string {
  const { digest: _d, ...content } = adapter as AdapterIdentity;
  return digestOf(content);
}

/** JSON Schema keywords AppPort's schema subset defines (`@appport/protocol` JSONSchema). Anything else is refused. */
const KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "type", "enum", "const", "properties", "required", "additionalProperties",
  "propertyNames", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "anyOf", "oneOf", "allOf", "not", "default", "examples", "deprecated"
]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

/** Problems with a schema: keywords or types outside AppPort's subset, unresolvable `$ref`, invalid patterns. */
export function schemaProblems(schema: unknown, at = ""): string[] {
  const problems: string[] = [];
  const root = schema;
  const visit = (s: unknown, path: string) => {
    if (typeof s === "boolean") return;
    if (s === null || typeof s !== "object" || Array.isArray(s)) return problems.push(`${path || "/"}: a schema is an object`);
    for (const [key, value] of Object.entries(s as Record<string, unknown>)) {
      const here = `${path}/${key}`;
      if (!KEYWORDS.has(key) && !key.startsWith("x-")) problems.push(`${here}: unsupported keyword`);
      else if (key === "type") {
        const types = Array.isArray(value) ? value : [value];
        if (!types.length || types.some((t) => !TYPES.has(t as string))) problems.push(`${here}: unsupported type ${JSON.stringify(value)}`);
      } else if (key === "pattern") {
        try {
          new RegExp(value as string, "u");
        } catch {
          problems.push(`${here}: invalid pattern`);
        }
      } else if (key === "$ref") {
        const ref = value as string;
        const defs = (root as Record<string, unknown>)?.$defs as Record<string, unknown> | undefined;
        if (typeof ref !== "string" || !ref.startsWith("#/$defs/") || !defs || !(ref.slice(8) in defs)) problems.push(`${here}: unresolvable reference ${JSON.stringify(ref)}`);
      } else if (key === "properties" || key === "$defs") {
        if (value === null || typeof value !== "object" || Array.isArray(value)) problems.push(`${here}: an object of schemas`);
        else for (const [name, sub] of Object.entries(value)) visit(sub, `${here}/${name}`);
      } else if (["items", "additionalProperties", "propertyNames", "not"].includes(key)) visit(value, here);
      else if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(value)) problems.push(`${here}: a list of schemas`);
        else value.forEach((sub, k) => visit(sub, `${here}/${k}`));
      } else if (key === "required" && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) problems.push(`${here}: a list of names`);
    }
  };
  visit(schema, at);
  if (!problems.length) {
    try {
      fromJSONSchema(schema as JSONSchema);
    } catch (error) {
      problems.push(`${at || "/"}: ${(error as Error).message}`);
    }
  }
  return problems;
}

/** A schema with local `$ref`s replaced by their definitions, for comparison. Refuses recursive definitions. */
export function inlineSchema(schema: JSONSchema): JSONSchema {
  const defs = schema.$defs ?? {};
  const walk = (s: unknown, stack: string[]): unknown => {
    if (Array.isArray(s)) return s.map((x) => walk(x, stack));
    if (s === null || typeof s !== "object") return s;
    const o = s as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      const key = o.$ref.replace(/^#\/\$defs\//, "");
      if (stack.includes(key)) throw new Error(`recursive schema definition ${key} cannot be inlined`);
      if (!(key in defs)) throw new Error(`unresolvable reference ${o.$ref}`);
      return walk(defs[key], [...stack, key]);
    }
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "$defs" && k !== "$schema").map(([k, v]) => [k, walk(v, stack)]));
  };
  return walk(schema, []) as JSONSchema;
}

/** The compareSchemas differences between the assessment's proposal and the contract's capability. */
export function contractChanges(proposal: { inputSchema: JSONSchema; outputSchema: JSONSchema }, contract: { inputSchema: JSONSchema; outputSchema: JSONSchema }): Array<ManifestChange & { direction: "input" | "output" }> {
  const strip = (target: string) => target.replace(/^(input|output)\.?/, "");
  return [
    ...compareSchemas(inlineSchema(proposal.inputSchema), contract.inputSchema, "input", "input").map((c) => ({ ...c, direction: "input" as const, target: strip(c.target) })),
    ...compareSchemas(inlineSchema(proposal.outputSchema), contract.outputSchema, "output", "output").map((c) => ({ ...c, direction: "output" as const, target: strip(c.target) }))
  ];
}

/** Problems with a proposed canonical contract for a read-only extraction. */
export function contractProblems(canonical: unknown, capability: { name: string; version: number }): string[] {
  const problems: string[] = [];
  const m = canonical as AppPortManifest;
  if (m === null || typeof m !== "object" || typeof m.application?.id !== "string" || !Array.isArray(m.capabilities)) return ["the contract is not an AppPort manifest"];
  if (!isCanonicalContract(m)) problems.push("the contract does not advertise appport.canonical-contract/1");
  if (m.transports?.length) problems.push("a canonical contract advertises no transports");
  if (!isValidName(capability.name)) problems.push(`${capability.name} is not a valid AppPort capability name`);
  const entry = findCapabilityVersion(m, capability.name, capability.version);
  if (!entry) return [...problems, `the contract does not define ${capability.name}@${capability.version}`];
  if (entry.effect !== "observation") problems.push(`${capability.name}@${capability.version} is not classified "observation"; this version extracts read-only operations only`);
  if (entry.kind !== "request") problems.push(`${capability.name}@${capability.version} is a ${entry.kind} capability; this version extracts request/response operations only`);
  problems.push(...schemaProblems(entry.inputSchema, "inputSchema"), ...schemaProblems(entry.outputSchema, "outputSchema"));
  for (const issue of lintIntegration(m)) if (issue.level === "error") problems.push(`${issue.path}: ${issue.message}`);
  return problems;
}

export interface VerificationFinding {
  code: string;
  path: string;
  message: string;
}

const TOP_LEVEL_V1 = ["format", "extraction", "tool", "identity", "stage", "assessment", "source", "contract", "adapter", "dependencies", "authorization", "sideEffects", "verification", "evidence", "findings", "limitations", "questions", "scope", "digest"];
const TOP_LEVEL_V2 = [...TOP_LEVEL_V1.slice(0, 9), "fulfillment", "runtime", ...TOP_LEVEL_V1.slice(9)];
const RECORD_MEMBERS_V1 = ["behavior", "category", "description", "status", "procedure", "subject", "results", "limitations"];
const RECORD_MEMBERS_V2 = [...RECORD_MEMBERS_V1, "against"];
const SCOPE = { grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every member named like an authority grant or a blanket verification claim, anywhere in the artifact. */
function forbiddenMembers(value: unknown, pointer: string, out: string[]) {
  if (Array.isArray(value)) value.forEach((v, k) => forbiddenMembers(v, `${pointer}/${k}`, out));
  else if (isObject(value))
    for (const [key, v] of Object.entries(value)) {
      if (["grant", "grants", "authorizationGrant", "verified", "equivalent"].includes(key)) out.push(`${pointer}/${key}`);
      // The canonical contract is AppPort's own document and is checked by contractProblems.
      if (!(pointer === "/contract" && key === "canonical")) forbiddenMembers(v, `${pointer}/${key}`, out);
    }
}

function evidenceReferences(value: unknown, pointer: string, out: Array<{ id: unknown; pointer: string }>) {
  if (Array.isArray(value)) value.forEach((v, k) => evidenceReferences(v, `${pointer}/${k}`, out));
  else if (isObject(value))
    for (const [key, v] of Object.entries(value)) {
      if (key === "evidence" && Array.isArray(v)) v.forEach((id, k) => out.push({ id, pointer: `${pointer}/evidence/${k}` }));
      else if (!(pointer === "/contract" && key === "canonical")) evidenceReferences(v, `${pointer}/${key}`, out);
    }
}

export interface VerifyExtractionOptions {
  /** The assessment artifact the extraction claims to come from. */
  assessment?: unknown;
  /** The adapter sources, read by the caller (path → text, relative to the extraction plan). */
  adapterFiles?: Record<string, string>;
  /** The boundary files at the source revision, read by the caller (repository path → text). */
  boundaryFiles?: Record<string, string>;
  /** The repository revision the caller observes. */
  repositoryRevision?: string;
}

/**
 * Verifies an extraction's integrity and honesty. It reads no file and runs nothing: callers pass what they read
 * (`verifyExtractionAt` in `files.ts` does this for a checkout).
 */
export function verifyExtraction(value: unknown, options: VerifyExtractionOptions = {}): { ok: boolean; findings: VerificationFinding[] } {
  const findings: VerificationFinding[] = [];
  const add = (code: string, path: string, message: string) => findings.push({ code, path, message });
  if (!isObject(value)) return { ok: false, findings: [{ code: "EXTRACTION_MALFORMED", path: "", message: "an extraction is a JSON object" }] };
  if (!EXTRACTION_FORMATS.includes(value.format as ExtractionFormat)) {
    add("EXTRACTION_FORMAT", "/format", `unsupported format ${JSON.stringify(value.format)}; this reader implements ${EXTRACTION_FORMATS.join(" and ")}`);
    return { ok: false, findings };
  }
  const v1 = value.format === EXTRACTION_FORMAT_V1;
  const TOP_LEVEL = v1 ? TOP_LEVEL_V1 : TOP_LEVEL_V2;
  const RECORD_MEMBERS = v1 ? RECORD_MEMBERS_V1 : RECORD_MEMBERS_V2;
  const catalog = behaviorsOf(value.format as string);
  const required = Object.keys(catalog).sort();
  for (const key of Object.keys(value)) if (!TOP_LEVEL.includes(key)) add("EXTRACTION_MEMBER", `/${key}`, `undocumented member "${key}"`);
  for (const key of TOP_LEVEL) if (!(key in value)) add("EXTRACTION_MEMBER", `/${key}`, `missing member "${key}"`);
  if (findings.length) return { ok: false, findings };
  const x = value as unknown as CapabilityExtraction;

  // Claims an extraction never makes.
  const forbidden: string[] = [];
  forbiddenMembers(value, "", forbidden);
  for (const pointer of forbidden) add("FORBIDDEN_CLAIM", pointer, "an extraction carries no grants and no blanket verification or equivalence claim");
  if (!isObject(x.scope) || canonicalize(x.scope) !== canonicalize(SCOPE)) add("SCOPE_CLAIM", "/scope", "an extraction grants no authority, is not executable, establishes no equivalence, modifies no target and deploys nothing");

  // Identity.
  if (!isObject(x.identity) || !isValidName(x.identity.name) || !Number.isInteger(x.identity.revision) || x.identity.revision < 1) add("IDENTITY", "/identity", "identity is a capability name and a revision ≥ 1");
  else if (x.identity.revision > 1 && !isDigest(x.identity.previous)) add("IDENTITY", "/identity/previous", "a revision after the first names the digest of the previous one");
  if (!["proposed", "implemented"].includes(x.stage)) add("STAGE", "/stage", 'stage is "proposed" or "implemented"');
  if (x.stage === "implemented" && !x.adapter) add("STAGE", "/adapter", "an implemented extraction names its adapter");
  if (x.stage === "proposed" && x.adapter) add("STAGE", "/stage", "an extraction with an adapter is implemented");

  // Source revision: immutable, full hash.
  if (!isObject(x.source) || typeof x.source.revision !== "string" || !/^[0-9a-f]{40,64}$/.test(x.source.revision)) add("SOURCE_REVISION", "/source/revision", "the source revision is a full commit hash");

  // Evidence copied from the assessment.
  const byId = new Map<string, Evidence>();
  if (!Array.isArray(x.evidence)) add("EVIDENCE_MALFORMED", "/evidence", "evidence is a list");
  else
    for (const [k, e] of x.evidence.entries()) {
      if (!isObject(e) || typeof e.id !== "string") {
        add("EVIDENCE_MALFORMED", `/evidence/${k}`, "an evidence record has an id");
        continue;
      }
      if (byId.has(e.id)) add("EVIDENCE_DUPLICATE", `/evidence/${k}`, `duplicate evidence ${e.id}`);
      byId.set(e.id, e);
      const { id: _id, ...content } = e;
      if (`ev-${sha256(canonicalize(content)).slice(0, 16)}` !== e.id) add("EVIDENCE_ID", `/evidence/${k}/id`, `${e.id} is not the content id of this record`);
    }
  const references: Array<{ id: unknown; pointer: string }> = [];
  for (const key of TOP_LEVEL.filter((k) => k !== "evidence")) evidenceReferences(value[key], `/${key}`, references);
  for (const e of byId.values()) for (const b of e.basis ?? []) references.push({ id: b, pointer: `/evidence/${e.id}/basis` });
  for (const { id, pointer } of references) if (typeof id !== "string" || !byId.has(id)) add("EVIDENCE_REFERENCE", pointer, `unknown evidence ${JSON.stringify(id)}`);

  // Contract.
  const contract = x.contract;
  if (!isObject(contract) || !isObject(contract.capability)) add("CONTRACT_MALFORMED", "/contract", "the contract section names its canonical contract and capability");
  else {
    const problems = contractProblems(contract.canonical, contract.capability);
    for (const p of problems) add("CONTRACT_INVALID", "/contract/canonical", p);
    if (!problems.length) {
      const m = contract.canonical;
      if (contract.capability.contract !== m.application.id) add("CONTRACT_IDENTITY", "/contract/capability/contract", "the capability names the contract it is defined in");
      if (contract.capability.name !== x.identity?.name) add("CONTRACT_IDENTITY", "/contract/capability/name", "the extraction is named after its capability");
      if (contract.contractDigest !== contractDigest(m)) add("CONTRACT_DIGEST", "/contract/contractDigest", "the contract digest does not match the contract");
      if (contract.capabilityDigest !== capabilityDigest(m, contract.capability.name, contract.capability.version)) add("CONTRACT_DIGEST", "/contract/capabilityDigest", "the capability digest does not match the contract");
      // The mapping explains exactly the differences between the proposal and the contract.
      const entry = findCapabilityVersion(m, contract.capability.name, contract.capability.version)!;
      try {
        const actual = contractChanges(contract.proposal, entry);
        const key = (c: { direction: string; kind: string; target: string }) => `${c.direction}|${c.kind}|${c.target}`;
        const explained = new Set((contract.mapping?.changes ?? []).map(key));
        const present = new Set(actual.map(key));
        for (const c of actual) if (!explained.has(key(c))) add("MAPPING_UNEXPLAINED", "/contract/mapping/changes", `${c.direction} ${c.target}: ${c.kind} (${c.severity}) differs from the assessment's proposal without a stated reason`);
        for (const c of contract.mapping?.changes ?? []) {
          if (!present.has(key(c))) add("MAPPING_STALE", "/contract/mapping/changes", `${c.direction} ${c.target}: ${c.kind} is explained but is not a difference`);
          if (typeof c.reason !== "string" || !c.reason.trim()) add("MAPPING_UNEXPLAINED", "/contract/mapping/changes", `${c.direction} ${c.target}: ${c.kind} has no reason`);
        }
      } catch (error) {
        add("CONTRACT_PROPOSAL", "/contract/proposal", (error as Error).message);
      }
    }
  }

  // Adapter.
  if (x.adapter) {
    const a = x.adapter;
    if (!isObject(a) || typeof a.name !== "string" || typeof a.version !== "string" || !Array.isArray(a.files) || !a.files.length || !isObject(a.boundary)) add("ADAPTER_MALFORMED", "/adapter", "an adapter has a name, version, files and a boundary");
    else {
      if (adapterDigest(a) !== a.digest) add("ADAPTER_DIGEST", "/adapter/digest", "the adapter digest does not match its identity");
      if (options.adapterFiles)
        for (const f of a.files) {
          const text = options.adapterFiles[f.path];
          if (text === undefined) add("ADAPTER_MISMATCH", `/adapter/files/${f.path}`, `${f.path} is missing`);
          else if (fileDigest(text) !== f.digest) add("ADAPTER_MISMATCH", `/adapter/files/${f.path}`, `${f.path} is not the adapter this extraction records`);
        }
      if (options.boundaryFiles)
        for (const f of a.boundary.files) {
          const text = options.boundaryFiles[f.path];
          if (text === undefined) add("BOUNDARY_MISMATCH", `/adapter/boundary/files/${f.path}`, `${f.path} is missing from the repository`);
          else if (fileDigest(text) !== f.digest) add("BOUNDARY_MISMATCH", `/adapter/boundary/files/${f.path}`, `${f.path} differs from the source revision's`);
        }
    }
  }

  // Fulfillment declaration and runtime (/2).
  if (!v1) {
    const f = x.fulfillment;
    if (f !== null) {
      if (x.stage !== "implemented") add("FULFILLMENT_STAGE", "/fulfillment", "only an implemented extraction declares fulfillment");
      if (isObject(x.contract) && isObject(x.contract.capability))
        for (const p of fulfillmentProblems(f, x.contract.canonical, x.contract.capability)) add(p.code, "/fulfillment", p.message);
      if (isObject(f) && f.digest !== declarationDigest(f)) add("FULFILLMENT_DIGEST", "/fulfillment/digest", "the declaration digest does not match the declaration");
    }
    const r = x.runtime;
    if (!isObject(r) || !isObject(r.packages) || !isObject(r.application) || typeof r.node !== "string") add("RUNTIME_MALFORMED", "/runtime", "the runtime names packages, the application build and a Node range");
  }

  // Verification.
  const v = x.verification;
  const expectedSubject = v1
    ? { sourceRevision: x.source?.revision, capabilityDigest: x.contract?.capabilityDigest, adapterDigest: x.adapter?.digest ?? null }
    : { sourceRevision: x.source?.revision, capabilityDigest: x.contract?.capabilityDigest, adapterDigest: x.adapter?.digest ?? null, declarationDigest: x.fulfillment?.digest ?? null, runtimeDigest: isObject(x.runtime) ? runtimeDigest(x.runtime) : null };
  if (!isObject(v) || !Array.isArray(v.records)) add("VERIFICATION_MALFORMED", "/verification", "verification has records");
  else {
    if (canonicalize(v.required) !== canonicalize(required)) add("VERIFICATION_REQUIRED", "/verification/required", `the required behaviors are ${required.join(", ")}`);
    const seen = new Set<string>();
    v.records.forEach((r, k) => {
      const at = `/verification/records/${k}`;
      if (!isObject(r)) return add("VERIFICATION_MALFORMED", at, "a record is an object");
      for (const key of Object.keys(r)) if (!RECORD_MEMBERS.includes(key)) add("VERIFICATION_MEMBER", `${at}/${key}`, `undocumented member "${key}"`);
      const behavior = catalog[r.behavior as string];
      if (!behavior) return add("VERIFICATION_BEHAVIOR", `${at}/behavior`, `unknown behavior ${JSON.stringify(r.behavior)}`);
      if (seen.has(r.behavior)) add("VERIFICATION_DUPLICATE", `${at}/behavior`, `${r.behavior} is recorded twice`);
      seen.add(r.behavior);
      if (r.category !== behavior.category || r.description !== behavior.description) add("VERIFICATION_BEHAVIOR", at, `${r.behavior} is not described as defined`);
      if (!VERIFICATION_STATUSES.includes(r.status)) add("VERIFICATION_STATUS", `${at}/status`, `status is one of ${VERIFICATION_STATUSES.join(", ")}`);
      if (r.status !== "not-run") {
        if (!isObject(r.procedure) || !PROCEDURE_KINDS.includes(r.procedure.kind) || typeof r.procedure.reference !== "string" || !r.procedure.reference) add("VERIFICATION_EVIDENCE", `${at}/procedure`, "a result names the procedure that produced it");
        if (!Array.isArray(r.results) || !r.results.length) add("VERIFICATION_EVIDENCE", `${at}/results`, "a result lists the checks that produced it");
        if (canonicalize(r.subject) !== canonicalize(expectedSubject)) add("VERIFICATION_STALE", `${at}/subject`, "this result was produced for another source revision, contract, adapter, declaration or runtime, and is not evidence for this one");
        if (!v1 && !VERIFICATION_TARGETS.includes(r.against as VerificationTarget)) add("VERIFICATION_TARGET", `${at}/against`, `a result says what it was obtained against: ${VERIFICATION_TARGETS.join(", ")}`);
      }
      if (!v1 && r.status === "not-run" && r.against !== "none") add("VERIFICATION_TARGET", `${at}/against`, "a result that was not run was obtained against nothing");
      if (r.status === "passed" && x.stage !== "implemented") add("VERIFICATION_STAGE", `${at}/status`, "nothing is verified before an adapter exists");
    });
    for (const id of required) if (!seen.has(id)) add("VERIFICATION_MISSING", "/verification/records", `${id} has no record`);
    const summary = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, v.records.filter((r) => isObject(r) && r.status === s).length]));
    if (canonicalize(v.summary) !== canonicalize(summary)) add("VERIFICATION_SUMMARY", "/verification/summary", "the summary does not count the records");
  }

  // Against the assessment it names.
  if (options.assessment !== undefined) {
    const a = options.assessment as Record<string, unknown> & { digest?: unknown; candidates?: unknown[]; evidence?: Evidence[]; target?: Record<string, unknown> };
    if (!isObject(a) || a.digest !== x.assessment?.digest) add("ASSESSMENT_MISMATCH", "/assessment/digest", "the extraction was made from another assessment");
    else {
      const candidate = (a.candidates ?? []).find((c) => isObject(c) && c.id === x.assessment.candidate?.id);
      if (!candidate) add("CANDIDATE_MISMATCH", "/assessment/candidate/id", "the candidate is not in this assessment");
      else if (digestOf(candidate) !== x.assessment.candidate.digest) add("CANDIDATE_MISMATCH", "/assessment/candidate/digest", "the candidate differs from the one the extraction recorded");
      if (a.target?.revision !== x.source?.revision) add("SOURCE_REVISION", "/source/revision", "the assessment was taken at another revision");
      const records = new Map((a.evidence ?? []).map((e) => [e.id, e]));
      for (const e of byId.values()) if (!records.has(e.id)) add("EVIDENCE_FOREIGN", `/evidence/${e.id}`, `${e.id} is not evidence of this assessment`);
    }
  }
  if (options.repositoryRevision !== undefined && options.repositoryRevision !== x.source?.revision) add("SOURCE_REVISION", "/source/revision", `the repository is at ${options.repositoryRevision || "an unknown revision"}, the extraction at ${x.source?.revision}`);

  if (!isDigest(x.digest)) add("DIGEST_FORMAT", "/digest", "digest is sha256:<64 hex>");
  else if (extractionDigest(x) !== x.digest) add("DIGEST_MISMATCH", "/digest", "the content does not match its digest");
  return { ok: findings.length === 0, findings };
}
