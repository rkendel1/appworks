/**
 * Creating an extraction from a verified assessment (spec/extraction-1.md §4–§6). Everything here is a pure function of
 * its inputs: callers read files and the repository identity (`files.ts`); nothing is executed, fetched or written.
 */
import { randomUUID } from "node:crypto";
import { compareManifests, contractDigest, capabilityDigest, digestOf, findCapabilityVersion, type AppPortManifest, type JSONSchema } from "@appport/protocol";
import { verifyAssessment, type ApplicationAssessment, type Candidate, type Evidence } from "@appport/assessment";
import {
  BEHAVIORS,
  EXTRACTION_FORMAT,
  EXTRACTION_PLAN_FORMAT,
  EXTRACTION_PLAN_FORMAT_V1,
  REQUIRED_BEHAVIORS,
  VERIFICATION_TARGETS,
  TOOL_NAME,
  TOOL_VERSION,
  VERIFICATION_RESULTS_FORMAT,
  VERIFICATION_STATUSES,
  adapterDigest,
  contractChanges,
  declarationDigest,
  fulfillmentProblems,
  runtimeDigest,
  contractProblems,
  extractionDigest,
  fileDigest,
  inlineSchema,
  type AdapterIdentity,
  type BehaviorId,
  type CapabilityExtraction,
  type FulfillmentDeclaration,
  type Mapping,
  type RuntimeConfiguration,
  type VerificationTarget,
  type ProcedureKind,
  type VerificationRecord,
  type VerificationStatus
} from "./artifact.js";

/** Why an extraction was refused. Every refusal carries at least one reason. */
export interface Refusal {
  code: string;
  message: string;
}

export class ExtractionRefused extends Error {
  constructor(readonly reasons: Refusal[]) {
    super(reasons.map((r) => `${r.code}: ${r.message}`).join("; "));
    this.name = "ExtractionRefused";
  }
}

/**
 * The minimum a candidate needs before this version extracts it: a verified link to a handler, resolved schemas,
 * observed authorization and validation, related tests, a complete call graph, no blocking concern, and nothing but
 * reads. The assessment's own readiness class must be `exposure-candidate`.
 */
export function candidateRefusals(candidate: Candidate | undefined, id: string): Refusal[] {
  if (!candidate) return [{ code: "CANDIDATE_NOT_FOUND", message: `${id} is not a candidate of this assessment` }];
  const out: Refusal[] = [];
  const unmet = (criterion: string) => candidate.readiness.criteria.find((c) => c.criterion === criterion && !c.satisfied);
  if (candidate.readiness.class !== "exposure-candidate") out.push({ code: "CANDIDATE_NOT_READY", message: `the assessment classifies ${id} as ${candidate.readiness.class}` });
  for (const [criterion, code] of [
    ["implementation", "CANDIDATE_LINK_WEAK"],
    ["io-schema", "CANDIDATE_SCHEMA_UNRESOLVED"],
    ["authorization", "CANDIDATE_NO_AUTHORIZATION_EVIDENCE"],
    ["validation", "CANDIDATE_NO_VALIDATION_EVIDENCE"],
    ["tests", "CANDIDATE_NO_TESTS"],
    ["reachability-complete", "CANDIDATE_REACHABILITY_INCOMPLETE"]
  ] as const)
    if (unmet(criterion)) out.push({ code, message: `${criterion}: ${unmet(criterion)!.reason}` });
  if (candidate.exposure.effectBasis.effect !== "observation" || candidate.sideEffects.persistence.some((p) => p.operation !== "read")) out.push({ code: "CANDIDATE_NOT_READ_ONLY", message: "this version extracts read-only operations only" });
  if (candidate.sideEffects.outboundHttp.length || candidate.sideEffects.async.length) out.push({ code: "CANDIDATE_BLOCKING_CONCERN", message: "outbound HTTP or asynchronous work is reachable" });
  if (candidate.operation.kind !== "rpc") out.push({ code: "CANDIDATE_NOT_RPC", message: `${id} is an ${candidate.operation.kind} operation: this version extracts Protocol Buffers RPCs, and has no way to derive a contract, an adapter or a behavioral suite for an HTTP route` });
  else if (candidate.operation.streaming) out.push({ code: "CANDIDATE_STREAMING", message: "streaming operations are not extracted by this version" });
  if (!candidate.exposure.capability) out.push({ code: "CANDIDATE_NO_PROPOSAL", message: "the assessment proposes no capability shape for it" });
  return out;
}

