# Capability extraction (`appport.capability-extraction/1`)

**Status:** Draft, owned by AppWorks. Reference implementation: `@appport/extraction` (library and the `appworks` CLI). Schema:
`packages/extraction/schemas/capability-extraction.schema.json`. First extraction: `extractions/memos-reactions/` (Memos
`MemoService.ListMemoReactions` as `memos.reactions.list@1`).

The formats are named in the `appport.*` ecosystem namespace and are **not** part of the AppPort protocol (`docs/architecture.md` §2).

## 1. What an extraction is, and is not

An extraction takes **one** candidate of a verified assessment (`spec/assessment-1.md`) and binds, in one versioned, content-addressed
record:

| Piece | What it is | In the artifact |
|---|---|---|
| **Source operation** | the existing operation and its implementation, at an immutable revision | `source`, `assessment`, `evidence` |
| **Capability contract** | the stable name and input/output requirements advertised to agents: a proposed AppPort canonical contract | `contract` |
| **Adapter** | the code that maps an invocation of the capability to the existing operation, hosted by the application's existing AppPort boundary | `adapter` |
| **Authorization** | what is checked when the capability is invoked, and by whom | `authorization` |
| **Verification** | which named behaviors were verified, how, for exactly which source, contract and adapter, with what result | `verification` |
| **Extraction package** | this artifact, with its digest and revision | the whole |

It is a description and provenance record. It is **not**:

* source extraction: no application source is rewritten, generated or moved, and no portable implementation is produced;
* a second application server: the adapter runs inside the application's existing AppPort boundary;
* an authorization grant: nothing in it lets anyone invoke anything (`scope.grantsAuthority: false`, and the verifier refuses grant members);
* executable: validation reads JSON and files and runs nothing;
* proof of equivalence: only the behaviors whose records say `passed` are verified, for that subject, in the states exercised;
* a deployment: generating or verifying it registers, publishes or deploys nothing.

This version extracts **read-only request/response** operations only.

## 2. The workflow

```
appworks assess <repo> --output assessment.json                                   # spec/assessment-1.md
appworks extract assessment.json --candidate <id> --repo <repo> --output proposed.json
#   → a proposed extraction: the assessment's proposal as contract, no adapter, every behavior not-run
#   write a plan (contract, mapping, adapter, authorization notes) and the adapter; run the verification suite
appworks extract assessment.json --candidate <id> --repo <repo> --plan extraction-plan.json \
                 --verification results.json [--previous extraction.json] --output extraction.json
appworks verify-extraction extraction.json --assessment assessment.json --repo <repo> --plan-dir <dir>
```

`extract` (1) verifies the assessment (structure, evidence classes and references, digest), (2) verifies it against the repository
(every observed location) and requires the repository's revision to be the assessment's, (3) finds the candidate, (4) applies the
eligibility rules (§3), (5) checks the contract and the mapping (§4), (6) computes the adapter's identity from its files (§5),
(7) accepts verification results only for the subject they were produced for (§6), (8) applies the revision rules against
`--previous` (§7), and writes the artifact without overwriting unless `--force`. Each refusal has a reason code. Nothing in the
repository is written or executed.

## 3. Eligibility (reason codes)

