# AppWorks roadmap

Audited against the source at `47a356e` (main, 2026-10-21). Every status below was checked in code, tests or CI, not taken from
documentation. Where code and documentation disagree, the code is the record and the disagreement is listed in §2.

## 1. Intent

Two entry points converge on one model of canonical capabilities and immutable packages (`docs/charter.md`):

* **Path A, new business processes.** Define capabilities, compose them into a recipe, package it, **execute it, verify the business outcome.**
* **Path B, existing applications.** Inspect an application, expose its behavior as capabilities, verify them, package them, prepare a safe
  change, **replace the implementation incrementally while the recipe stays unchanged.**

Two end-to-end outcomes drive all prioritization. Everything else is ranked by how directly it advances them.

* **Outcome A:** a recipe is authored, packaged, acquired in another environment, executed durably, and its business outcome independently verified.
* **Outcome B:** one real capability of an existing application is replaced, proven contract-equivalent, with the surrounding process unchanged.

## 2. Audit: what is true, what is overstated, what is wrong

Baseline run: `pnpm build`, `typecheck`, `boundary:check`, `release:check` pass. `pnpm test`: 27 files / 275 tests pass, 3 files / 5 tests
skipped (see C5). CI on `47a356e`: both jobs (`check`, `memos`) succeed. Three earlier main pushes (`9737baa`, `777984a`, `75c9660`) had a failing `check` job.

### Confirmed

| Claim | Evidence |
|---|---|
| Recipe model, expressions, validation, locks, content-addressed source package | `packages/recipe/src/{source,expression,validate,lock,package}.ts`; 4 test files |
| No compiler, no runtime | `package.ts:35-37,147,192` refuses kind `compiled`; no execute/interpret code anywhere in `packages/recipe`; `grep -i recipe packages/workspace/src` is empty |
| Distribution boundary only | `recipe-distribution/src/index.ts`: `recipeReleaseManifest` and `acceptAcquiredRecipePackage`; its own header says "Not here: fetching, registries, publishing, receipts" |
| Assessment analyzes Go and Protocol Buffers only | `assessment/src/analyze.ts:52-63,204,218`; other languages counted, finding `LANGUAGE_UNSUPPORTED` |
| Extraction is read-only request/response | `extraction/src/extract.ts:72-74` refuses non-observation, outbound HTTP, async and streaming candidates; `artifact.ts:349` |
| Workspace workflow, FeltDB state, fenced transactions, leases, resume | `workspace/feltdb.flow`; `store.ts` (`requireAbsent`/`ifVersion`); `spec/workspace-1.md` §1-3; `workflow.test.ts` crash/concurrency cases pass |
| Web and CLI share one domain | `cli.ts`, `server.ts` both call `Workspace`; `surface.test.ts`, `server.test.ts` |
| Agent runtime with Anthropic, OpenAI, deterministic, fake adapters; validation, approvals, recovery | `workspace/src/agent/**`; `agent*.test.ts`; the agent cannot approve (no such action) |
| Contract adoption, promotion artifact, isolated apply, verification with mutants, local commit | `adoption.ts`, `promotion.ts`; `promotion.test.ts` (14 tests pass) |
| Memos 17/18 then 21/21; failure kept in history | `extractions/memos-reactions/revisions/{1,2}`; CI `pnpm extraction:memos --check --mutations` is green |
| Deployment not implemented | no deployment code or contract anywhere |
| Visual Recipe Studio not implemented | the UI (`ui.ts`, `view.ts`, vendored stack-ui) is project/workflow/agent only; no recipe code in the workspace |

### Corrections to the earlier assessment

