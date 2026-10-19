/**
 * Reconciliation: one inventory of what a revision already exposes through AppPort (discovered capabilities, and
 * capabilities an extraction of this revision verified) and what it implements (the assessment's candidates).
 *
 * A match is a claim with evidence, graded:
 *   confirmed   exactly one candidate is bound to the capability by an extraction that verified, for this revision,
 *               against the real application, with its fulfillment claim published and valid;
 *   probable    exactly one candidate has evidence that is not verification: an unverified extraction, an operator's
 *               recorded assertion, or, failing both, the only interface whose shape fits (same input properties,
 *               required inputs and output properties, same effect);
 *   ambiguous   more than one candidate has the strongest evidence present: no choice is forced;
 *   unresolved  no candidate has any evidence.
 * Name similarity is recorded as a hint and never changes a status. Matching is not one-to-one: a candidate may back
 * several capabilities and a capability may have several candidates. Candidates that nothing exposes are kept.
 */
import type { ApplicationAssessment, Candidate } from "@appport/assessment";
import type { DiscoveryRecord } from "./discovery.js";

export type MatchStatus = "confirmed" | "probable" | "ambiguous" | "unresolved";
export type EvidenceKind = "verified-extraction" | "unverified-extraction" | "operator-assertion" | "interface-shape";

/** What an extraction of this revision says about one capability. */
export interface ExtractionBinding {
  candidate: string;
  capability: { name: string; version: number };
  extraction: string;
  extractionDigest: string;
  /** Verified, fresh (same revision, assessment, plan and unchanged checkout), declaration published and valid. */
  verified: boolean;
  detail: string;
}

/** An operator's recorded assertion that a candidate backs a capability. Evidence, never verification. */
export interface MatchDecision {
  id: string;
  capability: { name: string; version: number };
  candidate: string;
  rationale: string;
  by: string;
  at: string;
}

export interface InventoryCapability {
  name: string;
  version: number;
  sources: Array<"discovery" | "extraction">;
  discovery?: { status: "verified" | "unresolved"; effect?: string; claims: number; validClaims: number };
  status: MatchStatus;
  basis: string;
  candidates: Array<{ id: string; evidence: Array<{ kind: EvidenceKind; detail: string }> }>;
  hints: Array<{ candidate: string; kind: "name-similarity"; detail: string }>;
}

export interface InventoryCandidate {
  id: string;
  name: string;
  readiness: string;
  effect?: string;
  proposed?: string;
  exposure: "exposed" | "possibly-exposed" | "not-exposed" | "unknown";
  matches: Array<{ capability: string; status: MatchStatus }>;
}

export interface InventoryRecord {
  format: "appworks.inventory/1";
  revision: string;
  assessmentDigest: string;
  discovery: { outcome: DiscoveryRecord["outcome"]; at: string; endpoint?: string };
  partial: Array<{ code: string; message: string }>;
  capabilities: InventoryCapability[];
  candidates: InventoryCandidate[];
  summary: Record<MatchStatus, number> & { candidates: number; exposed: number; possiblyExposed: number; notExposed: number; unknown: number };
}

const fields = (shape: Candidate["inputs"]) => new Set((shape?.fields ?? []).map((f) => f.jsonName));
const subset = (a: string[], b: Set<string>) => a.every((x) => b.has(x));

/** Interface shape only: the discovered capability's properties all exist on the candidate's messages, same effect. */
function shapeFits(c: Candidate, d: DiscoveryRecord["capabilities"][number]): string | undefined {
  if (!d.input || !c.inputs?.resolved) return undefined;
  const effect = c.exposure.effectBasis.effect;
  if (d.effect && effect !== d.effect) return undefined;
  const inputs = fields(c.inputs);
  if (!subset(d.input.properties, inputs) || !subset(d.input.required, inputs)) return undefined;
  if (d.output && d.output.properties.length && !(c.outputs?.resolved && subset(d.output.properties, fields(c.outputs)))) return undefined;
  return `input {${d.input.properties.join(", ")}} and output {${d.output?.properties.join(", ") ?? ""}} are properties of ${c.inputs.message} and ${c.outputs?.message ?? "its output"}; effect ${effect}`;
}

const tokens = (text: string) =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !["api", "service", "get", "list"].includes(t))
    .map((t) => t.replace(/s$/, ""));