| Code | Refused when |
|---|---|
| `ASSESSMENT_INVALID` | `verifyAssessment` reports any finding (modified content, digest mismatch, dangling or forged evidence, verified claims) |
| `ASSESSMENT_REVISION_MISSING` | the assessment is not tied to a revision |
| `REPOSITORY_REVISION_MISMATCH` | the repository is at another revision |
| `ASSESSMENT_LOCATIONS_INVALID` | an observed location does not match the repository |
| `CANDIDATE_NOT_FOUND` | the candidate is not in this assessment |
| `CANDIDATE_NOT_READY` | its readiness class is not `exposure-candidate` |
| `CANDIDATE_LINK_WEAK`, `CANDIDATE_SCHEMA_UNRESOLVED`, `CANDIDATE_NO_AUTHORIZATION_EVIDENCE`, `CANDIDATE_NO_VALIDATION_EVIDENCE`, `CANDIDATE_NO_TESTS`, `CANDIDATE_REACHABILITY_INCOMPLETE` | the corresponding readiness criterion is unmet |
| `CANDIDATE_NOT_READ_ONLY` | its effect is not `observation`, or a SQL write is reachable |
| `CANDIDATE_BLOCKING_CONCERN` | outbound HTTP or asynchronous work is reachable |
| `CANDIDATE_STREAMING`, `CANDIDATE_NO_PROPOSAL` | streaming, or no proposed shape |
| `PLAN_FORMAT`, `PLAN_CANDIDATE` | the plan is not `appport.capability-extraction-plan/1`, or is for another candidate |
| `CONTRACT_INVALID` | §4 |
| `MAPPING_UNEXPLAINED`, `MAPPING_STALE` | §4 |
| `ADAPTER_FILE_MISSING`, `BOUNDARY_FILE_MISSING` | an adapter or boundary file cannot be read (inside the plan directory, or the repository, no links) |
| `VERIFICATION_FORMAT`, `VERIFICATION_SUBJECT_MISMATCH`, `VERIFICATION_BEHAVIOR`, `VERIFICATION_STATUS` | §6 |
| `REVISION_NOT_INCREMENTED`, `PREVIOUS_MISMATCH`, `REVISION_REGRESSED`, `IDENTITY_CHANGED`, `CONTRACT_BREAKING_SAME_VERSION` | §7 |

## 4. The contract and its mapping

The contract is an AppPort canonical contract (`appport.canonical-contract/1`, `@appport/protocol` 1.2.0): an `AppPortManifest` with
no transports, defining the capability. It must define the named capability version as a `request`, `observation` capability, pass
`lintIntegration`, and its schemas must use only AppPort's JSON Schema subset: no unknown keywords or types, local `$ref`s that
resolve, valid patterns, compilable by `@appport/schema`. Its identity is `contractDigest` and `capabilityDigest`.

The contract is **authored**, not inferred from a name. It starts from the assessment's proposal (proto3 JSON mapping of the source
messages), and the plan's `mapping` states:

* `changes`: every difference AppPort's `compareSchemas` reports between the proposal (with `$defs` inlined) and the contract, input
  and output, each with a reason. A difference without a reason is `MAPPING_UNEXPLAINED`; a reason for a difference that does not
  exist is `MAPPING_STALE`. Nothing narrows, widens or renames silently;
* `decisions`: what `compareSchemas` does not report (naming, closed objects, required outputs, authorization), each with a reason;
* `fields`: the field-by-field correspondence with the source messages (`identity` or `default-if-absent`).

The contract is the external interface; the source's internal request and response types stay the application's.

## 5. The adapter and its boundary

An adapter is the smallest code that exposes the source operation through the application's **existing** AppPort boundary: it
invokes the real operation through the application's own interface with the caller's own credential, preserves validation, output
semantics, errors and authorization, holds no credential, reads no database and adds no registry, cache or store. Its identity is
its name, version, file digests (`sha256:` of each file's UTF-8 content, AppPort's `sha256`), the exact packages it runs on, and the
boundary: the application files that host it, at the source revision, with their digests, and the invocation it makes. The
`adapter.digest` is `digestOf` of all of that. Adapters live in private packages under `extractions/`; they are never shipped by
`@appport/extraction`.

## 6. Verification

Every read-only extraction accounts for the same eighteen behaviors (`BEHAVIORS`): output shape, invalid input, optional fields,
empty and multiple results, no omitted field, interface conformance; permitted results, unauthenticated denied, resource restriction,
discovery is not authority, no bypass; deliberate error mapping, distinguishable denials, failure is never success; discoverable, real
operation reached, source revision tested and unchanged, fulfillment claim published.