/** Assessment checks: integrity (digest, references, evidence classes), an immutable revision, and the checkout's. */
export function assessmentRefusals(assessment: unknown, checkout: { revision?: string; locationsVerified?: { ok: boolean; codes: string[] } }): Refusal[] {
  const out: Refusal[] = [];
  const result = verifyAssessment(assessment);
  for (const code of [...new Set(result.findings.map((f) => f.code))]) out.push({ code: "ASSESSMENT_INVALID", message: `${code}: ${result.findings.filter((f) => f.code === code).length} finding(s)` });
  if (!result.ok) return out;
  const a = assessment as ApplicationAssessment;
  if (!a.target.revision) out.push({ code: "ASSESSMENT_REVISION_MISSING", message: "the assessment is not tied to a source revision" });
  else if (checkout.revision !== a.target.revision) out.push({ code: "REPOSITORY_REVISION_MISMATCH", message: `the repository is at ${checkout.revision ?? "an unknown revision"}, the assessment at ${a.target.revision}` });
  if (checkout.locationsVerified && !checkout.locationsVerified.ok) out.push({ code: "ASSESSMENT_LOCATIONS_INVALID", message: `the assessment's evidence does not match the repository: ${checkout.locationsVerified.codes.join(", ")}` });
  return out;
}

/** The extraction plan: a reviewable, hand-written input (spec/extraction-1.md §5). */
export interface ExtractionPlan {
  format: typeof EXTRACTION_PLAN_FORMAT | typeof EXTRACTION_PLAN_FORMAT_V1;
  candidate: string;
  identity: { name: string; revision: number; previous?: string };
  contract: string;
  mapping: Mapping;
  adapter: {
    name: string;
    version: string;
    files: string[];
    packages: Record<string, string>;
    boundary: { name: string; description: string; files: string[]; invocation: { method: string; path: string } };
  };
  authorization: { requirements: string[]; restrictions: string[] };
  environment: string[];
  limitations: Array<{ code: string; description: string }>;
  questions: Array<{ id: string; question: string }>;
  /** Plan `/2`: the declaration file (relative to the plan, one of the adapter files) and the provider capability making the claim. */
  fulfillment?: { provider: FulfillmentDeclaration["provider"]; declaration: string };
  /** Plan `/2`: the runtime the verification runs on. */
  runtime?: RuntimeConfiguration;
}

/** Verification results produced by a test run for one subject (spec/extraction-1.md §6). */
export interface VerificationResults {
  format: typeof VERIFICATION_RESULTS_FORMAT;
  subject: VerificationRecord["subject"];
  run: { startedAt: string; finishedAt: string; runner: string };
  behaviors: Partial<Record<BehaviorId, { status: Exclude<VerificationStatus, "not-run">; against: VerificationTarget; procedure: { kind: ProcedureKind; reference: string }; results: string[]; limitations?: string[] } | { status: "not-run"; limitations: string[] }>>;
}

export interface ExtractInput {
  assessment: ApplicationAssessment;
  candidate: string;
  /** What the caller observed of the checkout: its revision and the assessment's location check against it. */
  checkout: { revision?: string; locationsVerified?: { ok: boolean; codes: string[] } };
  /** Without a plan: a proposed extraction (the assessment's proposal as the contract, no adapter, nothing run). */
  plan?: { plan: ExtractionPlan; contract: unknown; adapterFiles: Record<string, string>; boundaryFiles: Record<string, string>; declaration?: unknown };
  verification?: VerificationResults;
  /** The previous revision of this extraction, when making a new one. */
  previous?: CapabilityExtraction;
  now?: () => Date;
  id?: () => string;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o ?? {}).sort(([x], [y]) => order(x, y)));
