# AppWorks roadmap

Re-audited on 2026-10-21 against `main` at `7d8df89` plus the distribution slice (#13) and the Recipe Studio slice (this PR, on top of it). Every status was checked in code,
tests or CI, not taken from documentation. Where code and documentation disagree, the code is the record. The first audit (`47a356e`) is
summarised in §2.3 so that what changed since is visible.

## 1. Intent

Two entry points converge on one model of canonical capabilities and immutable packages (`docs/charter.md`):

* **Path A, new business processes.** Define capabilities, compose them into a recipe, package it, **execute it, verify the business outcome.**
* **Path B, existing applications.** Inspect an application, expose its behavior as capabilities, verify them, package them, prepare a safe
  change, **replace the implementation incrementally while the recipe stays unchanged.**

Two end-to-end outcomes drive prioritization. Everything else is ranked by how directly it advances them.

* **Outcome A:** a recipe is authored, packaged, acquired in another environment, executed durably, and its business outcome independently verified.
* **Outcome B:** one real capability of an existing application is replaced, proven contract-equivalent, with the surrounding process unchanged.

## 2. Where we are

### 2.1 Progress since the first audit

| PR | What it established | Evidence |
|---|---|---|
| #10 `feat/recipe-runtime` | Phase 3: durable recipe execution through AppPort, FeltDB state, independent verification, uncertain outcomes never resubmitted, `appworks recipe run/status/resume` | `spec/runtime-1.md`; `packages/recipe-runtime/test/runtime.test.ts` |
| #11 `feat/recipe-runtime-conformance` | the crash-boundary matrix with real SIGKILLs; a **stale-worker overwrite defect found and fixed** (lease tokens); reconciliation of a lost invocation by durable key; human-task durability | `spec/runtime-1.md` §6.5, §8, §13; `conformance.test.ts`, `workers.test.ts` |
| #12 `feat/recipe-verification-recovery` | a recorded result with inconclusive verification is recovered by re-verifying, never by invoking; **a latent bug fixed** (an inconclusive finding was reused as a verdict); runs report what the records establish | `spec/runtime-1.md` §3.1, §6.6; `verification.test.ts` |
| #13 `feat/recipe-distribution-lifecycle` | Phase 4: publish, acquire (verified, with receipts), install and run, across two environments | `spec/distribution-1.md`; `packages/recipe-distribution/test/{lifecycle,e2e,cli}.test.ts` |
| this slice `feat/recipe-studio` | Phase 5, first slice: author, check against a real environment, preview and package a recipe; the package traverses the existing lifecycle | `packages/recipe-studio/README.md`; `packages/recipe-studio/test/{authoring,readiness,lifecycle,ui,cli}.test.ts` |

`main` has been green in CI on every merge since `47a356e` (`check` and `memos`). Three earlier pushes had been red.

### 2.2 Status ladder

Legend: I implemented, U unit-tested, X integration-tested against the real adjacent components, E demonstrated end to end on real services
and state, P production-ready. `-` not yet. "E" for the recipe layers means a real AppPort registry, a real FeltDB, a real signed release and an
independent persisted ledger, with test providers; no recipe has run against a real third-party application.

| Capability | I | U | X | E | P | Note |
|---|---|---|---|---|---|---|
| Recipe model, validation, locks, source package | Y | Y | Y | Y | - | executed by the runtime and distributed |
| Recipe runtime (subset: `copy`/`const`/`compute`) | Y | Y | Y | Y | - | in-process gateway only; unpublished contract |
| Crash recovery, reconciliation, verification recovery | Y | Y | Y | Y | - | real process kills; mutation-checked |
| Publish, acquire, install over a file channel | Y | Y | Y | Y | - | Distribution Protocol 1.0.0, no new dependency |
| Run from an installed package, in another environment | Y | Y | Y | Y | - | different provider; channel and source deleted first |
| HTTPS registry, mirrors, upgrade/uninstall, key rotation | - | - | - | - | - | |
| Recipe compiler | - | - | - | - | - | the runtime interprets source; no compiled kind |
| Remote capability gateway | - | - | - | - | - | tests are in-process |
| Published canonical accounting contract | - | - | - | - | - | still the example's illustrative one |
| Assessment (Go + proto) | Y | Y | Y | Y (Memos) | - | one real app |
| Assessment of HTTP routes in JavaScript/TypeScript (scanner 2) | Y | Y | Y | - | - | verified against idurar-erp-crm at e935dec by hand (33 routes, verifier passes), not in CI; candidates stop at `investigate` and cannot be extracted (Phase 1.1) |
| Route scan + agent-cited proposals | Y | Y | Y | - | - | Aider run unrecorded |
| Read-only extraction + verification | Y | Y | Y | Y (Memos x1) | - | hand-authored per operation |
| Workspace workflow, durability, approvals | Y | Y | Y | Y (Memos, CI only) | - | |
| Agent runtime | Y | Y | Y | partial | - | live-model tests opt-in |
| Contract adoption, promotion, local commit | Y | Y | Y | Y (Memos) | - | |
| Open PR | Y | Y | - | - | - | fake provider only |
| Push, deployment | - | - | - | - | - | |
| Generated extraction, write extraction, portable implementations, replacement, migration | - | - | - | - | - | **Path B has not moved since the first audit** |
| Recipe Studio: authoring, readiness, card, package (`appworks studio`) | Y | Y | Y | Y (through the API) | - | the lifecycle test drives the Studio over HTTP and hands its package to the existing commands; **the page has not been tried in a browser** (its script runs against the real server under a small DOM) |
| Studio: graph view, mapping/condition editors, run view, authentication | - | - | - | - | - | Phase 5.1 (graph), 5.3, 5.5, 5.6 |

### 2.3 Findings still open from the first audit

| # | Finding | State |
|---|---|---|
| C1 | `pullRequest()` is implemented; **push is not** (`submit-review`, `push`, `promote` are approved-then-refused). A PR can only be opened for a branch already on GitHub. The charter row for PRs is stale | open (Phase 2, blocked on decision 1) |
| C2 | The workflow executes **only hand-authored, reviewed extraction directories** (`workflow.ts:640-641`: "the workspace does not generate one"); `extractions/` holds one, for Memos. This is the largest gap on Path B | open (Phase 1.1) |
| C3 | The install/"cited capabilities" path is an AppPort *proxy*, not an extraction: no contract mapping, adapter, behavioral verification or claim | open; keep distinct |
| C5 | Memos end-to-end is proven in CI only; the default suite uses a synthetic service with stub runners; it depends on the `rkendel1/memos` fork (bridge pass-through) that is not merged upstream; the Aider run has no recorded result | open (0.5) |
| C6 | `@appport/assessment` and `@appport/extraction` return 404 on npm although `docs/compatibility.md` presents them as released libraries. `@appport/recipe` and `@appport/recipe-distribution` are on npm at 0.1.0; **#13 makes `recipe-distribution` 0.2.0, which is unpublished** (`publish-packages.mjs` skips versions already on the registry, so it will publish it) | open (0.4) |
| - | No authentication on the web workspace (loopback only) | open (5.6) |
| - | Branch protection is **off** on `main` (`protected: false`) | open (0.2) |

Resolved since: C4 (CI on the new head is green), the Phase 3 gap, and the "distribution is only a boundary" gap.

## 3. Roadmap

**Order from here:** the owner's sequence is *runtime conformance (done) -> distribution (done) -> Visual Recipe Studio (first slice done) -> generalized extraction ->
capability replacement*. The next step in that order is **Phase 1.1**, and its design should start now: Outcome A is demonstrated end to end,
authored in the Studio, packaged, acquired, installed and run in another environment (with test providers, through the Studio's API rather than a browser), while Outcome B, the harder half of the product, has had no progress and is the longest
pole. Phase 2 (delivery) waits on a decision that is not engineering (decision 1). Each phase ends only when its exit test runs in CI.

### Phase 0: Trustworthy baseline (small; start now)

Goal: main is green by construction, the docs say what the code does, and the environment is reproducible.

**Status:** 0.1, 0.2 (`protected: false` on `main`), 0.4, 0.5 and 0.6 are open. 0.3 is partly done: the charter now describes the runtime and
distribution, and the pull-request row (C1) is corrected in #13; the npm/compatibility drift (C6) remains. `pnpm test` already runs
both suites (`test:fast`, `test:processes`) and CI runs it.

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
| 1.3a | **Library done for JavaScript and TypeScript, not for Python; selectable in the workspace only by naming it (`assess --scanner 2`, recorded, never inferred):** scanner 2 reads Express, Fastify, Koa-router, Hono and NestJS routes with mounts across files, middleware names and handler links (`spec/assessment-1.md` §11). Not done: Python (FastAPI/Flask/Django), Java/Kotlin/Ruby/PHP/C#, routes registered by loops or helpers, reading handler bodies, and reconciling with `surface.ts` (a second, regex-based route scan that feeds the install proposal) so the two cannot diverge. A route stops at `investigate`: with no schema or handler evidence it cannot be an exposure candidate, and extraction (1.1) has nothing to derive a contract from |
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

### Phase 3: Recipe compiler and runtime: **exit met; one task open**

Delivered in #10, #11, #12 (`spec/runtime-1.md`, `packages/recipe-runtime`): the interpreter for the closed vocabulary (rules `copy`/`const`/`compute`; others refused at
start), invocation through `@appport/core` resolution, binding and durable grants (authorized afresh for every call, including verification
probes and reconciliation lookups), human tasks (API and `answer`/`expire` CLI), independent verification before `completed`, uncertain outcomes
that are never resubmitted, reconciliation, verification recovery, lease-token fencing, and a crash-boundary matrix tested with real SIGKILLs.

The exit test (supplier-invoice against a real test provider: reject, duplicate, auto, approval, rejection, no answer; kill at each boundary;
independent ledger; a dropped response is `uncertain` and not retried; provider substitution leaves the recipe byte-identical) **runs in CI**.

| # | Open | Notes |
|---|---|---|
| 3.7 | Publish the accounting contract (replace the illustrative `org.example.accounting`) | still registered only in the test registry; an ownership decision (decision 3) |
| 3.9 | A remote gateway (HTTP transport to providers) | the runtime and the install path are written against the `CapabilityGateway` port; only an in-process gateway exists |
| 3.10 | `enum`/`unit`/`encoding` rules, preconditions, event verification | refused at start, never half-applied |
| 3.11 | Reconciliation for a run uncertain for a reason other than one lost invocation or one unverified recorded result | for a person today |

### Phase 4: Package distribution: **exit met over a file channel; registry work open**

Delivered in #13 (`spec/distribution-1.md`): a file release channel; publishing a signed release bound to the publisher's document that never
changes once published; acquisition that verifies the signature before reading a release, the consumer's *anchored* trust policy, and the signed
digest before returning any bytes, with a validated Distribution Protocol receipt; installation that validates against the receiving environment,
resolves *its* providers and writes *its* lock, refuses without verified trust, and authorizes nothing; `appworks package ...`; and
`appworks recipe run --package`, which re-verifies the installed package against its recorded digest at every start and records it as the run's origin.

The exit test (publish in one environment; a separate environment with a fresh state and a different provider acquires, verifies, installs and executes;
tampering with any byte, signature or binding is refused at the named stage) **runs in CI**: `e2e.test.ts` deletes the channel and the publisher's
environment before the run, and `lifecycle.test.ts` is the attack matrix (`spec/distribution-1.md` §9). Mutation-checked: version immutability, the
install trust gate, trust anchoring and the install-time digest pin each fail tests when removed.

| # | Open | Notes |
|---|---|---|
| 4.5 | An HTTPS registry transport, mirrors, an artifact cache | Distribution Protocol provides them; AppWorks wires only `file` |
| 4.6 | Upgrade and uninstall; version ranges | a version is named explicitly and the consumer pins the digest |
| 4.7 | Key rotation and revocation tooling | the trust check honours revocation in a presented lineage; AppWorks cannot yet produce one |
| 4.8 | A drifted lock refuses a run (`checkRecipeLock` against the live registry at start) | the recipe is validated against the current environment, which is the compatibility gate |
| 4.9 | Check that the roles human tasks need exist in the environment's authority | recorded in the install record, not checkable by AppWorks |
| 4.10 | Publish `@appport/recipe-distribution` 0.2.0 | a human action: `pnpm publish:packages` |

### Phase 5: Visual Recipe Studio: **first slice done; four tasks open**

The Studio (`packages/recipe-studio`, private) edits the canonical `appport.recipe/1` document and calls the same `validateRecipe`, lock and
package functions as the CLI; it has no model of its own, no key, no trust policy, no grant and no execution. Publishing, trust, installation
and running remain `appworks package ...` and `appworks recipe run --package`. Two additive changes elsewhere, neither changing a contract:
the runtime's `CapabilityGateway` gained optional read-only `catalog` and `access` (`spec/runtime-1.md` §6.1; `access` asks AppPort's own binder, and
a gateway without it leaves authority *unresolved*), and `@appport/recipe-distribution` exports `packageForPublish`, which the CLI now also uses, so a previewed
package and a published one cannot differ.