A record is `{ behavior, category, description, status, procedure?, subject, results, limitations }`:

| Status | Meaning |
|---|---|
| `not-run` | not verified; nothing is claimed |
| `passed` | the procedure ran and every check of it held, for this subject, in the states it exercised |
| `failed` | the procedure ran and the behavior does not hold (or a check of it failed) |
| `inconclusive` | the procedure ran but could not decide |

`procedure` is `{ kind: integration-test | unit-test | static-check | protocol-check, reference }`. `subject` is
`{ sourceRevision, capabilityDigest, adapterDigest }`: a result applies **only** while all three equal the artifact's own. Results
come from a run as `appport.capability-verification-results/1` with the subject that run computed from what it actually loaded;
`extract` refuses results for another subject (`VERIFICATION_SUBJECT_MISMATCH`) instead of carrying them forward. There is no
blanket `verified` flag: the verifier refuses members named `verified`, `equivalent`, `grant`, `grants` or `authorizationGrant`
anywhere outside the canonical contract. A schema check is not behavioral verification; an invocation is not authorization
correctness; a passing run is not equivalence across all application states.

## 7. Revisions and compatibility

`identity` is `{ name, revision, previous? }`. Rules (`compareExtractions`, applied by `extract --previous`):

* **source**: a new source revision is a new extraction revision; results for the old one are stale (`VERIFICATION_STALE`);
* **contract**: any change to `contractDigest` needs a new extraction revision; changes are reported as AppPort `compareManifests`
  differences; a breaking change to the capability in the same capability version is refused (`CONTRACT_BREAKING_SAME_VERSION`);
* **adapter**: any change to `adapter.digest` needs a new extraction revision;
* a new revision names the digest of the one it replaces (`PREVIOUS_MISMATCH`), and revisions only increase;
* **verification** identifies the source, contract and adapter it tested. A previous passing result is never evidence for changed
  code; there is no carry-forward policy in this version.

## 8. The artifact, its digest and its verifier

```
{ "format": "appport.capability-extraction/1",
  "extraction": { "id", "createdAt", "verificationRun"? },        volatile: excluded from the digest
  "tool", "identity", "stage": "proposed" | "implemented",
  "assessment": { format, digest, tool, scanner, candidate: { id, digest } },
  "source": { name, repository?, revision, operation, entryPoints, implementation, tests },
  "contract": { canonical, capability, contractDigest, capabilityDigest, proposal, mapping },
  "adapter": AdapterIdentity | null,
  "dependencies": { packages, application, environment },
  "authorization": { requirements, restrictions, evidence },
  "sideEffects": { effect: "observation", persistence, evidence },
  "verification": { required, records, summary },
  "evidence": [ assessment evidence records, verbatim ],
  "findings", "limitations", "questions",
  "scope": { grantsAuthority: false, executable: false, establishesEquivalence: false, modifiesTarget: false, deploys: false },
  "digest" }
```

`digest` is `digestOf` (`@appport/protocol`, RFC 8785) without `digest` and `extraction`, the same rule as assessments and recipe
packages. `candidate.digest` is `digestOf` of the assessment's candidate. `verifyExtraction(value, { assessment?, adapterFiles?,
boundaryFiles?, repositoryRevision? })` checks closed members, scope, forbidden claims, identity and stage, the source revision, the
evidence (content ids, references, and with the assessment, that each record is the assessment's), the contract (§4) and its digests
and mapping, the adapter digest and files, the boundary files, verification records (§6) and summary, and the digest.
`verifyExtractionAt` reads those files from disk. Neither executes anything.

CLI exit status: `0` written or valid; `1` an input cannot be read or the artifact is invalid; `2` invalid arguments, an output that
exists without `--force` or lies inside the repository; `4` extraction refused, with reason codes.

## 9. Not in this version

Write capabilities, streaming, automatic source rewriting, code generation, a compiler, recipe execution, migration, production
deployment, publication of the capability or its fulfillment claim, and carrying verification across revisions.