const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort(order);

/** The evidence records a candidate cites, with everything they are based on, copied verbatim. */
function citedEvidence(assessment: ApplicationAssessment, ids: Iterable<string>): Evidence[] {
  const byId = new Map(assessment.evidence.map((e) => [e.id, e]));
  const out = new Map<string, Evidence>();
  const add = (id: string) => {
    const e = byId.get(id);
    if (!e || out.has(id)) return;
    out.set(id, e);
    for (const b of e.basis ?? []) add(b);
  };
  for (const id of ids) add(id);
  return [...out.values()].sort((a, b) => order(a.id, b.id));
}

/** A canonical contract built from the assessment's proposal, for a proposed extraction. */
export function proposedContract(assessment: ApplicationAssessment, candidate: Candidate): AppPortManifest {
  const p = candidate.exposure.capability!;
  const version = {
    version: p.version,
    description: candidate.description,
    kind: p.kind,
    inputSchema: inlineSchema(p.inputSchema),
    outputSchema: inlineSchema(p.outputSchema),
    authorization: [],
    effect: p.effect
  };
  return {
    protocol: "appport/1",
    application: { id: `org.appworks.contracts.${assessment.target.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`, name: `${assessment.target.name} capabilities (proposed)`, version: "0.0.0", description: `Proposed from ${assessment.digest}; not adopted.` },
    extensions: ["appport.canonical-contract/1"],
    capabilities: [{ name: p.name, versions: [p.version], latestVersion: p.version, description: version.description, kind: version.kind, inputSchema: version.inputSchema, outputSchema: version.outputSchema, authorization: [], effect: p.effect, definitions: [version] }],
    events: [],
    transports: []
  } as AppPortManifest;
}

const LIMITATIONS = [
  { code: "not-source-extraction", description: "No application source is rewritten, generated or moved. The adapter exposes the existing operation through the application's existing AppPort boundary." },
  { code: "behaviors-not-equivalence", description: "Only the behaviors whose records say passed are verified, for this source revision, contract and adapter, in the states the tests created. Nothing establishes equivalence beyond them." },
  { code: "no-authority", description: "An extraction grants nothing. Invoking the capability requires the caller's own application credential and AppPort authorization at the boundary." },
  { code: "no-deployment", description: "Generating or verifying an extraction registers, publishes or deploys nothing." }
];

/** The adapter's identity from its plan entry and the files read for it. */
export function adapterIdentity(planned: ExtractionPlan["adapter"], adapterFiles: Record<string, string>, boundaryFiles: Record<string, string>): { adapter: AdapterIdentity; missing: Refusal[] } {
  const missing: Refusal[] = [];
  const files = (paths: string[], texts: Record<string, string>, code: string) =>
    [...paths].sort(order).map((path) => {
      if (texts[path] === undefined) missing.push({ code, message: `${path} could not be read` });
      return { path, digest: fileDigest(texts[path] ?? "") };
    });
  const identity = {
    name: planned.name,
    version: planned.version,
    files: files(planned.files, adapterFiles, "ADAPTER_FILE_MISSING"),
    packages: Object.fromEntries(Object.entries(planned.packages).sort(([x], [y]) => order(x, y))),
    boundary: { ...planned.boundary, files: files(planned.boundary.files, boundaryFiles, "BOUNDARY_FILE_MISSING") }
  };
  return { adapter: { ...identity, digest: adapterDigest(identity) }, missing };
}

