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
| `AgentRun` | agent run on a project | agent identity (provider, implementation, model; never a credential), task, limits, lease, status, pause, outcome, usage, recorded agent switches; `Project.agentRun` names the run holding the project |
| `AgentTurn` | decision of an agent run | the proposed decision, validation problems, the action, the workflow run it started, the recorded result and its class; written `executing` before the action runs |

## 3. Workflow

The stages, in order (`workflow transformation` in `feltdb.flow`; each step's `to`):

`project-selected` → `repository-acquired` → `revision-pinned` → `integration-inspected` → (`integration-proposed` →
`integration-installed`, only for a revision without an AppPort integration) → `capabilities-discovered` →
`assessment-completed` → `inventory-reconciled` → `candidate-selected` → `extraction-planned` → `awaiting-approval` →
`extraction-executed` → `verification-completed` → `ready-for-promotion` → `contract-proposed` → `contract-adopted` →
`promotion-proposed` → `promotion-applied` → `promotion-verified` → `ready-for-review` → `submitted-for-review`

| Step | From | Precondition (validated evidence) | Records |
|---|---|---|---|
| `acquire` | `project-selected` | the provider resolves the ref to one commit | isolated checkout of exactly that commit; whether it is on the default branch |
| `pin` | `repository-acquired` | the checkout's HEAD is the resolved SHA | the checkout's content hash (every path, mode, mtime and byte, `.git` included) |
| `inspect` | `revision-pinned` | the checkout is unchanged since pinning | AppPort integration present or absent, with file evidence |
| `propose-integration` | `integration-inspected` (re-run at `integration-proposed`) | no AppPort integration in the revision | an AppPort installation proposal (§4a) and its digest; nothing written |
| `install-integration` | `integration-proposed` | re-deriving the proposal gives the same digest; a `modify-integration` approval of it; the pinned checkout unchanged; the destination clean | the files in an isolated worktree, the patch, the package install, the integration started and discovered; the approval consumed. Not verified: failed, evidence kept, approval unused |
| `discover` | `integration-inspected`, `integration-installed` (re-run at `capabilities-discovered`) | as above | outcome `discovered`, `no-integration` or `unavailable`; capabilities, interfaces, claims; how the origin was found (given, probed from the source, or the installed integration started) |
| `assess` | `capabilities-discovered` | as above; the assessment verifies and names the pinned SHA | assessment reference and digest; partial coverage |
| `reconcile` | `assessment-completed` (re-run until a candidate is planned) | current assessment and discovery | inventory (§5) |
| `select` | `inventory-reconciled` (re-run until approval) | the candidate is in the current assessment and eligible (`candidateRefusals`) | selection decision |
| `plan` | `candidate-selected`, `awaiting-approval` | exactly one reviewed extraction plan names the candidate; `createExtraction` accepts it without results (contract, mapping, adapter, fulfillment declaration, runtime, revision) | the validated proposal, digest |
| `request-approval` | `extraction-planned` | as above | a `generate-files` approval request for the current subject |
| `execute` | `awaiting-approval` | a granted, unconsumed approval of the **current** subject | runner log; the extraction artifact; the approval consumed |
| `verify` | `extraction-executed` (re-run later) | — | verification record (§6); the inventory recomputed with it |
| `ready` | `verification-completed` | verified **and** still fresh | promotion status `ready`, `deployed: false` |
| `propose-contract` | `ready-for-promotion` (re-run at `contract-proposed`) | the verification is verified and fresh | contract-adoption proposal (§11) |
| `adopt-contract` | `contract-proposed` | nothing blocks; re-deriving the proposal gives the same digest; an `adopt-contract` approval of that digest | adoption decision; the approval consumed |
| `propose-promotion` | `contract-adopted` (re-run at `promotion-proposed`) | the current proposal is the adopted one; the reviewed promotion plan matches the verified extraction | promotion artifact (§12) and its `Promotion` record (`proposed`) |
| `apply-promotion` | `promotion-proposed` | the artifact valid against everything it names; a `modify-integration` approval of its digest; the pinned checkout unchanged; the destination clean | the files written to an isolated worktree, the patch and its digest; `applied` |
| `verify-promotion` | `promotion-applied` (re-run later) | the worktree holds exactly the patch, applied under its approval | promotion verification; `verified` or `verification-failed` |
| `prepare-review` | `promotion-verified` | verified, and every input still what was verified | `ready-for-review` |
| `submit-review` | `ready-for-review` | a committed promotion and a `pull-request` approval of exactly that commit | refused: `UNSUPPORTED` (§10) |

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
* **No ref** means the repository's default branch (`HEAD`), resolved and recorded as that branch when the revision is acquired.
* **Discovery finds the running application itself.** Without an origin, `discover` takes the ports the pinned source names
  (configuration, compose files, Dockerfiles, scripts, READMEs, code; ranked, test fixtures discounted, the AppPort integration's own
  files first) as loopback origins, after any operator-configured `APPWORKS_DISCOVERY_ORIGINS`, and probes each through AppPort's
  discovery until one verifies. A host named in the source is never contacted: the source chooses at most a port, on this machine. The
  discovery record lists every probe and the source lines behind it; an origin given by a person overrides the search.
* **Nothing from the repository is executed** by acquisition, inspection, discovery, assessment or reconciliation. The only step that
  runs anything is `execute`, which runs the reviewed extraction's runner after its approval.

## 4a. Installing AppPort (`appworks.appport-installation/1`)

A revision without an AppPort integration can get one before discovery, so that its capabilities have somewhere to be published.

* **Proposal** (`install.ts`, a pure function of the repository identity and the pinned files): a new directory (`appport/`, or the
  first free of a short list) holding an AppPort application of its own: `package.json` pinning `@appport/sdk` at the version the
  workspace tests against, `server.mjs` (public discovery, loopback only, no capability yet, `APPPORT_PORT` overriding a default port the
  source does not already name), `.env.example`, `.gitignore`, `README.md`. Application id `com.<github|git>.<owner>.<name>`. No existing
  file is changed. The digest covers every file's bytes, and is the subject of the `modify-integration` approval.
* **Install** (approved): exactly those files are written to an isolated worktree of the pinned revision (never the pinned checkout),
  the patch is recorded, the packages are installed with `npm install --ignore-scripts` (no package code runs; only npm's own
  configuration is passed to it), the integration is started on a free loopback port with the allow-listed environment, discovered
  through AppPort's client, and stopped. It must verify as the proposed application; otherwise the step fails with the install record
  (output, discovery state) kept and the approval unused.
* **Discovery** of an installed integration starts it from its worktree for the discovery and stops it after.
* Nothing is committed or pushed. A promotion still targets an isolated worktree of the pinned revision: carrying an extracted
  capability into the newly installed integration is not done yet.

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
* **Approval** is per action class, `generate-files`, `adopt-contract`, `modify-integration`, `commit`, `push`, `pull-request`, `promote` (the flow's
  `approvals` policy), and per **subject**: a digest of exactly the inputs (for `generate-files`: revision, assessment, extraction, its
  directory digest and the validated plan). A changed input is a different subject, so an earlier approval does not cover it. An approval is
  consumed by the run that performs the action, once.
* A valid fulfillment claim is not a grant, and a verified extraction is not an approval for production: `ready-for-promotion` deploys
  nothing, and `promote` needs its own approval.
* Subjects: `generate-files` the revision, assessment, extraction directory and validated plan; `adopt-contract` the adoption
  proposal's digest; `modify-integration` the promotion artifact's digest; `commit` the promotion and patch digests; `push` and
  `pull-request` (for a promotion) the promotion, patch, commit, branch and base. Subjects are AppPort `digestOf` (RFC 8785) digests.
* `modify-integration` (applying a promotion to an isolated worktree, and running its declared verification) and `commit` (a local
  commit in that worktree) are supported. `push`, submitting for review and `promote` are enforced (authority, approval) and then refused
  as `UNSUPPORTED`: `@appport/github` 1.0.2 has no push, commit or compare contract, the workspace does not push with git behind it, and
  there is no deployment contract. The generic `pull-request` action opens a pull request through `@appport/github` (write capability,
  write credential) for an existing head branch, after an approval of that repository, revision, head and base.

## 8. Agents

The **advisor** explains the project's state and lists next actions from the recorded state by fixed rules. It needs no model, decides
nothing, and its suggestions pass through the same authority, preconditions and approvals as any request.

An **agent run** drives the workflow autonomously (`src/agent/`). The agent proposes; AppWorks validates, authorizes and executes.

* **Contract (`appworks.agent/1`, `src/agent/contract.ts`).** One decision per call. The request (`appworks.agent-request/1`) carries
  the run and turn, the task, a compact credential-free view of the project's recorded state (with the advisor's suggestions marked
  advisory), the actions offered now with a JSON Schema each, the history of earlier decisions with what was actually recorded, and the
  constraints (remaining turns, rules). The response (`appworks.agent-response/1`) is exactly one of: request an offered action with
  arguments and a rationale, ask a person, or finish (`done`, `blocked` with blockers, `nothing-to-do`); with optional usage. An adapter
  declares its identity (provider, implementation, model) and capabilities (stateful sessions, cancellation, usage, local, model), honors
  an `AbortSignal` and a time bound, and reports every failure as an `AgentError` of one kind (`invalid-output`, `timeout`,
  `rate-limited`, `transient`, `authentication`, `configuration`, `cancelled`, `refused`, `unknown`) with retry guidance. The history
  in the request is authoritative; a stateful agent may keep its own state but must accept it. Single-decision, multi-turn, stateful,
  stateless, local and remote agents all fit this one shape: the multi-turn loop is the orchestrator's.
