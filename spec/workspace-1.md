# AppWorks project workspace, version 1 (draft)

The project workspace carries **one repository revision** through discovery, assessment, reconciliation, extraction and verification,
and records every step durably. It is served as a web workspace (the primary interface) and through the `appworks` CLI. Both call the same
domain API (`@appport/workspace`), so there is one workflow implementation. This document specifies the model, the workflow, its records
and the boundaries it enforces. The code is in `packages/workspace`; the durable model is `packages/workspace/feltdb.flow`.

## 1. Authority and state

* **FeltDB 0.12.0 is the only durable authority.** Project identity and pinned revision, runs, inventory, decisions, stage history,
  artifact and verification references (with digests), approvals and promotion status are FeltDB records. No other copy is authoritative:
  not process memory, not a JSON file, not a job record, not another database.
* **`feltdb.flow` is authoritative for the model.** The workspace parses it with FeltDB's `parseFlowSpec`, validates it with
  `validateFlowSpec`, deploys it with `deployFlowSpec` when it opens a home (a destructive change is refused, never applied), creates the
  indexes it declares, and derives its stages, steps, evidence slots and approval actions from it. It refuses to write any record that
  does not match the collection and fields the flow declares (`RECORD_INVALID`). A flow that is not self-consistent stops the workspace.
* **Every change to more than one record is one FeltDB transaction**, and every change to an existing record is fenced on the version that
  was read (`ifVersion`); new records are `requireAbsent`. Two writers never both succeed: the loser gets `CONFLICT` and nothing is written.
* **Artifact bodies** (assessments run to megabytes) are content-addressed files under the workspace home, written by temporary name and
  rename. FeltDB holds the reference, the file digest and the artifact's own digest; a body is read only through its record and refused
  if it does not match (`ARTIFACT_CORRUPT`). A body without a record is not evidence.

## 2. Collections (`feltdb.flow`)

| Collection | One record per | Notes |
|---|---|---|
| `Project` | project | repository identity, selected ref, pinned revision, stage, condition, current evidence (ids), active run, history counter |
| `StageEvent` | transition, failure, cancellation, approval or action | append-only; `projectId.NNNN` |
| `Run` | attempt at a step or action | lease (`owner`, `leaseExpiresAt`), status, error, recorded external effect, inputs |
| `Artifact` | stored body | kind (`integration`, `discovery`, `assessment`, `inventory`, `plan`, `extraction`, `verification-log`), digests, partial reasons |
| `Approval` | action and exact subject | `requested` → `granted` → `consumed` |
| `Decision` | operator decision | candidate selection, match assertion, promotion status |
| `Verification` | verification of an extraction | integrity findings, behavior counts by target, checkout check, reasons, the digests it was made for |

## 3. Workflow