| # | Earlier statement | Ground truth |
|---|---|---|
| C1 | "Push and pull-request submission: not implemented" | **Split.** `pullRequest()` is implemented (`workflow.ts:1356-1378`): approval bound to head+base, idempotent by title adoption, a resumed run never opens a second one, tested in `workflow.test.ts`. **Push is not**: `submit-review`, `push` and `promote` are approved-then-refused `UNSUPPORTED` (`workflow.ts:1346,1387-1400`). Net effect: a PR can only be opened for a branch that already exists on GitHub, and nothing in AppWorks can put it there. `docs/charter.md` still lists "pull requests for a promotion" as not implemented, which is also stale. |
| C2 | The workflow "discovers, selects, plans and executes an extraction" as a general capability | **It executes only hand-authored, reviewed extraction directories.** `workflow.ts:640-641`: "no reviewed extraction plan exists for X; the workspace does not generate one". `runner.ts:2-3`: "The workspace generates no code". The only directory in `extractions/` is `memos-reactions`. So the plan, adapter, host, behavioral suite and promotion plan for the one demonstrated operation were written by hand. For any other candidate the workflow stops at `plan`. This is the largest gap on Path B and was not named. |
| C3 | "Install and expose capabilities" described as progress on extraction | The install path (`install.ts`, `surface.ts`) adds a **new AppPort proxy app** whose capabilities each forward to one HTTP route (regex route scan + agent proposals with verified citations). That is exposure, not extraction: no contract mapping, no adapter into the app's boundary, no behavioral verification, no fulfillment claim. It is also independent of the Go/Protobuf-only assessment; keep the two distinct. |
| C4 | "A CI run for the new main commit could not be established" | It can: run `39530008229` on `47a356e` succeeded in both jobs, including the real-Memos job. |
| C5 | Memos end-to-end is a proven, reproducible workflow | True in CI only. The default `pnpm test` skips it (`memos-e2e.test.ts` needs `APPWORKS_MEMOS_E2E=1` and a Memos checkout), as it does the Aider run and live-model conformance. The default suite exercises the workflow on a **synthetic notes service with stub runners**. The Memos result also depends on the fork `rkendel1/memos@e0ce856` (bridge pass-through) that is **not merged upstream**. The Aider run (`APPWORKS_AIDER_E2E`) has no recorded result in the repo. |
| C6 | "Package versions and lockfile reproducibility" implied healthy | `@appport/recipe` and `@appport/recipe-distribution` 0.1.0 are on npm. `@appport/assessment` and `@appport/extraction` return 404, though `docs/compatibility.md` presents all four as released libraries and `release:check` installs the CLI. Either they are unpublished (then the docs overstate) or the registry state is wrong; resolve in Phase 0. |
| C7 | Gap 6 (Compute) | Not auditable from this repository. Nothing here is Compute-specific; the dev loop works locally (above). Treat as an environment task with its own acceptance, not a product gap. |

### Not previously stated, found in the audit

* The workspace is private because `@appport/github` 1.0.2 drags in a second, older AppPort/FeltDB stack (~77 packages): the delivery
  boundary is blocked on an **upstream** change, not only on AppWorks work (`docs/compatibility.md` §3).
* No authentication boundary on the web workspace: loopback only, acts as the OS user (`spec/workspace-1.md` §9). Fine for local use, a blocker for any hosted or shared deployment (including Compute).
* Verification of the promoted Memos copy relies on stub runners in the default suite; real-runner coverage is the CI `memos` job.

### Status ladder (per capability, at `47a356e`)

Legend: I implemented, U unit-tested, X integration-tested, E end-to-end demonstrated on real services, P production-ready. `-` not yet.

| Capability | I | U | X | E | P | Note |
|---|---|---|---|---|---|---|
| Recipe model, validation, locks, source package | Y | Y | Y (real `@appport/core` resolution) | - | - | never executed |
| Distribution acceptance (bytes -> accepted package) | Y | Y | - | - | - | no publish/acquire |
| Recipe compiler / runtime | - | - | - | - | - | |
| Assessment (Go + proto) | Y | Y | Y | Y (Memos) | - | one real app |
| Route scan + agent-cited proposals | Y | Y | Y | - | - | Aider run unrecorded |
| Read-only extraction + verification | Y | Y | Y | Y (Memos x1) | - | hand-authored per operation |
| Workspace workflow, durability, approvals | Y | Y | Y | Y (Memos, CI only) | - | |
| Agent runtime | Y | Y | Y | partial | - | live-model tests opt-in |
| Contract adoption, promotion, local commit | Y | Y | Y | Y (Memos) | - | |
| Open PR | Y | Y | - | - | - | fake provider only |
| Push, deployment | - | - | - | - | - | |
| Write extraction, portable implementations, replacement, migration | - | - | - | - | - | |
| Visual Recipe Studio | - | - | - | - | - | |