* **Validation before anything runs.** The response format, the decision's shape, that an action was offered in this turn, and its
  arguments against the action's schema (`@appport/schema`). An invalid decision executes nothing; it is recorded and returned to the
  agent; three in a row fail the run (`AGENT_OUTPUT_INVALID`).
* **Action registry (`src/agent/actions.ts`).** Each action has a versioned id, an argument schema, the authority it needs, its
  side-effect class (`none`, `workspace-state`, `external-read`, `executes-target-code`, `isolated-write`, `local-commit`), the approval
  its boundary requires, whether it is safe to repeat, a time bound, and the class of its result. Workflow actions
  (`workflow.<step>@1` for the flow's steps except `create` and `submit-review`, plus `workflow.commit@1` and `workflow.resume@1`) go
  through `Workspace.dispatch`, the CLI's and the web's own path, so the step's authority, stage, claim, lease, evidence and approval
  checks all apply. Read actions (`source.list@1`, `source.read@1`, `source.search@1`, `evidence.read@1`, `candidate.inspect@1`) read the
  pinned checkout or recorded evidence, bounded, refusing paths that may hold credentials (`.env*`, keys, `.git`, credential files) and
  any path that leads outside the checkout, and redacting anything that looks like a credential. There is no shell, file write, network
  tool, approval or cancellation action.
* **Approvals.** An action whose boundary refuses it for want of an approval (`APPROVAL_REQUIRED`) pauses the run with the approval and
  the exact subject the workflow derives; a person approves it (`appworks project approve`), and resuming lets the agent request it
  again. A changed subject pauses again. The agent can neither approve nor see an approval it could replay.
* **Results and evidence classes.** A turn's result is what AppWorks recorded: `workflow-record` (a workflow run and the evidence ids it
  produced), `source-observation` or `workspace-read` (read-only; evidence for no stage), `human-answer`, or `none`. An agent's rationale
  and its claimed outcome are recorded as the agent's words, never as evidence: a run's outcome carries the project's actual stage and
  condition beside what the agent claimed.