The stages, in order (`workflow transformation` in `feltdb.flow`; each step's `to`):

`project-selected` → `repository-acquired` → `revision-pinned` → `integration-inspected` → `capabilities-discovered` →
`assessment-completed` → `inventory-reconciled` → `candidate-selected` → `extraction-planned` → `awaiting-approval` →
`extraction-executed` → `verification-completed` → `ready-for-promotion`

| Step | From | Precondition (validated evidence) | Records |
|---|---|---|---|
| `acquire` | `project-selected` | the provider resolves the ref to one commit | isolated checkout of exactly that commit; whether it is on the default branch |
| `pin` | `repository-acquired` | the checkout's HEAD is the resolved SHA | the checkout's content hash (every path, mode, mtime and byte, `.git` included) |
| `inspect` | `revision-pinned` | the checkout is unchanged since pinning | AppPort integration present or absent, with file evidence |
| `discover` | `integration-inspected` (re-run at `capabilities-discovered`) | as above | outcome `discovered`, `no-integration` or `unavailable`; capabilities, interfaces, claims |
| `assess` | `capabilities-discovered` | as above; the assessment verifies and names the pinned SHA | assessment reference and digest; partial coverage |
| `reconcile` | `assessment-completed` (re-run until a candidate is planned) | current assessment and discovery | inventory (§5) |
| `select` | `inventory-reconciled` (re-run until approval) | the candidate is in the current assessment and eligible (`candidateRefusals`) | selection decision |
| `plan` | `candidate-selected`, `awaiting-approval` | exactly one reviewed extraction plan names the candidate; `createExtraction` accepts it without results (contract, mapping, adapter, fulfillment declaration, runtime, revision) | the validated proposal, digest |
| `request-approval` | `extraction-planned` | as above | a `generate-files` approval request for the current subject |
| `execute` | `awaiting-approval` | a granted, unconsumed approval of the **current** subject | runner log; the extraction artifact; the approval consumed |
| `verify` | `extraction-executed` (re-run later) | — | verification record (§6); the inventory recomputed with it |
| `ready` | `verification-completed` | verified **and** still fresh | promotion status `ready`, `deployed: false` |

A step re-run from a later stage returns the project to the step's own stage and clears the evidence later stages derived.

**Conditions.** Beside its stage a project is `active`, `partial` (it continues, with named gaps: `REVISION_NOT_ON_DEFAULT_BRANCH`,
`DISCOVERY_UNAVAILABLE`, `ASSESSMENT_PARTIAL`, `BEHAVIORS_NOT_PASSED`, …), `failed` (a step failed; only `resume` continues) or
`cancelled` (terminal; history and evidence are kept).

**The step protocol.** (1) The authority permits the principal the step. (2) The project is at a stage the step starts from, not cancelled
or failed, its checkout is still the pinned revision, and the action boundary's precondition holds (an approval of the current subject).
A refusal here creates no run and changes nothing. (3) A transaction fenced on the project's version creates the run and makes it the
project's active run; a second claim conflicts. A run whose lease expired is marked `abandoned` by the next claim. (4) The work runs
outside any transaction while the lease is renewed. (5) One transaction applies the outcome: the stage, the stage event, the new records,
the run's status. A failure is recorded the same way. If the project changed meanwhile (cancelled, or taken over), the outcome is kept on
the run as `not-applied` and nothing else is written.

**Resume** re-runs exactly the step that failed, or whose worker died, with the inputs it was started with. Completed steps are never
repeated. An action whose external effect was recorded on a run (a pull request) is adopted from that record, not performed again.

## 4. Repository acquisition

* The provider resolves the selected ref to a commit: **`@appport/github`** for GitHub (read capabilities `github.repository.read`,
  `github.branch.read`, `github.commit.read`, decided by the workspace authority), or plain git against a remote or a local mirror.
  `@appport/github` has no clone, fetch or push contract (reported, not invented): the resolved commit is fetched **by SHA** with git into
  a new repository per project and revision, with hooks, fsmonitor and submodules off, no LFS smudge and no prompts. Its origin is the
  canonical credential-free URL (the identity assessments record).
* **Credentials are references** (`env:NAME`), never values. A value is resolved in memory at the moment of use, passed to git in its
  environment as an HTTP header (never a command line or URL), and never written to FeltDB, an artifact, a run or a log. Reading and
  writing use separate references and separate capabilities.
* **Nothing from the repository is executed** by acquisition, inspection, discovery, assessment or reconciliation. The only step that
  runs anything is `execute`, which runs the reviewed extraction's runner after its approval.

## 5. Reconciliation

The inventory joins discovered capabilities (and capabilities a verified extraction of this revision provides) with every assessed
candidate. A match is graded by its evidence:

| Status | Evidence |
|---|---|
| `confirmed` | exactly one candidate is bound by an extraction **verified** for this revision (behaviors passed, declaration published and valid, still fresh) |
| `probable` | exactly one candidate has unverified evidence: an unverified extraction, an operator's recorded assertion, or, failing both, the only interface whose shape fits (same input properties and required inputs, output properties, effect) |
| `ambiguous` | more than one candidate has the strongest evidence present; no choice is forced |
| `unresolved` | no evidence, or discovery could not verify the capability |

Name similarity is a hint and never changes a status. Matching is not one-to-one. Every candidate is kept with its exposure (`exposed`,
`possibly-exposed`, `not-exposed`, or `unknown` when discovery did not run). Fulfillment claims found by discovery are judged with
AppPort's `claimsFor` and `evaluateFulfillment` when the canonical contract is available, and are otherwise `not-evaluated`, never valid.

## 6. Verification

`verify` checks the executed artifact with `verifyExtractionAt` against the current assessment, the pinned checkout and the adapter
sources, and requires: the same revision, assessment and selected candidate; the checkout unchanged since pinning; every required behavior
passed; and the reviewed extraction directory unchanged since the run. The record keeps the counts by target (real application, stub,
static). A verification is **fresh** only while the revision, checkout, assessment, extraction and extraction directory are all still the
ones it was made for; `ready` re-checks freshness (`VERIFICATION_STALE`).

## 7. Approvals and authority

Authority and approval are separate, and both are enforced at the action boundary, never by the page that offers an action.

* **Authority** is a port (`Authority.decide(principal, action, resource)`); the default is a local policy for a single operator on
  loopback. Actions: `project.read`, `project.create`, `project.advance`, `project.cancel`, `approval.grant:<action>`, `action:<action>`,
  `github:<capability>`. AppWorks defines no authorization semantics beyond naming them; an AuthBoundry deployment can stand behind the port.
* **Approval** is per action class, `generate-files`, `modify-integration`, `commit`, `push`, `pull-request`, `promote` (the flow's
  `approvals` policy), and per **subject**: a digest of exactly the inputs (for `generate-files`: revision, assessment, extraction, its
  directory digest and the validated plan). A changed input is a different subject, so an earlier approval does not cover it. An approval is
  consumed by the run that performs the action, once.
* A valid fulfillment claim is not a grant, and a verified extraction is not an approval for production: `ready-for-promotion` deploys
  nothing, and `promote` needs its own approval.
* `commit`, `push`, `modify-integration` and `promote` are enforced (authority, approval) and then refused as `UNSUPPORTED`: the extraction
  writes nothing to the target repository, `@appport/github` has no commit or push contract, and there is no deployment contract.
  `pull-request` opens a pull request through `@appport/github` with the write capability and write credential after an approval of that
  repository, revision, head and base.

## 8. Agents

The advisor explains the project's state and lists next actions from the recorded state by fixed rules. It needs no model, decides nothing,
and its suggestions pass through the same authority, preconditions and approvals as any request. Deterministic validators (the extraction
library, the boundary checks above) decide every transition.

## 9. Interfaces

* **Web workspace:** server-delivered pages on loopback only, rendered with the vendored stack-ui 0.5.0 static release (unmodified, checked
  against its `SHA256SUMS`), under a hash-pinned content security policy. Mutations require JSON, the `x-appworks-request` header and the
  server's own origin; unknown host names are refused. It acts as the operator who started it and has no network authentication
  boundary, and therefore no API keys.
* **CLI:** `appworks project …` and `appworks serve`; `appworks assess|verify|extract|verify-extraction` are `@appport/extraction`'s,
  unchanged. `appworks project show <id> --json` prints the same object `GET /api/projects/<id>` returns.

## 10. Jobs

The workspace does not use `@appport/services`' `JobService` (0.4.12). Its guarantees do not fit: a job left `running` by a dead worker is
never reclaimed (`FeltDbJobStore.claim` sets no `leaseOwner`, and `executeJob` refuses a running job whose `leaseOwner` differs, whatever
its lease), there is no lease renewal, handlers run before completion is recorded without idempotency keys, its store cannot share the
workspace's FeltDB handle, and its FeltDB store is not exported. The workspace's runs are the smallest safe replacement: a run record per
attempt, claimed in the same transaction that makes it the project's active run, a renewed lease, takeover after expiry, and completion
applied atomically with the project's stage. A run's status never decides a stage: the project record and its evidence do.