/** Creates an extraction, or throws `ExtractionRefused` with every reason it cannot. */
export function createExtraction(input: ExtractInput): CapabilityExtraction {
  const refusals = assessmentRefusals(input.assessment, input.checkout);
  if (refusals.length) throw new ExtractionRefused(refusals);
  const a = input.assessment;
  const candidate = a.candidates.find((c) => c.id === input.candidate);
  const candidateProblems = candidateRefusals(candidate, input.candidate);
  if (candidateProblems.length) throw new ExtractionRefused(candidateProblems);
  const c = candidate!;
  if (c.operation.kind !== "rpc") throw new ExtractionRefused([{ code: "CANDIDATE_NOT_RPC", message: `${c.id} is not a Protocol Buffers RPC` }]); // refused above; narrows the type
  const proposal = c.exposure.capability!;

  // Contract and adapter.
  const plan = input.plan;
  const reasons: Refusal[] = [];
  let canonical: AppPortManifest;
  let name: string;
  let version: number;
  let mapping: Mapping;
  let adapter: AdapterIdentity | null = null;
  let fulfillment: FulfillmentDeclaration | null = null;
  let runtime: RuntimeConfiguration = { packages: {}, application: {}, node: "" };
  if (plan) {
    if (plan.plan.format !== EXTRACTION_PLAN_FORMAT && plan.plan.format !== EXTRACTION_PLAN_FORMAT_V1) reasons.push({ code: "PLAN_FORMAT", message: `a plan is ${EXTRACTION_PLAN_FORMAT} (or ${EXTRACTION_PLAN_FORMAT_V1}, without a declaration)` });
    if (plan.plan.candidate !== c.id) reasons.push({ code: "PLAN_CANDIDATE", message: `the plan is for ${plan.plan.candidate}, not ${c.id}` });
    name = plan.plan.identity.name;
    version = 1;
    canonical = plan.contract as AppPortManifest;
    const entry = Array.isArray(canonical?.capabilities) ? canonical.capabilities.find((x) => x.name === name) : undefined;
    version = entry?.latestVersion ?? 1;
    for (const p of contractProblems(canonical, { name, version })) reasons.push({ code: "CONTRACT_INVALID", message: p });
    mapping = plan.plan.mapping;
    const made = adapterIdentity(plan.plan.adapter, plan.adapterFiles, plan.boundaryFiles);
    reasons.push(...made.missing);
    adapter = made.adapter;
    if (plan.plan.format === EXTRACTION_PLAN_FORMAT) {
      if (!plan.plan.runtime) reasons.push({ code: "PLAN_RUNTIME", message: "a /2 plan states the runtime the verification runs on" });
      else runtime = { packages: sortKeys(plan.plan.runtime.packages), application: sortKeys(plan.plan.runtime.application), node: plan.plan.runtime.node };
      if (plan.plan.fulfillment) {
        if (!plan.plan.adapter.files.includes(plan.plan.fulfillment.declaration)) reasons.push({ code: "FULFILLMENT_NOT_ADAPTER_FILE", message: `${plan.plan.fulfillment.declaration} must be one of the adapter's files, so the adapter digest covers what the host publishes` });
        const d = plan.declaration as { extensions?: string[]; attributes?: Record<string, never> } | undefined;
        if (d === undefined) reasons.push({ code: "FULFILLMENT_MISSING", message: `${plan.plan.fulfillment.declaration} cannot be read` });
        else {
          const content = { provider: plan.plan.fulfillment.provider, extensions: d?.extensions as string[], attributes: d?.attributes as Record<string, never> };
          fulfillment = { ...content, digest: declarationDigest(content) };
        }
      }
    }
  } else {
    canonical = proposedContract(a, c);
    name = proposal.name;
    version = proposal.version;
    mapping = { changes: [], decisions: [], fields: [] };
  }
  if (reasons.length) throw new ExtractionRefused(reasons);
  const entry = findCapabilityVersion(canonical, name, version)!;
  const changes = contractChanges(proposal, entry);
  const key = (x: { direction: string; kind: string; target: string }) => `${x.direction}|${x.kind}|${x.target}`;
  const explained = new Set(mapping.changes.map(key));
  for (const ch of changes) if (!explained.has(key(ch))) reasons.push({ code: "MAPPING_UNEXPLAINED", message: `${ch.direction} ${ch.target}: ${ch.kind} (${ch.severity}) is not explained in the plan's mapping` });
  const present = new Set(changes.map(key));
  for (const ch of mapping.changes) if (!present.has(key(ch))) reasons.push({ code: "MAPPING_STALE", message: `${ch.direction} ${ch.target}: ${ch.kind} is explained but is not a difference` });
  if (fulfillment) for (const p of fulfillmentProblems(fulfillment, canonical, { name, version })) reasons.push(p);
  if (reasons.length) throw new ExtractionRefused(reasons);
  const capDigest = capabilityDigest(canonical, name, version)!;

  // Verification: results apply only to the subject they were produced for.
  const subject = { sourceRevision: a.target.revision!, capabilityDigest: capDigest, adapterDigest: adapter?.digest ?? null, declarationDigest: fulfillment?.digest ?? null, runtimeDigest: runtimeDigest(runtime) };
  const results = input.verification;
  if (results) {
    if (results.format !== VERIFICATION_RESULTS_FORMAT) throw new ExtractionRefused([{ code: "VERIFICATION_FORMAT", message: `results are ${VERIFICATION_RESULTS_FORMAT}` }]);
    if (digestOf(results.subject) !== digestOf(subject))
      throw new ExtractionRefused([{ code: "VERIFICATION_SUBJECT_MISMATCH", message: "the results were produced for another source revision, contract, adapter, declaration or runtime; they are not carried forward" }]);
    for (const id of Object.keys(results.behaviors)) if (!(id in BEHAVIORS)) throw new ExtractionRefused([{ code: "VERIFICATION_BEHAVIOR", message: `unknown behavior ${id}` }]);
  }
  const records: VerificationRecord[] = REQUIRED_BEHAVIORS.map((behavior) => {
    const r = results?.behaviors[behavior];
    const base = { behavior, category: BEHAVIORS[behavior].category, description: BEHAVIORS[behavior].description, subject };
    if (!r) return { ...base, status: "not-run" as const, against: "none" as const, results: [], limitations: [adapter ? "no result was recorded for this behavior" : "there is no adapter to verify yet"] };
    if (r.status === "not-run") return { ...base, status: "not-run" as const, against: "none" as const, results: [], limitations: [...r.limitations].sort(order) };
    if (!VERIFICATION_STATUSES.includes(r.status)) throw new ExtractionRefused([{ code: "VERIFICATION_STATUS", message: `${behavior}: ${String(r.status)}` }]);
    if (!VERIFICATION_TARGETS.includes(r.against)) throw new ExtractionRefused([{ code: "VERIFICATION_TARGET", message: `${behavior}: a result says what it was obtained against (${VERIFICATION_TARGETS.join(", ")})` }]);
    return { ...base, status: r.status, against: r.against, procedure: r.procedure, results: uniqueSorted(r.results), limitations: uniqueSorted(r.limitations ?? []) };
  });
  const summary = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, records.filter((r) => r.status === s).length])) as Record<VerificationStatus, number>;

  // Revision rules against the previous extraction.
  const identity = plan ? { ...plan.plan.identity } : { name, revision: 1 };
  if (input.previous) {
    const findings = compareExtractions(input.previous, { identity, contract: { canonical, capabilityDigest: capDigest, contractDigest: contractDigest(canonical), capability: { contract: canonical.application.id, name, version } }, adapter, source: { revision: subject.sourceRevision }, fulfillment, runtime });
    const blocking = findings.filter((f) => f.blocking);
    if (blocking.length) throw new ExtractionRefused(blocking.map(({ code, message }) => ({ code, message })));
  }

  const denials = c.authorization.denials;
  const sourceEvidence = [...c.entryPoints.flatMap((e) => e.evidence), ...(c.implementation?.evidence ?? []), ...c.tests.flatMap((t) => t.evidence)];
  const persistence = c.sideEffects.persistence.map((p) => ({ operation: "read" as const, statement: p.statement, evidence: p.evidence }));
  const authorizationEvidence = uniqueSorted([...denials, ...c.authorization.policyReferences]);
  const sideEffectEvidence = uniqueSorted(persistence.flatMap((p) => p.evidence));
  const artifact: Omit<CapabilityExtraction, "digest"> = {
    format: EXTRACTION_FORMAT,
    extraction: {
      id: (input.id ?? randomUUID)(),
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      ...(results ? { verificationRun: results.run } : {})
    },
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    identity,
    stage: adapter ? "implemented" : "proposed",
    assessment: { format: a.format, digest: a.digest, tool: a.tool, scanner: a.configuration.scanner, candidate: { id: c.id, digest: digestOf(c) } },
    source: {
      name: a.target.name,
      ...(a.target.repository ? { repository: a.target.repository } : {}),
      revision: a.target.revision!,
      operation: { kind: "rpc", service: c.operation.service, method: c.operation.method, fullMethod: c.operation.fullMethod, ...(c.entryPoints.find((e) => e.kind === "http-binding") ? { http: c.entryPoints.find((e) => e.kind === "http-binding")!.subject } : {}) },
      entryPoints: c.entryPoints,
      implementation: { symbol: c.implementation!.symbol, location: c.implementation!.location, evidence: c.implementation!.evidence },
      tests: c.tests
    },
    contract: {
      canonical,
      capability: { contract: canonical.application.id, name, version },
      contractDigest: contractDigest(canonical),
      capabilityDigest: capDigest,
      proposal: { name: proposal.name, inputSchema: proposal.inputSchema as JSONSchema, outputSchema: proposal.outputSchema as JSONSchema },
      mapping: {
        changes: [...mapping.changes].sort((x, y) => order(key(x), key(y))),
        decisions: [...mapping.decisions].sort((x, y) => order(x.subject, y.subject)),
        fields: [...mapping.fields].sort((x, y) => order(`${x.direction}${x.contract}`, `${y.direction}${y.contract}`))
      }
    },
    adapter,
    fulfillment,
    runtime,
    dependencies: {
      packages: adapter?.packages ?? {},
      application: uniqueSorted(c.dependencies.externalPackages.map((p) => p.importPath)),
      environment: plan ? [...plan.plan.environment] : []
    },
    authorization: {
      requirements: plan ? [...plan.plan.authorization.requirements] : [],
      restrictions: plan ? [...plan.plan.authorization.restrictions] : [],
      evidence: authorizationEvidence
    },
    sideEffects: { effect: "observation", persistence, evidence: sideEffectEvidence },
    verification: { required: REQUIRED_BEHAVIORS, records, summary },
    evidence: citedEvidence(a, [...sourceEvidence, ...authorizationEvidence, ...sideEffectEvidence]),
    findings: [
      ...(adapter ? [] : [{ code: "ADAPTER_MISSING", message: "no adapter: this is a proposed extraction; write an extraction plan and an adapter" }]),
      ...(summary["not-run"] ? [{ code: "VERIFICATION_INCOMPLETE", message: `${summary["not-run"]} of ${records.length} behaviors have not been verified` }] : []),
      ...(summary.failed ? [{ code: "VERIFICATION_FAILED", message: `${summary.failed} behaviors failed verification` }] : []),
      ...(summary.inconclusive ? [{ code: "VERIFICATION_INCONCLUSIVE", message: `${summary.inconclusive} behaviors are inconclusive` }] : [])
    ],
    limitations: [...LIMITATIONS, ...(plan ? plan.plan.limitations : [])].sort((x, y) => order(x.code, y.code)),
    questions: (plan ? [...plan.plan.questions] : [{ id: "q-permissions", question: `Which permissions must a caller of ${c.operation.method} hold?` }]).sort((x, y) => order(x.id, y.id)),
    scope: { grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false }
  };
  return { ...artifact, digest: extractionDigest(artifact) };
}

