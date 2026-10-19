/**
 * Contract adoption: from a verified extraction to an explicit, reviewable proposal to adopt its canonical contract into
 * the target's integration (`appworks.contract-adoption/1`, spec/workspace-1.md §11).
 *
 * The proposal states every material difference between the contract and (a) the assessment's source-inferred
 * proposal, (b) the decisions the extraction plan made, (c) the operation's authority as the source shows it, and (d)
 * any existing AppPort declaration that could be the same capability. Each difference says what supports it: verified
 * (a behavior that covers it passed, for exactly this contract), source evidence (the assessment observed it), explained
 * (a reviewed reason, nothing more), or unknown. Open questions are carried with the disposition a reviewer gave them.
 *
 * Nothing here is an equivalence claim. A matching name, a compatible schema, a published fulfillment claim and passing
 * behaviors are each recorded for what they are. Anything unknown or open that affects correctness, security or the
 * declared contract blocks adoption, and stays visible.
 *
 * Validation is AppPort's and the extraction library's: `isCanonicalContract`, `capabilityDigest`, `contractDigest`,
 * `compareSchemas` (@appport/protocol), `contractProblems`, `fulfillmentProblems`, `contractChanges`, `verifyExtraction`
 * (@appport/extraction). AppWorks keeps no canonical registry: the adopted contract is a file in the promoted
 * integration, published through the application's own boundary.
 */
import type { Candidate } from "@appport/assessment";
import { contractChanges, contractProblems, fulfillmentProblems, verifyExtraction, type CapabilityExtraction } from "@appport/extraction";
import { capabilityDigest, compareSchemas, contractDigest, digestOf, findCapabilityVersion, isCanonicalContract, type AppPortManifest } from "@appport/protocol";
import type { DiscoveryRecord } from "./discovery.js";

export const ADOPTION_FORMAT = "appworks.contract-adoption/1";

export type Impact = "security" | "correctness" | "contract" | "compatibility" | "process";
export type Support = "verified" | "source-evidence" | "explained" | "unknown";

export interface Difference {
  id: string;
  kind: "schema" | "decision" | "authority" | "effect" | "existing-declaration";
  subject: string;
  description: string;
  impact: Impact;
  support: Support;
  /** Behaviors that cover it, with their recorded status, and assessment evidence ids. */
  behaviors: Array<{ behavior: string; status: string; against?: string }>;
  evidence: string[];
  reason?: string;
  blocking: boolean;
}

export interface QuestionDisposition {
  impact: Impact;
  disposition: "resolved" | "accepted" | "open";
  reason: string;
}

export interface ContractAdoption {
  format: typeof ADOPTION_FORMAT;
  source: { repository: string; revision: string };
  assessment: { digest: string; candidate: string };
  extraction: { digest: string; format: string; identity: { name: string; revision: number }; subject: Record<string, string> };
  contract: { application: string; capability: string; version: number; contractDigest: string; capabilityDigest: string; status: "proposed" };
  provider: { application: string; capability: string; version: number } | null;
  existingDeclarations: Array<{ name: string; version: number; relation: string; claims: string[]; comparable: boolean }>;
  differences: Difference[];
  questions: Array<{ id: string; question: string } & QuestionDisposition & { blocking: boolean }>;
  limitations: Array<{ code: string; description: string }>;
  validation: { contract: string[]; fulfillment: string[]; extraction: string[]; verification: string[] };
  blocking: Array<{ code: string; subject: string; message: string }>;
  /** What adoption means and does not. */
  scope: { grantsAuthority: false; registers: false; establishesEquivalence: false; adoptsInto: "target-integration" };
  digest: string;
}

const BEHAVIORS_FOR: Record<string, string[]> = {
  input: ["contract.interface-conformance", "contract.invalid-input"],
  output: ["contract.interface-conformance", "contract.output-shape", "contract.no-field-omitted", "contract.optional-fields"],
  authority: ["authorization.unauthenticated-denied", "authorization.resource-restriction", "authorization.permitted-results", "authorization.no-bypass", "authorization.claim-not-authority", "authorization.discovery-not-authority"],
  errors: ["errors.deliberate-mapping", "errors.denial-distinguishable", "errors.failure-not-success"],
  fulfillment: ["integration.fulfillment-claim", "integration.declaration-fails-closed", "integration.discoverable"]
};