* **Orchestrator (`src/agent/runner.ts`).** Each turn reads the durable state, computes the eligible actions from the flow, asks for
  one decision (bounded by `decisionTimeoutMs` even for an adapter that ignores its signal; retried up to `maxRetries` only for a
  retryable failure, honoring a provider's retry-after; never handed to another provider), validates it, records the turn as
  `executing`, executes it, and records the result. It waits while another worker's step holds the project. It stops at `finish`
  (`completed` or `blocked`), at a question or an approval (`paused`), at `maxTurns` (`exhausted`), on a stop request (`cancelled`), when
  the project is cancelled, or on a non-retryable agent failure (`failed`, with the error kind; an authentication failure is never
  retried and never falls back).
* **One run per project, and recovery.** Starting a run claims the project (`Project.agentRun`, fenced on the project's version, refused
  while a step runs); a second start is `AGENT_RUN_IN_PROGRESS`, `AGENT_RUN_PAUSED` or `AGENT_RUN_INTERRUPTED`. A worker renews the
  run's lease; a run whose lease expired is interrupted and may be resumed by any worker. Resuming reconciles a turn left `executing`
  from the workflow's own `Run` records: a step that completed is recorded as completed (not repeated), one that failed as failed, one
  that never claimed a run as not started, and one whose run still holds the project as interrupted (the workflow's resume handles it).
  The agent then decides from that. Stopping a run aborts its decision in flight; a workflow step in flight finishes under its own lease
  and is recorded. Stopping never cancels the project.
* **Agent selection and switching.** `APPWORKS_AGENT_PROVIDER` (`anthropic`, `openai`, `deterministic`) and `APPWORKS_AGENT_MODEL`
  choose the agent; nothing is inferred from which keys are set; a missing provider, model or key is refused by name
  (`AGENT_NOT_CONFIGURED`, `AGENT_MISCONFIGURED`, `AGENT_UNAVAILABLE`). `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are read from the
  environment (or `.env.local`, optional, never printed) when the adapter is made and kept only there; the SDKs read nothing from the
  environment themselves. Limits: `APPWORKS_AGENT_TIMEOUT_MS`, `APPWORKS_AGENT_MAX_TURNS`, `APPWORKS_AGENT_MAX_RETRIES`,
  `APPWORKS_AGENT_MAX_TOKENS`. Each run records its agent's identity. Resuming with a different agent is refused
  (`AGENT_SWITCH_REQUIRED`) unless the switch is explicit; it is then recorded on the run (`switches`).
* **Adapters.** `appworks-anthropic@1` (Messages API, a forced tool choice), `appworks-openai@1` (Responses API, a required function
  call, `store: false`), `appworks-deterministic@1` (follows the advisor; no model, no network; never retries a failed action) and the
  scripted fake for tests. Each is stateless: the request is sent whole. SDK retries are off; the orchestrator's policy is the only one.
  All pass one conformance suite (`test/agent-conformance.test.ts`) through each SDK's `fetch` option, so CI needs no credential.
* **Stack-Agent.** Not integrated. It would be one more adapter behind `appworks.agent/1`: a decision-only mode that returns one
  decision for a request and executes nothing itself (its `work` mode executes its own capabilities, which AppWorks must not delegate).
* **Secrets.** Configured keys are scrubbed, with credential-shaped text, from every request, turn and run record. No key is in
  persisted configuration, agent context, evidence or a report.

## 9. Interfaces

* **Web workspace:** server-delivered pages on loopback only, rendered with the vendored stack-ui 0.5.0 static release (unmodified, checked
  against its `SHA256SUMS`), under a hash-pinned content security policy. Mutations require JSON, the `x-appworks-request` header and the
  server's own origin; unknown host names are refused. It acts as the operator who started it and has no network authentication
  boundary, and therefore no API keys.
* **Agent:** `appworks agent run|status|stop|resume|check` and the web workspace's Agent section call the same operations
  (`src/agent/operations.ts`); `appworks agent status <id> --json` prints the object `GET /api/projects/<id>/agent` returns, and
  `POST /api/projects/<id>/agent/{start,stop,resume}` take the same inputs.
* **CLI:** `appworks project …` and `appworks serve`; `appworks assess|verify|extract|verify-extraction` are `@appport/extraction`'s,
  unchanged. `appworks project show <id> --json` prints the same object `GET /api/projects/<id>` returns.

## 10. Jobs, and GitHub

The workspace does not use `@appport/services`' `JobService` (0.4.12). Its guarantees do not fit: a job left `running` by a dead worker is
never reclaimed (`FeltDbJobStore.claim` sets no `leaseOwner`, and `executeJob` refuses a running job whose `leaseOwner` differs, whatever
its lease), there is no lease renewal, handlers run before completion is recorded without idempotency keys, its store cannot share the
workspace's FeltDB handle, and its FeltDB store is not exported. The workspace's runs are the smallest safe replacement: a run record per
attempt, claimed in the same transaction that makes it the project's active run, a renewed lease, takeover after expiry, and completion
applied atomically with the project's stage. A run's status never decides a stage: the project record and its evidence do.

## 11. Contract adoption (`appworks.contract-adoption/1`)

A probable or confirmed match is not an adopted contract. `propose-contract` makes an explicit, versioned proposal to adopt the verified
extraction's canonical contract into the target's integration, from: the extraction artifact (its contract, the assessment's
source-inferred proposal, the plan's mapping and decisions, its authorization restrictions, its verification records and their subject,
its questions and limitations), the assessed candidate (source evidence), the current contract and fulfillment declaration files, the
discovery record, the inventory, and the reviewed question dispositions of the promotion plan.

* **Differences.** Every `compareSchemas` difference from the source-inferred proposal; every mapping decision; the authority the
  contract requires and each restriction; the effect; and every existing AppPort declaration that may be the same capability (reconciled
  with the candidate, claiming the same canonical capability, or merely sharing its name). Each states its impact (`security`,
  `correctness`, `contract`, `compatibility`, `process`) and its support: `verified` (behaviors covering it passed, for exactly this
  contract), `source-evidence`, `explained` (a reviewed reason only) or `unknown`.
* **Validation**, with AppPort's and the extraction library's own checks: the contract is a canonical contract (`isCanonicalContract`,
  `contractProblems`); its `contractDigest` and `capabilityDigest` are the ones the extraction verified (a changed contract invalidates
  the verification); the declaration as it is now passes `fulfillmentProblems` and is the one verified; the extraction artifact verifies;
  every required behavior passed.
* **Blocking.** Any validation problem; an `unknown` difference with security, correctness or contract impact; an incompatible existing
  declaration (any `breaking` `compareSchemas` change, or another effect), or one whose schemas were not recorded; an open question with
  security, correctness or contract impact. A blocked proposal stays visible, keeps the project `partial`, and cannot be approved.
* **Adoption** needs an `adopt-contract` approval of the proposal's digest. `adopt-contract` re-derives the proposal from the current
  inputs and refuses (`ADOPTION_STALE`) if the digest differs. Adoption means the contract is published by the target's own integration
  (a promoted file); AppWorks registers it nowhere. It grants no authority and is not an equivalence claim (`scope`).

## 12. Promotion (`appworks.promotion/1`)

A promotion describes one integration change: a reviewed **promotion plan** (`<extraction>/promotion/promotion-plan.json`,
`appworks.promotion-plan/1`) names which of the extraction's files are added to the target, where, and which are not (with reasons), the
verification runner, the target lockfile to check runtime requirements against, and the dispositions of the extraction's questions. The
workspace generates no code.

**Content.** Source repository and pinned revision; project; provider capability and adopted contract (both digests); assessment digest
and candidate; extraction (name, digest, format, identity, adapter digest); adoption digest; fulfillment declaration digest; runtime;
runtime requirements against the target's lockfile at the base (`met` per package); the promotion plan's digest; the target (base,
directory, every file with its source, role, mode, sha256 and size, the excluded files, `add-only`); the verification the promoted copy
must pass (the required behaviors, **the extraction's own verification subject**, the target each behavior passed against, the runner and
its sha256, the host directory, whether mutants run); the approvals each later action needs, and which are supported; what executes;
limitations and questions; `scope` (no authority, no existing file modified, no commit, push or deployment). No timestamp or run
identifier: the digest (`digestOf` over everything else) is the same for the same inputs.

**Integrity rules.** Every `adapter` and `declaration` file must be byte-for-byte a file the extraction verified (its digest equals the
extraction's adapter file digest); the `contract` file must have the verified contract and capability digests; every verified file is
promoted or excluded with a reason; a contract and a declaration must be promoted. Before use the artifact is checked against its own
digest and against the current state, refusing with `PROMOTION_DIGEST_MISMATCH`, `PROMOTION_REVISION_STALE`,
`PROMOTION_EXTRACTION_MISMATCH`, `PROMOTION_ADOPTION_MISMATCH`, `PROMOTION_SOURCE_CHANGED` or `PROMOTION_PATH_INVALID`. The extraction
artifact is never modified.

**Lifecycle** (the `Promotion` record, never the artifact): `proposed` → `approved` (a `modify-integration` approval of its digest) →
`applied` (the isolated worktree holds exactly its files; patch recorded) → `verified` or `verification-failed` → `ready-for-review`;
`submitted-for-review` is declared and not reachable (§7). A local commit is recorded on the record without changing its state.

**Applying.** The worktree is a fresh repository at the base revision, fetched from the pinned checkout (which is only read), one per
promotion. Before writing: the artifact is valid; the approval is of its digest; the pinned checkout is still the pinned revision; the
worktree is at the base and holds nothing but approved files with approved bytes (`DESTINATION_DIRTY` otherwise); the authority is
checked again. Only the artifact's files are written, each only if absent. After writing, the complete diff is inspected: any path outside
the approved set (`PATCH_OUTSIDE_APPROVED_SET`), any operation but an addition, any missing or different file refuses, and the patch as
found and the reasons are kept. The patch digest is `digestOf` of the base and each file's path, mode and sha256; the full `git diff` is
stored for review.

**Verifying.** The promotion's runner (`--repo <worktree> --host <dir> --output <file> [--mutations]`) runs the extraction's own
behavioral suite against the promoted copy, and the mutation check against copies of it. The suite records results only if the host
directory is a byte-for-byte copy of the verified host, adapter, declaration and contract. The promotion is `verified` only if the
results' subject equals the extraction's, digest for digest; every required behavior passed against the same target as before; every
mutant was caught; and the worktree is exactly the patch before and after. Otherwise `verification-failed`, with reasons, and the patch
kept.

**Recovery.** Runs, leases and resume are the workflow's (§3). A resumed `apply-promotion` inspects the worktree first and writes only
what is absent; a resumed `commit` finds a commit that is exactly the patch on the base and adopts it, and refuses anything else.

**GitHub operations** (`@appport/github` 1.0.2, unchanged since the previous milestone; its repository's HEAD is that release):
supported are ref, repository, branch and commit reads (acquisition) and opening a pull request for an existing head branch. Not
supported, and refused rather than simulated: fetching content (the workspace fetches the resolved commit with git), comparing
revisions, fork parentage, creating commits and pushing. A safe remote promotion needs, at minimum, `repositories.compare`, the
repository's `parent`, and a commit-and-push operation (or the git data API) under its write capability; those need a release of
`@appport/github`, which should also move it to the current AppPort stack (`@appport/protocol` 1.2.0) and FeltDB, removing the second
stack it brings today.