export interface RevisionFinding {
  code: string;
  message: string;
  blocking: boolean;
}

/**
 * The compatibility rules between two revisions of an extraction (spec/extraction-1.md §7): a changed source, contract
 * or adapter is a new revision that names the previous one; a breaking contract change is a new capability version.
 * Contract differences are AppPort's `compareManifests`.
 */
export function compareExtractions(
  previous: Pick<CapabilityExtraction, "identity" | "contract" | "adapter" | "source" | "digest" | "fulfillment" | "runtime">,
  next: {
    identity: CapabilityExtraction["identity"];
    contract: Pick<CapabilityExtraction["contract"], "canonical" | "capabilityDigest" | "contractDigest" | "capability">;
    adapter: AdapterIdentity | null;
    source: { revision: string };
    fulfillment?: FulfillmentDeclaration | null;
    runtime?: RuntimeConfiguration;
  }
): RevisionFinding[] {
  const out: RevisionFinding[] = [];
  if (previous.identity.name !== next.identity.name) out.push({ code: "IDENTITY_CHANGED", message: `${next.identity.name} is not a revision of ${previous.identity.name}`, blocking: true });
  const sourceChanged = previous.source.revision !== next.source.revision;
  const contractChanged = previous.contract.contractDigest !== next.contract.contractDigest;
  const adapterChanged = (previous.adapter?.digest ?? null) !== (next.adapter?.digest ?? null);
  // A /1 predecessor had neither: any declaration or runtime is a change.
  const declarationChanged = (previous.fulfillment?.digest ?? null) !== (next.fulfillment?.digest ?? null);
  const runtimeChanged = (previous.runtime ? runtimeDigest(previous.runtime) : null) !== (next.runtime ? runtimeDigest(next.runtime) : null);
  if (declarationChanged) out.push({ code: "DECLARATION_CHANGED", message: `fulfillment declaration ${previous.fulfillment?.digest ?? "none"} → ${next.fulfillment?.digest ?? "none"}`, blocking: false });
  if (runtimeChanged) out.push({ code: "RUNTIME_CHANGED", message: "the declared runtime changed", blocking: false });
  if (sourceChanged) out.push({ code: "SOURCE_CHANGED", message: `source revision ${previous.source.revision} → ${next.source.revision}`, blocking: false });
  if (adapterChanged) out.push({ code: "ADAPTER_CHANGED", message: `adapter ${previous.adapter?.digest ?? "none"} → ${next.adapter?.digest ?? "none"}`, blocking: false });
  if (contractChanged) {
    const report = compareManifests(previous.contract.canonical, next.contract.canonical);
    for (const c of [...report.breaking, ...report.nonBreaking]) out.push({ code: c.severity === "breaking" ? "CONTRACT_BREAKING_CHANGE" : "CONTRACT_CHANGE", message: `${c.target}: ${c.kind}`, blocking: false });
    if (report.breaking.some((c) => c.target.startsWith(`${next.contract.capability.name}@${next.contract.capability.version}`) || c.target.startsWith(next.contract.capability.name)) && previous.contract.capability.version === next.contract.capability.version)
      out.push({ code: "CONTRACT_BREAKING_SAME_VERSION", message: `a breaking change to ${next.contract.capability.name} needs a new capability version`, blocking: true });
  }
  if ((sourceChanged || contractChanged || adapterChanged || declarationChanged || runtimeChanged) && next.identity.revision <= previous.identity.revision)
    out.push({ code: "REVISION_NOT_INCREMENTED", message: `source, contract, adapter, declaration or runtime changed, but the revision is still ${next.identity.revision}`, blocking: true });
  if (next.identity.revision > previous.identity.revision && next.identity.previous !== previous.digest) out.push({ code: "PREVIOUS_MISMATCH", message: "a new revision names the digest of the one it replaces", blocking: true });
  if (next.identity.revision < previous.identity.revision) out.push({ code: "REVISION_REGRESSED", message: "revisions only increase", blocking: true });
  return out;
}