| # | Task | State |
|---|---|---|
| 5.1 | Read-only recipe viewer | **done as a recipe card** in the printed-recipe format (inputs as ingredients, steps spanning what they read, setup, finish) with step inspection and findings; **not a graph**: branches are listed per step |
| 5.2 | Editing with continuous validation; capability discovery panel | **done**: edit operations on the canonical document; a catalog read from the environment's active contracts, from which a step's dependency, shapes, effect and declared verification are derived. Validation is re-run whenever a view is opened, not as you type. The catalog is AppPort's contract registry, not provider discovery; providers are reported per dependency under readiness |
| 5.3 | Mapping and condition editors over the typed expression language | **open**: a step is edited as its JSON |
| 5.4 | Package action producing the same digest as the CLI | **done**, and asserted: the Studio's digest equals what `appworks package publish` publishes for the Studio's file and for `examples/supplier-invoice/recipe.json` |
| 5.5 | Run view | **open** (`appworks recipe status` shows execution state and origin) |
| 5.6 | Authentication boundary for the web server | **open**: loopback only, as the workspace |

Exit ("the supplier-invoice recipe is created in the Studio from empty, validates, shows its unresolved dependencies, and packages to the
same digest as the checked-in recipe via the CLI"): **met, through the API and the CLI, in `lifecycle.test.ts`**, which then publishes, verifies,
installs in a second environment with a different provider, runs and inspects the run's origin. "Created in the Studio" means through its
edit operations over HTTP, not by a person in a browser. Provider bindings: the Studio shows what the chosen environment resolves for each
dependency and refuses to call a recipe ready where it resolves none or several; it does not let an author pin a provider, because that
would put an environment's choice into the portable recipe (open decision 8).

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

1. **Supplier-invoice (outcome A).** Status of the 15-step scenario:

| # | Step | State |
|---|---|---|
| 1-2 | accounting application with real test capabilities, exposed through AppPort | done (test provider, in-process; contract unpublished) |
| 3 | assess the application | not done (Phase 1) |
| 4-5 | define the recipe, validate against canonical contracts | done |
| 6 | package with immutable identity and provenance | done |
| 7 | acquire and verify in a separate environment | done |
| 8 | resolve dependencies through AppPort | done (at install, with the environment's own lock) |
| 9 | execute with durable state in FeltDB | done |
| 10 | validation, duplicate, approval, rejection, submission | done |
| 11 | independently verify the accounting state | done |
| 12 | interrupt at critical points and recover | done (real process kills) |
| 13 | an uncertain submission is not silently repeated | done |
| 14 | change a capability's implementation | done (a second provider with other names) |
| 15 | recipe unchanged when the contract is unchanged | done for substitution; **not** for a contract revision (no compatibility test across contract versions) |

   The Studio test (`packages/recipe-studio/test/lifecycle.test.ts`) exercises steps **4-9, 11, 14** and the automatic path of 10 with a package made in the Studio;
   12 and 13 are covered by the runtime's own tests, not through a Studio-made package. What remains for this project is a real provider (Phase 6), a contract revision test (15), and 1-3.
2. **Memos (outcome B, read path).** Permanent regression: `pnpm extraction:memos --check --mutations` plus `memos-e2e.test.ts`. A passing Memos run does not count toward Phase 1 or 6 exits on its own.
3. **Second application (outcome B, generality).** Phase 1.2 picks it; it must not be Go-and-proto-only by luck of selection.

## 5. Rules for keeping this honest

* A phase is done when its exit test runs in CI on `main`; a local pass is not done.
* Every row in the status ladder moves one column at a time and cites the test or run that justifies it.
* Docs change in the same PR as the behavior.
* New capability claims in the charter table need a linked test; unknowns stay listed as unknowns.
* Do not add a second authority, persistence layer or evidence format (charter principle 2): shared primitives are factored out, not copied.
* **A safety rule is not tested until removing it fails a test.** The runtime and distribution slices were mutation-checked; two real defects (stale-worker overwrite, an inconclusive finding reused as a verdict) and one weak test (a tamper that sometimes did not tamper) were found this way. Keep doing it.
* Tests that start real processes run alone (`pnpm test:processes`); beside the rest of the suite they starve it of CPU.

## 6. Open decisions needed from the owner

1. **Push/commit contract (blocks 2.1):** extend `@appport/github` (upstream) or add a sibling provider?
2. **Hosting (moves 5.6):** is the web workspace, or the Studio, expected to serve more than one operator, or to run in Compute? If yes, authentication comes before Phase 2.
3. **Contract ownership (3.7):** who publishes the canonical accounting contract, and where? Until then every recipe that names it is runnable only where a test registry holds it.
4. **Which second application for 1.2**, and is a non-Go service a hard requirement for Phase 1's exit?
5. **npm (0.4, 4.10):** are `@appport/assessment` and `@appport/extraction` meant to be public now? Publish `@appport/recipe-distribution` 0.2.0?
6. **Branch protection (0.2):** require `check` and `memos` on `main`? It is a repository setting, not a code change.
7. **A registry (4.5):** will recipes be distributed through a hosted Distribution Protocol registry, or is a file or mirrored channel enough for the foreseeable consumers?
8. **Provider binding (Phase 5):** should an author be able to say which provider an environment uses, and where does that live? The recipe must stay portable, so
   it cannot name a provider; today the environment's operator leaves exactly one eligible provider. A per-environment binding profile owned by the environment is
   the likely answer, and it needs AppPort to say what a profile may express.