function hintsFor(name: string, candidates: Candidate[]): InventoryCapability["hints"] {
  const wanted = new Set(tokens(name));
  return candidates
    .map((c) => ({ c, score: tokens(c.name).filter((t) => wanted.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.c.id < b.c.id ? -1 : 1))
    .slice(0, 3)
    .map(({ c, score }) => ({ candidate: c.id, kind: "name-similarity" as const, detail: `${score} name token(s) in common; a similar name is not evidence of equivalence` }));
}

export function reconcile(input: { assessment: ApplicationAssessment; discovery: DiscoveryRecord; bindings: ExtractionBinding[]; decisions: MatchDecision[] }): InventoryRecord {
  const { assessment, discovery } = input;
  const candidates = assessment.candidates;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const key = (n: string, v: number) => `${n}@${v}`;
  const names = new Map<string, { name: string; version: number }>();
  for (const d of discovery.capabilities) names.set(key(d.name, d.version), { name: d.name, version: d.version });
  for (const b of input.bindings) names.set(key(b.capability.name, b.capability.version), b.capability);

  const capabilities: InventoryCapability[] = [...names.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, { name, version }]) => {
      const discovered = discovery.capabilities.find((d) => key(d.name, d.version) === k);
      const bindings = input.bindings.filter((b) => key(b.capability.name, b.capability.version) === k && byId.has(b.candidate));
      const evidence = new Map<string, Array<{ kind: EvidenceKind; detail: string }>>();
      const add = (id: string, kind: EvidenceKind, detail: string) => evidence.set(id, [...(evidence.get(id) ?? []), { kind, detail }]);
      for (const b of bindings) add(b.candidate, b.verified ? "verified-extraction" : "unverified-extraction", `${b.extraction} (${b.extractionDigest.slice(0, 19)}…): ${b.detail}`);
      for (const d of input.decisions.filter((x) => key(x.capability.name, x.capability.version) === k && byId.has(x.candidate))) add(d.candidate, "operator-assertion", `${d.by} at ${d.at}: ${d.rationale}`);
      if (discovered?.status === "verified")
        for (const c of candidates) {
          const fit = shapeFits(c, discovered);
          if (fit) add(c.id, "interface-shape", fit);
        }
      const holding = (kinds: EvidenceKind[]) => [...evidence.entries()].filter(([, e]) => e.some((x) => kinds.includes(x.kind))).map(([id]) => id);
      const verified = holding(["verified-extraction"]);
      const asserted = holding(["unverified-extraction", "operator-assertion"]);
      const shaped = holding(["interface-shape"]);
      let status: MatchStatus;
      let basis: string;
      if (discovered && discovered.status !== "verified" && !bindings.length) {
        status = "unresolved";
        basis = `discovery could not verify this capability (${discovered.reasons.join(", ")})`;
      } else if (verified.length === 1) {
        status = "confirmed";
        basis = "one candidate is bound by an extraction verified for this revision";
      } else if (verified.length > 1) {
        status = "ambiguous";
        basis = `${verified.length} candidates are bound by verified extractions`;
      } else if (asserted.length === 1) {
        status = "probable";
        basis = "one candidate is bound by an unverified extraction or an operator's assertion; nothing verified it";
      } else if (asserted.length > 1) {
        status = "ambiguous";
        basis = `${asserted.length} candidates are asserted; none is verified`;
      } else if (shaped.length === 1) {
        status = "probable";
        basis = "exactly one candidate's interface fits; the shape fits, the behavior is not verified";
      } else if (shaped.length > 1) {
        status = "ambiguous";
        basis = `${shaped.length} candidates' interfaces fit; no evidence distinguishes them`;
      } else {
        status = "unresolved";
        basis = discovered?.input ? "no candidate's interface fits and nothing binds one" : "the manifest gives no schema to compare and nothing binds a candidate";
      }
      const strongest = status === "confirmed" || (status === "ambiguous" && verified.length > 1) ? verified : asserted.length ? asserted : shaped;
      return {
        name,
        version,
        sources: [...(discovered ? (["discovery"] as const) : []), ...(bindings.length ? (["extraction"] as const) : [])],
        ...(discovered ? { discovery: { status: discovered.status, ...(discovered.effect ? { effect: discovered.effect } : {}), claims: discovered.claims.length, validClaims: discovered.claims.filter((c) => c.evaluation === "valid").length } } : {}),
        status,
        basis,
        candidates: [...evidence.entries()]
          .sort(([a], [b]) => Number(!strongest.includes(a)) - Number(!strongest.includes(b)) || (a < b ? -1 : 1))
          .map(([id, e]) => ({ id, evidence: e })),
        hints: hintsFor(name, candidates)
      };
    });

  const discoveryKnown = discovery.outcome !== "unavailable";
  const inventoryCandidates: InventoryCandidate[] = candidates.map((c) => {
    const matches = capabilities.filter((cap) => cap.candidates.some((x) => x.id === c.id)).map((cap) => ({ capability: key(cap.name, cap.version), status: cap.status }));
    const sole = capabilities.some((cap) => (cap.status === "confirmed" || cap.status === "probable") && cap.candidates[0]?.id === c.id);
    const exposure: InventoryCandidate["exposure"] = sole ? "exposed" : matches.length ? "possibly-exposed" : discoveryKnown ? "not-exposed" : "unknown";
    return { id: c.id, name: c.name, readiness: c.readiness.class, effect: c.exposure.effectBasis.effect, ...(c.exposure.capability ? { proposed: `${c.exposure.capability.name}@${c.exposure.capability.version}` } : {}), exposure, matches };
  });

  const partial: InventoryRecord["partial"] = [];
  if (discovery.outcome === "unavailable") partial.push({ code: "DISCOVERY_UNAVAILABLE", message: "discovery did not run or did not verify: which candidates are already exposed is unknown" });
  if (assessment.coverage.partial) partial.push({ code: "ASSESSMENT_PARTIAL", message: `the assessment is partial (${assessment.coverage.partialReasons.join(", ")}): candidates outside its coverage are absent from this inventory` });
  const count = (s: MatchStatus) => capabilities.filter((c) => c.status === s).length;
  const exposureCount = (e: InventoryCandidate["exposure"]) => inventoryCandidates.filter((c) => c.exposure === e).length;
  return {
    format: "appworks.inventory/1",
    revision: assessment.target.revision ?? "",
    assessmentDigest: assessment.digest,
    discovery: { outcome: discovery.outcome, at: discovery.at, ...(discovery.endpoint ? { endpoint: discovery.endpoint } : {}) },
    partial,
    capabilities,
    candidates: inventoryCandidates,
    summary: { confirmed: count("confirmed"), probable: count("probable"), ambiguous: count("ambiguous"), unresolved: count("unresolved"), candidates: inventoryCandidates.length, exposed: exposureCount("exposed"), possiblyExposed: exposureCount("possibly-exposed"), notExposed: exposureCount("not-exposed"), unknown: exposureCount("unknown") }
  };
}