function behaviorsFor(x: CapabilityExtraction, group: string, contractFresh: boolean) {
  const records = x.verification.records.filter((r) => (BEHAVIORS_FOR[group] ?? []).includes(r.behavior)).map((r) => ({ behavior: r.behavior, status: r.status, ...(r.against ? { against: r.against } : {}) }));
  const verified = contractFresh && records.length > 0 && records.every((r) => r.status === "passed");
  return { records, verified };
}

const decisionGroup = (subject: string) => (/permission|authori|scope|credential|anonymous/i.test(subject) ? "authority" : /error|status|denial/i.test(subject) ? "errors" : /null|optional|default|field|name|object/i.test(subject) ? "output" : "");

const unknownBlocks = (impact: Impact) => impact === "security" || impact === "correctness" || impact === "contract";

export interface AdoptionInput {
  extraction: CapabilityExtraction;
  candidate: Candidate;
  /** The contract file as it is now, next to the reviewed plan. */
  contract: unknown;
  /** The fulfillment declaration file as it is now. */
  declaration: unknown;
  discovery: DiscoveryRecord;
  /** Inventory matches of the candidate (capability@version), to find existing declarations that may be it. */
  matches: string[];
  dispositions: Record<string, QuestionDisposition>;
}

export function proposeAdoption(input: AdoptionInput): ContractAdoption {
  const x = input.extraction;
  const canonical = input.contract as AppPortManifest;
  const { name, version } = x.contract.capability;
  const blocking: ContractAdoption["blocking"] = [];
  const validation: ContractAdoption["validation"] = { contract: [], fulfillment: [], extraction: [], verification: [] };

  // The contract: AppPort's own checks, and that it is exactly the contract the extraction verified.
  if (!isCanonicalContract(canonical)) validation.contract.push("not an AppPort canonical contract");
  validation.contract.push(...contractProblems(canonical, { name, version }));
  const currentCapability = (() => {
    try {
      return capabilityDigest(canonical, name, version) ?? "";
    } catch {
      return "";
    }
  })();
  const currentContract = (() => {
    try {
      return contractDigest(canonical);
    } catch {
      return "";
    }
  })();
  const contractFresh = currentCapability === x.contract.capabilityDigest && currentContract === x.contract.contractDigest;
  if (!contractFresh) validation.verification.push(`the contract changed since it was verified (capability ${currentCapability || "unreadable"}, verified ${x.contract.capabilityDigest}): verification results whose subject includes the contract do not apply`);
  const integrity = verifyExtraction(x);
  if (!integrity.ok) validation.extraction.push(...integrity.findings.map((f) => `${f.code} ${f.path}`));
  const subject = x.verification.records[0]?.subject as unknown as Record<string, string> | undefined;
  const notPassed = x.verification.records.filter((r) => r.status !== "passed");
  if (notPassed.length) validation.verification.push(`${notPassed.length} of ${x.verification.records.length} required behaviors did not pass: ${notPassed.map((r) => r.behavior).join(", ")}`);
  if (subject && subject.capabilityDigest !== currentCapability) validation.verification.push("the verification subject names another contract");

  // The fulfillment declaration as it is now, against the contract.
  if (!input.declaration || typeof input.declaration !== "object") validation.fulfillment.push("FULFILLMENT_MISSING: the declaration cannot be read");
  else if (x.fulfillment) {
    const d = input.declaration as { extensions?: string[]; attributes?: Record<string, never> };
    const problems = fulfillmentProblems({ provider: x.fulfillment.provider, extensions: d.extensions, attributes: d.attributes }, canonical, { name, version });
    validation.fulfillment.push(...problems.map((p) => `${p.code}: ${p.message}`));
    if (digestOf({ extensions: d.extensions, attributes: d.attributes }) !== digestOf({ extensions: x.fulfillment.extensions, attributes: x.fulfillment.attributes })) validation.fulfillment.push("FULFILLMENT_CHANGED: the declaration is not the one the extraction verified");
  } else validation.fulfillment.push("FULFILLMENT_MISSING: the extraction publishes no declaration");
  for (const [area, list] of Object.entries(validation)) for (const message of list) blocking.push({ code: `INVALID_${area.toUpperCase()}`, subject: area, message });

  const differences: Difference[] = [];
  const entry = isCanonicalContract(canonical) ? findCapabilityVersion(canonical, name, version) : undefined;
  // (a) Against the assessment's source-inferred proposal: every compareSchemas difference, with the plan's reason.
  if (entry) {
    const reasons = new Map(x.contract.mapping.changes.map((c) => [`${c.direction}|${c.kind}|${c.target}`, c.reason]));
    const fieldEvidence = (direction: "input" | "output", target: string) => {
      const shape = direction === "input" ? input.candidate.inputs : input.candidate.outputs;
      const field = shape?.fields.find((f) => f.jsonName === target.split(".")[0]);
      return field ? field.evidence : [];
    };
    for (const c of contractChanges(x.contract.proposal, entry)) {
      const { records, verified } = behaviorsFor(x, c.direction, contractFresh);
      const evidence = fieldEvidence(c.direction, c.target);
      const reason = reasons.get(`${c.direction}|${c.kind}|${c.target}`);
      const support: Support = verified ? "verified" : evidence.length ? "source-evidence" : reason ? "explained" : "unknown";
      const impact: Impact = c.severity === "breaking" ? "correctness" : "contract";
      differences.push({ id: `schema:${c.direction}:${c.kind}:${c.target}`, kind: "schema", subject: `${c.direction} ${c.target}`, description: `${c.kind} (${c.severity}) from the source-inferred proposal: ${c.message}`, impact, support, behaviors: records, evidence, ...(reason ? { reason } : {}), blocking: support === "unknown" && unknownBlocks(impact) });
    }
  }
  // (b) The plan's decisions that compareSchemas does not report.
  for (const d of x.contract.mapping.decisions) {
    const group = decisionGroup(d.subject);
    const { records, verified } = group ? behaviorsFor(x, group, contractFresh) : { records: [], verified: false };
    const impact: Impact = group === "authority" ? "security" : group ? "correctness" : "contract";
    const support: Support = verified ? "verified" : d.reason ? "explained" : "unknown";
    differences.push({ id: `decision:${d.subject}`, kind: "decision", subject: d.subject, description: d.decision, impact, support, behaviors: records, evidence: [], reason: d.reason, blocking: support === "unknown" && unknownBlocks(impact) });
  }
  // (c) Authority: what the contract requires against what the operation does, as the plan states and the source shows.
  const authority = behaviorsFor(x, "authority", contractFresh);
  const scopes = (entry as { authorization?: unknown } | undefined)?.authorization;
  differences.push({ id: "authority:requirement", kind: "authority", subject: "authorization", description: `the contract requires ${JSON.stringify(scopes ?? "nothing stated")}; the application decides every call with the caller's own credential`, impact: "security", support: authority.verified ? "verified" : input.candidate.authorization?.denials?.length ? "source-evidence" : "unknown", behaviors: authority.records, evidence: input.candidate.authorization?.denials ?? [], blocking: !authority.verified && !(input.candidate.authorization?.denials?.length) });
  x.authorization.restrictions.forEach((restriction, i) => {
    differences.push({ id: `authority:restriction:${i + 1}`, kind: "authority", subject: "authorization", description: restriction, impact: "security", support: authority.verified ? "verified" : "explained", behaviors: authority.records, evidence: x.authorization.evidence, blocking: false });
  });
  // Effect.
  const proposedEffect = input.candidate.exposure.effectBasis.effect;
  const declaredEffect = (entry as { effect?: string } | undefined)?.effect;
  if (declaredEffect !== proposedEffect) differences.push({ id: "effect", kind: "effect", subject: "effect", description: `the contract declares ${declaredEffect ?? "no effect"}; the source shows ${proposedEffect}`, impact: "correctness", support: "unknown", behaviors: [], evidence: input.candidate.exposure.effectBasis.evidence, blocking: true });

  // (d) Existing declarations that could be the same capability: by inventory match, by claim, by name.
  const existingDeclarations: ContractAdoption["existingDeclarations"] = [];
  for (const d of input.discovery.capabilities) {
    const key = `${d.name}@${d.version}`;
    const claims = d.claims.filter((c) => c.claim.contract === x.contract.capability.contract && c.claim.capability === name).map((c) => `${c.claim.contract} ${c.claim.capability}@${c.claim.version} (${c.evaluation})`);
    const relation = input.matches.includes(key) ? "reconciled with the candidate" : claims.length ? "claims this contract" : d.name === name || (x.fulfillment && d.name === x.fulfillment.provider.capability) ? "same name (not evidence of equivalence)" : "";
    if (!relation) continue;
    const declared = d as typeof d & { inputSchema?: unknown; outputSchema?: unknown };
    const comparable = Boolean(entry && declared.inputSchema && declared.outputSchema);
    existingDeclarations.push({ name: d.name, version: d.version, relation, claims, comparable });
    if (!comparable) {
      differences.push({ id: `existing:${key}`, kind: "existing-declaration", subject: key, description: `${key} (${relation}) is an existing declaration whose schemas this workspace did not record; compatibility with it is unknown`, impact: "compatibility", support: "unknown", behaviors: [], evidence: [], blocking: true });
      continue;
    }
    const breaking = [
      ...compareSchemas(declared.inputSchema as never, entry!.inputSchema, `${key} input`, "input"),
      ...compareSchemas(declared.outputSchema as never, entry!.outputSchema, `${key} output`, "output")
    ].filter((c) => c.severity === "breaking");
    if (breaking.length || (d.effect && d.effect !== declaredEffect))
      differences.push({ id: `existing:${key}`, kind: "existing-declaration", subject: key, description: `incompatible with the existing declaration ${key} (${relation}): ${[...breaking.map((c) => `${c.target}: ${c.kind}`), ...(d.effect && d.effect !== declaredEffect ? [`effect ${d.effect} vs ${declaredEffect}`] : [])].join("; ")}`, impact: "contract", support: "unknown", behaviors: [], evidence: [], blocking: true });
  }

  const questions = x.questions.map((q) => {
    const d = input.dispositions[q.id] ?? { impact: "contract" as Impact, disposition: "open" as const, reason: "no reviewed disposition" };
    return { ...q, ...d, blocking: d.disposition === "open" && unknownBlocks(d.impact) };
  });
  for (const d of differences) if (d.blocking) blocking.push({ code: d.kind === "existing-declaration" ? "CONTRACT_INCOMPATIBLE" : "DIFFERENCE_UNRESOLVED", subject: d.id, message: d.description });
  for (const q of questions) if (q.blocking) blocking.push({ code: "QUESTION_OPEN", subject: q.id, message: `${q.question} (${q.impact}: ${q.reason})` });

  const content: Omit<ContractAdoption, "digest"> = {
    format: ADOPTION_FORMAT,
    source: { repository: x.source.repository ?? "", revision: x.source.revision },
    assessment: { digest: x.assessment.digest, candidate: x.assessment.candidate.id },
    extraction: { digest: x.digest, format: x.format, identity: { name: x.identity.name, revision: x.identity.revision }, subject: subject ?? {} },
    contract: { application: x.contract.capability.contract, capability: name, version, contractDigest: currentContract || x.contract.contractDigest, capabilityDigest: currentCapability || x.contract.capabilityDigest, status: "proposed" },
    provider: x.fulfillment ? x.fulfillment.provider : null,
    existingDeclarations,
    differences,
    questions,
    limitations: x.limitations,
    validation,
    blocking,
    scope: { grantsAuthority: false, registers: false, establishesEquivalence: false, adoptsInto: "target-integration" }
  };
  return { ...content, digest: digestOf(content) };
}

/** Integrity of a proposal as stored: its digest over its content. */
export function adoptionProblems(value: unknown): string[] {
  const a = value as ContractAdoption;
  if (!a || typeof a !== "object" || a.format !== ADOPTION_FORMAT) return ["ADOPTION_FORMAT"];
  const { digest, ...content } = a;
  return digest === digestOf(content) ? [] : ["ADOPTION_DIGEST_MISMATCH"];
}