## 3. Roadmap

Order: **0 -> 1 -> (2 and 3 in parallel) -> 4 -> 5 -> 6**. Phases 2 and 3 are independent (different packages, different boundaries) and
Phase 3 is the first outcome-A proof, so it must not wait on delivery. Each phase ends only when its exit test runs in CI, not on a
developer machine.

### Phase 0: Trustworthy baseline (small; start now)

Goal: main is green by construction, the docs say what the code does, and the environment is reproducible.

| # | Task | Done when |
|---|---|---|
| 0.1 | Make `memos` e2e part of the documented local loop: one script (`pnpm verify:all`) that runs build, typecheck, tests, boundary, release check and, when `APPWORKS_MEMOS_REPO` is set, the Memos jobs | one command, same result as CI |
| 0.2 | Branch protection on `main` requiring `check` and `memos` (three recent main pushes were red) | a red PR cannot merge |
| 0.3 | Fix stale docs: charter row for PRs (C1), compatibility "released libraries" vs npm state (C6); add this roadmap's status ladder to the charter's table | `rg "not implemented"` matches the code |
| 0.4 | Resolve npm state of `@appport/assessment` and `@appport/extraction` (publish with `pnpm publish:packages`, or mark unreleased in docs) | `npm view` agrees with `compatibility.md` |
| 0.5 | Record the Aider e2e result (run it, commit the outcome as a dated finding, not as a pass claim) | what the workflow does on a non-Go app is documented |
| 0.6 | Compute: document required env (Node 22, pnpm 10.33, git, Go for Memos, network for `@appport/github`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` optional), run `pnpm verify:all` and `pnpm serve` there, record gaps | repeatable from a clean container; auth gap in §2 noted for any non-loopback exposure |

### Phase 1: Make Path B honest and general enough (the critical path for outcome B)

Goal: remove the "one hand-authored extraction" ceiling (C2) without weakening the evidence model.

| # | Task | Notes |
|---|---|---|
| 1.1 | **Extraction authoring as a first-class, reviewed workflow.** From a selected candidate, generate a *proposed* plan, contract, adapter skeleton, fulfillment declaration and behavioral suite as reviewable files; they enter the existing approval path (`generate-files`) and are never trusted until verified. Today `PLAN_MISSING` is the dead end | the generated artifacts reuse `createExtraction` validation; nothing is verified by generation |
| 1.2 | Second real extraction: a different operation in Memos (a non-trivial request shape) to prove 1.1 is not Memos-reactions-specific; then one in another Go service | exit test below |
| 1.3 | Assessment coverage: add TypeScript/JavaScript (Express/Fastify/Nest routes) and Python (FastAPI/Flask/Django) analyzers behind a new scanner version (`appport.assessment-scanner/2`), keeping facts/inferences/unknowns discipline; reconcile with `surface.ts` route scan so the two do not diverge | scanner version bump per `compatibility.md` §1 |
| 1.4 | Hardening cases the workflow does not yet test against real runners: expired leases mid-`execute`, changed pinned revision between approval and execute, tampered promotion inputs, approval refusal (these exist on the synthetic service; repeat them on the Memos runner) | add to the `memos` CI job |
| 1.5 | Readiness and capability status in the UI/CLI is computed only from recorded evidence; add a test that every displayed status maps to a record id | prevents optimistic labels |

Exit: from a clean checkout, a user takes two different operations in two different applications (at least one not Go-only-assessed
by hand) through assess -> plan -> approve -> extract -> verify -> adopt -> promote -> commit locally, with generated rather than
hand-written extraction directories, with every failure recorded and recoverable. Run in CI.

### Phase 2: Delivery boundary (parallel with 3; partly upstream)

| # | Task | Notes |
|---|---|---|
| 2.1 | Specify push (and commit/compare) as an AppPort-side contract: either extend `@appport/github` or add a sibling provider. **Upstream dependency**; decide the owner before coding | AppWorks must not shell out to `git push` from the workspace as a shortcut around the authority model |
| 2.2 | Implement the `Repository` provider push behind `submit-review`: approval bound to commit + branch + remote + base; verify the remote ref after the push; record the actual remote result | crash between push and record must adopt, not repeat (mirror the PR title-adoption pattern) |
| 2.3 | Replace `UNSUPPORTED` for `push`/`submit-review` with the real path; PR open becomes reachable end to end | `workflow.ts:1346,1387` |
| 2.4 | Real-GitHub integration test on a throwaway repo (opt-in job) in addition to the fake provider | closes the "PR open is fake-provider only" row |
| 2.5 | Define what makes a verified, merged change eligible for deployment; **deployment stays a separate, later capability** | write the contract note; no code |
| 2.6 | Unblock publishing the workspace: drop the second `@appport/*` stack once `@appport/github` is on the 1.x line used here | tracked in `compatibility.md` |

Exit: an approved, verified promotion is committed, pushed, and opened as a PR on a real remote, with each transition recorded, and a
crash injected after each of push and PR-create produces no duplicate.

### Phase 3: Recipe compiler and runtime (the critical path for outcome A)

> **Status (feat/recipe-runtime):** 3.1 (`spec/runtime-1.md`), 3.2, 3.3 (subset: `copy`/`const`/`compute`; others refused), 3.4, 3.5 (API only), 3.6 and
> 3.8 (`run`/`status`/`resume`; no `answer`) are implemented in `@appport/recipe-runtime` and tested against the supplier-invoice recipe and a
> persisted test ledger, including the lost-response and crash cases. 3.7 is partial: the provider and fault injection exist, but the contract is
> still the example's illustrative one, registered only in the test registry, not published. Still open before the Phase 3 exit: the kill-at-
> every-step-boundary matrix (three points are covered), reconciliation of `uncertain` runs, a remote gateway, and a published contract.

Design constraints (from the charter and `spec/recipe-1.md`): no embedded code, closed vocabulary, uncertainty never retried
implicitly, recipes name capabilities not providers, a lock grants nothing. Reuse AppPort resolution/invocation and FeltDB; do **not**
reuse or fork the transformation workflow in `packages/workspace`.

| # | Task | Notes |
|---|---|---|
| 3.1 | Runtime design spec (`spec/runtime-1.md`) before code: instance model, step protocol, effect classes, idempotency keys, uncertain-outcome routing, human-task model, lease/recovery, evidence records. Decide what is shared with the workspace's primitives (leases, fenced writes, approvals) by extracting them into a small internal package rather than copying | review gate |
| 3.2 | New package `@appport/recipe-runtime` (own `feltdb.flow` for `RecipeRun`, `StepAttempt`, `HumanTask`, `Invocation`, `Verification`) | does not import `@appport/workspace` |
| 3.3 | Interpreter for the closed vocabulary: typed inputs, expression evaluation, mappings/transformations, branches, outcome routes | the validator in `@appport/recipe` is the only gate; runtime refuses an unvalidated recipe |
| 3.4 | Capability invocation through `@appport/core` resolution + binding + grants from the lock/environment; record every invocation with its idempotency key | |
| 3.5 | Human tasks: persist, assign by role, answer/reject/timeout routes; resume after restart | |
| 3.6 | Verification and recovery: per-operation read-back, independent final-outcome verification, crash at every step boundary resumes without repeating a consequential effect; an indeterminate submit routes to `uncertain`, never success | the key safety property |
| 3.7 | Real test provider: a small accounting application fulfilling a **real canonical contract** (replace the illustrative `org.example.accounting`) with `find-duplicate`, `submit-invoice`, `get-invoice`, with fault injection (drop the response after commit) | contract must actually be published/registered via AppPort |
| 3.8 | CLI `appworks recipe run|status|answer|cancel` over the runtime; no UI yet | |

Exit (in CI): the supplier-invoice recipe runs against the real test provider; covers validation reject, duplicate reject, auto path,
approval path, rejection, and no-answer; survives a kill at each step boundary; verifies ledger state independently; a dropped
submit response yields `uncertain` and is not retried; swapping the provider implementation under the same contract leaves the recipe
byte-identical and the run passing.

### Phase 4: Package distribution (needs 3)

| # | Task |
|---|---|
| 4.1 | Publish: build package, `recipeReleaseManifest`, sign and publish through Distribution Protocol's own tooling; record provenance (source revision, tool versions) |
| 4.2 | Acquire: fetch by product identity, run `acceptAcquiredRecipePackage` with a trust policy, write an installation receipt (separate from authorization) |
| 4.3 | Install into an environment: resolve dependencies through AppPort, create the lock for that environment, refuse on incompatibility |
| 4.4 | Run from the **acquired** package, never the source checkout |

Exit: environment 1 publishes the supplier-invoice package, a separate environment (fresh FeltDB, different provider) acquires,
verifies, installs and executes it; tampering with any byte, signature or binding is refused at the named stage.

### Phase 5: Visual Recipe Studio (needs 3; 4 for the package action)

The UI edits the canonical `appport.recipe/1` document and calls the same `validateRecipe` / package functions as the CLI; it has no
model of its own.

| # | Task |
|---|---|
| 5.1 | Read-only recipe viewer: graph of steps, branches, human tasks, dependencies, unresolved requirements, findings from `validateRecipe` |
| 5.2 | Editing with continuous validation; capability discovery panel backed by AppPort discovery |
| 5.3 | Mapping and condition editors over the typed expression language |
| 5.4 | Package action producing the same digest as the CLI (test asserts byte equality) |
| 5.5 | Run view: execution state and evidence from the runtime |
| 5.6 | Authentication boundary for the web server before any non-loopback hosting |

Exit: the supplier-invoice recipe is created in the Studio from empty, validates, shows its unresolved dependencies, and packages to
the same digest as the checked-in recipe via the CLI.

### Phase 6: Replacement and migration (outcome B)

Depends on Phase 1 (generated extractions) and Phase 3 (a recipe to keep stable). Split into independently shippable slices:

| # | Task |
|---|---|
| 6.1 | Effect model for writes: declare effect class, idempotency, authority/credential propagation; extend the contract mapping and verification vocabulary beyond `observation` |
| 6.2 | Write-capability extraction with side-effect verification against a disposable environment (state before/after, error paths, authorization) |
| 6.3 | Independent implementation: generate a portable implementation of one capability from the extraction's contract and behavioral suite (the suite from 1.1/6.2 is the specification) |
| 6.4 | Equivalence check: run the same suite against old and new; compare authorization, errors, side effects, data integrity |
| 6.5 | Migration plan artifact (`appworks.migration/1`): ordered steps, dependencies, rollback constraints, each step leaving a working app |
| 6.6 | Incremental cutover behind the AppPort capability: resolution flips providers; recipe untouched |
| 6.7 | Post-cutover verification and rollback test |

Exit: replace one real capability (start with the read-only Memos reactions op, then one write), prove the replacement satisfies the
same contract digest, and show the Phase 3 recipe that calls it passes unchanged before and after.

## 4. Acceptance projects

1. **Supplier-invoice (outcome A).** Phases 3, 4, 5. The 15-step scenario in the earlier proposal is the acceptance script; steps
   1-2 and 14-15 additionally depend on 3.7 and 6.6.
2. **Memos (outcome B, read path).** Keep as a permanent regression: `pnpm extraction:memos --check --mutations` plus
   `memos-e2e.test.ts`. A passing Memos run does not count toward Phase 1 or 6 exits on its own.
3. **Second application (outcome B, generality).** Phase 1.2 picks it; it must not be Go-and-proto-only by luck of selection.

## 5. Rules for keeping this honest

* A phase is done when its exit test runs in CI on `main`; a local pass is not done.
* Every row in the status ladder moves one column at a time and cites the test or run that justifies it.
* Docs change in the same PR as the behavior (task 0.3 fixes the existing drift).
* New capability claims in the charter table need a linked test; unknowns stay listed as unknowns.
* Do not add a second authority, persistence layer or evidence format (charter principle 2): shared primitives are factored out, not copied.

## 6. Open decisions needed from the owner

1. Who owns the push/commit contract: extend `@appport/github` (upstream) or a new provider? Blocks 2.1.
2. Is the Compute environment expected to run the web workspace for more than one operator? If yes, 5.6 moves ahead of Phase 2.
3. Which second application for 1.2, and is a non-Go service a hard requirement for Phase 1's exit?
4. npm: are `@appport/assessment` and `@appport/extraction` meant to be public now (0.4)?
