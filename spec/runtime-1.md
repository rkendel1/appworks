# AppWorks recipe runtime, version 1 (draft)

The recipe runtime executes a validated `appport.recipe/1` source as a **durable run**: it follows the recipe's control flow, invokes
canonical capabilities through AppPort, records every consequential decision before and after it happens, waits for people, verifies the
business outcome independently, and ends in exactly one explicit outcome. This document is the contract; the code is
`packages/recipe-runtime` (`@appport/recipe-runtime`). It is written before the implementation, and the tests are named after its rules.

This first slice executes the vertical path the supplier-invoice recipe needs. §12 lists exactly what it does not do.

## 1. Boundaries

* **Recipe model.** The source, its validation and its dependency declarations are `@appport/recipe` (`spec/recipe-1.md`). The runtime
  validates with `validateRecipe` and never reads a recipe that fails it. A recipe is data: the runtime interprets a closed vocabulary and
  executes no code from a recipe.
* **AppPort owns capabilities.** Identity, fulfillment, resolution, authorization binding and invocation are `@appport/core` 1.3.0
  (`ApplicationDependencyResolver`, `CapabilityBinder`, `CapabilityInvoker`). The runtime re-implements none of them. The runtime reaches
  AppPort only through the `CapabilityGateway` port (§6), whose AppPort-backed implementation is `createAppPortGateway`.
* **FeltDB owns state.** `@feltdb/core` 0.12.0 is the only durable authority for runs (§2). `feltdb.flow` of the package is authoritative
  for the model, as in `spec/workspace-1.md` §1.
* **Not the project workspace.** The runtime does not import `@appport/workspace`, share its FeltDB state, or reuse its transformation
  workflow. It follows the same *discipline* (fenced writes, leases, intent-before-effect) with its own records. Sharing primitives is a
  later refactor, done by extracting a package, never by importing the workspace.
* **No second authority.** A lock, a package, a fulfillment claim or a verified binding grants nothing (charter, principle 2). Every
  invocation is authorized at the moment it is made (§7).

## 2. Records (`feltdb.flow`)

| Collection | One record per | Notes |
|---|---|---|
| `RecipeRun` | run | the exact recipe (`recipe`, `recipeDigest`), its `origin` when it came from an installed package (`spec/distribution-1.md` §6), the input, the principal, `status`, `outcome`, `currentStep`, step outputs (`data`), lease (`owner`, `leaseExpiresAt`), event counter |
| `StepAttempt` | step execution (`<run>.<step>`) | `started` → `completed` / `waiting`; the edge taken and the next step |
| `Invocation` | capability call (`<run>.<step>.<n>`) | purpose `step`, `verification` or `reconciliation`; idempotency key; input digest; `prepared` → `intent` → `succeeded` / `failed` / `uncertain` / `abandoned`; resolved provider; error |
| `Verification` | verification of one method | step or `outcome`; method id and source (`contract`, `recipe`, `outcome`); `confirmed` / `contradicted` / `inconclusive`; each expectation with expected and actual |
| `HumanTask` | task step (`<run>.<step>`) | role, what is presented, `pending` → `answered` / `unanswered`; response and who answered |
| `Reconciliation` | attempt to resolve a lost invocation (`<run>.<step>.<n>`) | the operation key, the resolution (`confirmed-completed`, `confirmed-not-executed`, `indeterminate`), the lookup's evidence, who did it |
| `RunEvent` | transition (`<run>.<seq>`) | append-only log used by `status` |

Every change to more than one record is one FeltDB transaction. A record that is read and changed is written with `ifVersion`; a new
record with `requireAbsent`. Two writers never both succeed: the loser gets `CONFLICT` and writes nothing. A record is refused unless it
matches the collection and fields of `feltdb.flow` (`RECORD_INVALID`).

## 3. Run lifecycle and terminal outcomes

`status`: `running` (a worker holds the lease), `waiting` (blocked on a pending human task; no lease held), `interrupted` (derived: running
with an expired lease), `finished`.

A finished run has exactly one **outcome**, the `outcome` of the end step it reached, after verification:

| Outcome | Meaning |
|---|---|
| `completed` | an `end` of outcome `completed` was reached **and** every verification the path required confirmed the effect: each consequential step's methods, then the recipe's `outcome.verify`. Only then are outputs reported. |
| `rejected` | a business rejection (`end` outcome `rejected`); nothing was done that needs reconciling |
| `failed` | a failure with no effect, or a contradicted verification (§5); the effect is treated as not having happened |
| `uncertain` | the effect may or may not have happened and was not established. Never success, never retried implicitly. |

`uncertain` is the one terminal state that can be left: reconciliation (§6.5) may reopen a run that finished `uncertain` because a consequential invocation's outcome was lost, and only with evidence. Every other terminal state is final.

### 3.1 What the records establish

The outcome above is the recipe's routing. Beside it, a run reports an **assessment** derived only from authoritative records (never from a
provider's say-so), which keeps four situations apart that must not be conflated. `status` and `appworks recipe status` show it.

| Assessment | The records say | It does **not** say | Operator action |
|---|---|---|---|
| `invocation-outcome-unknown` | a consequential call may have happened and **no result was recorded** (`Invocation(uncertain)`) | whether it happened | `reconcile` looks the operation up by its key (§6.5) |
| `recorded-unverified` | the provider's **result is recorded** (`Invocation(succeeded)`), the operation is not repeated, but verification found **nothing conclusive** (provider or store unavailable, record not yet visible, no usable evidence) | that the business outcome is right, **or** that it is wrong | `reconcile` re-verifies without invoking (§6.6); if it stays inconclusive, check the provider's authoritative state by hand |
| `verified` | the result is recorded **and** independent state confirmed the contract's and the recipe's expectations | | none |
| `business-outcome-unexpected` | independent state **contradicts** the expected result (`Verification(contradicted)`) | that the operation did not run. It may well have executed and produced something else; this is **not** evidence of non-execution. It is not repeated | inspect the provider's state; correct or compensate by hand. The run is final (`failed`) |

A provider's response of success is the *recorded result*, never the verified outcome. `not-executed-confirmed` (§6.5) is reached only
by the provider's strongly consistent, fenced answer, never by a missing row; `failed-no-effect` only when the call was refused before the
provider ran. The assessment also reports the latest finding per verification method with its reason, and how many verification recoveries
have been started.

A `completed` end whose outcome verification is contradicted finishes `failed`; inconclusive finishes `uncertain`. A run never reports
`completed` without verification having confirmed it.

## 4. Starting a run

`start(recipe, input, principal)`:

1. The authority must permit the principal to start the recipe (`AUTHORITY_DENIED`).
2. `validateRecipe(recipe, environment)` with the environment the gateway reports (active contracts, eligible providers). Any error finding
   refuses the start (`RECIPE_INVALID`, with the findings). **Nothing is written** for a refused start.
3. The recipe is checked against the supported subset (§12). A construct outside it refuses the start (`RECIPE_UNSUPPORTED`).
4. `validateRecipeInput` checks the input against `inputs` (`INPUT_INVALID`).
5. A `RecipeRun` is created at `start`, bound to the recipe digest (`digestOf`) and holding the recipe. A run never re-reads a recipe from
   anywhere else; editing a file does not change a run.
6. The run is driven (§8) until it finishes or waits.

## 5. Steps

Data is `{ input, steps: { <id>: { output } } }`, addressed by JSON Pointer, exactly as the recipe defines it. A step's output exists only
along the edges where the recipe says it does: the runtime stores a capability step's output only on `success`, and a task's only when
answered.

| Kind | Execution |
|---|---|
| `decision` | evaluate cases in order with `evaluateExpression`; the first that is `true` wins, else `otherwise`. An expression that cannot be evaluated (wrong type at run time) finishes the run `failed` with the reason; the runtime never coerces. |
| `transform` | apply the rules to build the typed output; validate it against the step's `output` schema |
| `task` | §9 |
| `capability` | §6, §7 |
| `end` | `completed`: build the outputs, validate against `outputs`, run outcome verification (§6.4), then finish. Other outcomes finish immediately. |

Rules are `copy` (a missing source is skipped unless `default` is given), `const` and `compute`. Each step is recorded as a `StepAttempt`; moving
to the next step and recording the attempt's result is one transaction (the run's `currentStep` and `data` change with it), so a crash
leaves either the step not done or done and the run past it, never in between.

## 6. Capability invocation

### 6.1 The gateway port

```
CapabilityGateway {
  snapshot(recipe): environment for validateRecipe
  invoke({ dependency, input, idempotencyKey, requestId, signal? }): GatewayResult
}
GatewayResult =
  success      { output, provider, canonical, verification }   // verification: the contract's declared state methods
  denied       { reason, message }                              // authorization refused the binding: provider NOT reached
  unresolved   { reason }                                       // no eligible provider / ambiguous: provider NOT reached
  rejected     { code, message }                                // refused before the provider ran (invalid input, stale binding)
  failed       { code, message }                                // the provider ran or may have run, and did not return an output
```

`denied`, `unresolved` and `rejected` are **pre-effect**: the provider's implementation was not entered, so the effect is `none`. `failed`
is **post-effect-unknown**: the implementation ran, or may have, and the caller cannot tell whether it committed (a timeout, a
connection lost after a commit, a thrown error). The gateway does not classify `failed` further; the runtime treats it by the step's
declared effect (§6.3).

### 6.2 Idempotency key

Every capability invocation carries a key that is a pure function of the request, so it is **stable across restarts and retries of the
same logical call** and different for any other call:

`idempotencyKey = "wf1-" + sha256( canonical { run, step, ordinal, capability: canonical target, input } )`

`ordinal` is 1 for the step's first invocation. The key is written to the `Invocation` record in `intent` **before** the gateway is
called, and is passed to the provider (`CapabilityContext.idempotencyKey`). A provider that declares `idempotency: supported` can then
deduplicate; the runtime does not rely on it (§6.3).

### 6.3 Intent, outcome, and the rule about resubmission

For every invocation: record it as `prepared`, then as `intent`, then call the gateway, then record the outcome (the order and what each
step proves are below). Classification of the gateway's result:

| Gateway result | Observation step | Consequential step |
|---|---|---|
| `success` | output recorded; step takes `success` | output held pending verification (§6.4) |
| `denied`, `unresolved`, `rejected` | `failure` edge; effect `none` | `failure` edge; effect `none` |
| `failed` | `failure` edge (an observation has no effect) | **`uncertain` edge; invocation `uncertain`** |

**Three durable steps, in order, before a consequential call.** (1) `prepared`: the invocation, its input and its key are recorded
together with the step attempt, in one transaction. (2) `intent`: `prepared` becomes `intent`, a write fenced on the invocation and on the
run's lease (§8). (3) The call is made, and only after (2) has committed. (4) The outcome is recorded. A worker that has lost its lease
fails at (2), so it can never reach (3).

**Recovery** inspects the step's latest invocation:

| Found | What it proves | Recovery |
|---|---|---|
| `prepared` | Step (3) never ran: the call is only made after `prepared` has been moved to `intent` and that write committed. **No dispatch occurred.** | dispatch the same invocation: same ordinal, same key, same recorded input |
| `intent`, observation | the call may have been made; an observation has no effect | `abandoned`; a new invocation (next ordinal, new key) |
| `intent`, consequential | **nothing.** The intent is written *before* the call, so it cannot show the call was made; the absence of an outcome cannot show it was not. | `uncertain` (`cause: outcome-not-recorded`). **Never invoked again**, by resume, restart or another worker. Resolved only by reconciliation (§6.5) or by a person |
| `succeeded` / `failed` | the outcome was recorded | use it; call nothing |
| `uncertain` | already uncertain | take the step's `uncertain` edge; call nothing |

Re-submission is a decision for a person or a separately written recipe step, after the effect has been reconciled
(`REINVOKED_AFTER_UNCERTAIN`). An expired lease proves nothing about what the earlier worker's provider call did, and never licenses a repeat.

### 6.4 Verification before success

A consequential step's `success` edge is taken only when verification **confirms** the effect. The verifications are: the canonical
contract's declared state methods (every one; the validator already requires the step to list them) and the step's `verify.additional`.
Each is a probe: an observation capability of the same contract named by a declared dependency, called through the gateway with input
built from `$input` (the step's input) and `$output` (its output), and its output compared with `expect` (`equals`, `exists`).

| Result | Meaning | Edge |
|---|---|---|
| `confirmed` | the probe ran and every expectation held | counts toward `success` |
| `contradicted` | the probe ran and an expectation did not hold | `failure` (treated as not having happened) |
| `inconclusive` | the probe could not run (denied, unresolved, failed), or the contract declares no verification method for a consequential capability | `uncertain` |

Any `contradicted` wins over `inconclusive`; `success` requires all `confirmed` and at least one method. Probes are `Invocation`s
(purpose `verification`), authorized like any other. The **outcome verification** (`outcome.verify`) is the same procedure on a
`completed` end with `$input` and `$output` the recipe's own input and output. Event-kind methods are corroborating only and never
establish success.

**Findings are evidence, and only a conclusive one stands in for a new probe.** Each attempt at a method is its own `Verification` record
(`<run>.<step>.<method>`, then `….try-001`, `….try-002`; the first attempt keeps the id earlier releases used). A `confirmed` or
`contradicted` finding is reused by a resumed or recovered run. An `inconclusive` finding is not: it established nothing, so the method is probed again,
and the earlier attempt stays in the record as history. (A run found by an earlier release with an inconclusive record is therefore
re-verified, never read as verified.) The probe is an observation, so repeating it is always safe; the consequential invocation is never repeated.

Verification is *independent* in the sense AppPort defines: it reads application state through the provider's own observation capability,
not through the response of the call being verified.

### 6.5 Reconciling an uncertain invocation

`reconcile(run, principal)` resolves a run that finished `uncertain` because **one** consequential invocation's outcome was lost, without
submitting anything. It applies only when that step's `uncertain` edge leads directly to an `end` step (so the run can be reopened
without replaying steps). It requires `canReconcile` (absent means nobody).

1. **The original operation is identified by its durable key**: the invocation's recorded idempotency key (§6.2), which the provider was given and stored.
2. **How to look it up is the contract's**, not the recipe's and not the provider's: the canonical contract declares, in the
   AppWorks-namespaced attribute `org.appworks.reconciliation/1` (a convention of this runtime, not an AppPort or recipe member), the
   capability to ask (`via`) and the input field for the key (`keyField`), and whether absence is conclusive (`absenceConclusive`). A contract that
   declares nothing cannot be reconciled by the runtime: a `Reconciliation` of `indeterminate` is recorded and the run stays `uncertain`.
3. The lookup is an ordinary invocation through the gateway, authorized like any other: the environment must have declared it as a consumer
   requirement and granted it (`consumerRequirements(recipe, extra)`). It is recorded as an `Invocation` of purpose `reconciliation`.
4. **Its answer** is `{ state: "recorded", output }` or `{ state: "absent", consistency, fenced }`.

| Lookup says | And | Resolution | Effect on the run |
|---|---|---|---|
| `recorded` | `output` matches the step's `expects.output` **and** the step's verification (contract methods and `verify.additional`) confirms the business state, independently, now | `confirmed-completed` | the invocation becomes `succeeded` (`cause: reconciled`), the run reopens at the step's **`success`** edge; outputs and outcome verification run as for any run |
| `recorded` | the output is malformed, or verification is contradicted or inconclusive | `indeterminate` | none; reason recorded |
| `absent` | the contract declares `absenceConclusive`, **and** the provider answers `consistency: "strong"` **and** `fenced: true` (it now refuses that key) | `confirmed-not-executed` | the invocation becomes `failed` (`cause: reconciled-not-executed`), the run reopens at the step's **`failure`** edge |
| `absent` | any of those missing (an eventually consistent store, or no fence) | `indeterminate` | none. An absent row is not evidence of non-execution: the original may still arrive or be invisible |
| lookup denied, unresolved or failed | | `indeterminate` | none |

Success is never inferred from the invocation record, and non-execution never from an expected row being missing. The transition is
fenced on the run: of two concurrent reconcilers exactly one changes it (the other gets `CONFLICT` or `NOT_RECONCILABLE`). An
`indeterminate` attempt is history, not a verdict; the run may be reconciled again.

A run uncertain because *verification* was inconclusive after a recorded success has no lost invocation to look up; it is recovered by §6.6.

### 6.6 Recovering verification of a recorded result

A run is `recorded-unverified` when a consequential invocation's **result is recorded** and verification then settled nothing: either a step's
verification (the run took the step's `uncertain` edge) or the recipe's outcome verification at a `completed` end. There is no lost
invocation to look up, so §6.5 does not apply; the same `reconcile` command recovers it instead.

1. **Claim.** `reconcile` reopens the run where its recorded result lives (the capability step, or the `completed` end) in one transaction fenced on
   the run, giving the caller a fresh lease token (§8). Of several recoverers one claim wins; the others get `CONFLICT` or `NOT_RECONCILABLE`.
2. **Verify, nothing else.** The ordinary code then runs: the step is found `succeeded`, so **no invocation is made**, and verification is evaluated with the
   *recorded* result and the original input (so the identity and key are untouched). Confirmed findings already recorded are reused; inconclusive ones are probed again. The
   probes are ordinary gateway invocations authorized now (a withdrawn read grant leaves the finding inconclusive, with its reason).
3. **Outcome, by the recipe's own edges.**

| Verification now | Edge | Result |
|---|---|---|
| every method confirmed | `success` | outputs are built and the recipe's outcome verification runs as for any run; `completed` only if it also confirms |
| any contradicted | `failure` | `failed`, assessment `business-outcome-unexpected` (**not** non-execution; the invoice may exist) |
| otherwise | `uncertain` | back at the uncertain end, still `recorded-unverified`, with the new attempt's reasons. Repeatable without limit and without effect |

Because the claim leaves the run `running` and owned, a recoverer that dies mid-verification leaves an ordinary recoverable run: any worker may `resume` it after the
lease expires, and no step of it invokes anything. Nothing here has a second source of truth: the same records, the same transitions, the same fence.
A stale recoverer cannot record a finding or finish the run (§8); a lookup answer gathered before another settlement cannot overwrite it (§6.5).

Not covered: a run uncertain for a reason that is neither a lost invocation nor an unverified recorded result (it is `unresolved`, for a person).

## 7. Authority

* Each invocation, including each verification probe, is resolved and authorized when it is made, by the gateway, through AppPort: resolve
  the canonical requirement, then bind (the binder evaluates the **durable grant** for consumer × provider × capability), then invoke
  (the invoker refuses a stale binding). A grant revoked between two steps is observed by the next step.
* Authorization is also rechecked before the call that is actually made: a grant revoked between `prepared` and dispatch, or between a crash and its recovery, stops the dispatch (`denied`, effect `none`).
* A lock, a package, or a claim is never read as permission. The runtime does not cache bindings across invocations.
* The runtime's **consumer identity** is an AppPort application registered by the host with `requires` matching the recipe's dependencies
  (`consumerRequirements(recipe)`); the principal who started the run is recorded and checked for starting and answering tasks (`Authority`), and is
  not a substitute for the consumer's grant.
* No credential is stored in a record. `denied` and `failed` messages are recorded; the gateway must not put secrets in them.

## 8. Driving, leases and restart

A worker `drive`s a run by claiming a lease: a version-fenced write that sets `owner` to a **fresh token** (`<worker>/<uuid>`) and
`leaseExpiresAt`. The token is held in memory by the claiming runtime. A run whose lease has not expired is `RUN_LEASED` to every other
worker; of several workers claiming together, one claim wins (the others get `CONFLICT`). The holder renews the lease at each transition.

**Every authoritative write is based on a read of the run that still shows the writer's token** (`loadOwned`) **and is fenced on that read's version.**
Fencing on a version alone is not enough: a worker that wakes after losing its lease would read the *current* version and write over its
successor. A worker that no longer holds the token stops with `CONFLICT` and writes nothing: it cannot record an outcome, complete a step,
verify, finish a run, or dispatch. (Verification records are append-only observations and are written only by the holder.) A worker that
dies stops renewing; after `leaseExpiresAt`, `resume(run)` by any worker takes over and continues from `currentStep`, applying §6.3. The
runtime does not catch its own faults to tidy state: an unexpected error leaves the records exactly as they were, as a crash would.

## 9. Human tasks

A `task` step creates a `HumanTask` (`pending`) and the run becomes `waiting`; the lease is released. `answerTask(run, step, response,
principal)`:

1. the authority must permit the principal to answer for the task's role (`AUTHORITY_DENIED`);
2. the response is validated against the task's `response` schema (`RESPONSE_INVALID`);
3. in one transaction: the task is `answered` with `answeredBy` and time, the run records the output and moves along the edge the recipe's
   `cases` choose, and the run is `running`; a task can be answered once (`TASK_NOT_PENDING`);
4. the run continues.

`expireTask(run, step)` marks the task `unanswered` and takes the recipe's `unanswered` edge. A capability step that names an `approval` task
runs only if that task is `answered` in this run.

Task transitions are checked and atomic: the task record, its step attempt and the run move together in one transaction fenced on the
task's and the run's versions. A task is closed once: a second answer, an answer after expiry and an expiry after an answer are
`TASK_NOT_PENDING` (or `CONFLICT` when they race), and exactly one of two racing transitions wins, so task state and run state never disagree. An invalid answer
does not close the task. Authority is evaluated when the answer is given, so an approver whose authority was withdrawn while the run waited is refused.
The CLI offers `answer` and `expire`; there is no task UI.

## 10. CLI

`appworks recipe run <recipe.json> --input <json|@file> --environment <module> [--home <dir>] [--json]`,
`appworks recipe status <run> [--home <dir>] [--json]`, `appworks recipe resume <run> --environment <module>`,
`appworks recipe reconcile <run> --environment <module> [--principal <name>]`, `appworks recipe answer <run> <step> --response <json|@file> --environment <module> [--principal <name>]` and
`appworks recipe expire <run> <step> --environment <module> [--principal <name>]`. The environment module is
an operator-supplied ES module whose default export returns `{ gateway, authority? , close? }`; it is the one place that names a
provider's location and credentials, and is not part of any recipe. Exit status: `0` completed, `10` rejected, `11` failed, `12`
uncertain, `20` waiting for a task, `2` usage, `1` refused or error.

## 11. What a run establishes

A `completed` run establishes that, at the time of verification, the provider's own observation capability reported the state the
contract and the recipe expect, for the exact recipe digest, input and invocations recorded. It does not establish that the provider is
correct in general, that the contract is published beyond the registry used, or that anything outside the verified state is right.

## 12. Not in this slice (stated, not implied)

* Rules `enum`, `unit`, `encoding`; `preconditions`; event verification: refused at start (`RECIPE_UNSUPPORTED`).
* Concurrency inside a run (there is none: the recipe has no parallelism), timers and automatic task expiry, notification, assignment to persons.
* Cancellation and compensation. Reconciliation (§6.5) covers a single lost consequential invocation whose contract declares a lookup; a run whose contract declares no lookup is for a person, and so is any run uncertain for a reason §6.5 and §6.6 do not identify.
* A remote gateway (HTTP transport to providers). `createAppPortGateway` is in-process, over an AppPort registry, and is what the tests use.
* Recipe locks as a start condition, packages as a source of recipes (Phase 4), a task UI (Phase 5), run listing.
* Idempotency enforcement by the provider is the provider's; the runtime's guarantee is that it never calls a consequential operation twice for one step.
* The accounting contract used in tests is the example's illustrative `org.example.accounting`, registered in an AppPort registry; it is not published.

## 13. Crash-boundary and recovery matrix

Every durable transition around a consequential invocation, what survives a process death there, and what recovery does. "Effects" is
the number of invoices in the accounting ledger's own database, read directly; it is never more than one. Each row is an executable test
in `test/conformance.test.ts` in which the worker is a separate OS process that kills itself with SIGKILL at that point (rows marked
*provider* die inside the provider's write).

| # | Boundary | Authoritative records at death | Could the external operation have occurred? | Can the runtime establish that? | Recovery may retry? | Outcome after `resume` | Reconcilable? | Effects |
|---|---|---|---|---|---|---|---|---|
| B1 | before run creation | none | no | yes (there is no run) | the caller starts a new run | no run exists | n/a | 0 |
| B2 | run created, first step not begun | `RecipeRun` (running, at `start`) | no | yes | yes | `completed` | n/a | 1 |
| B3 | step attempt created, before intent | *not a distinct state*: the attempt and `prepared` are one transaction | n/a | n/a | n/a | see B4a | n/a | n/a |
| B4a | invocation `prepared`, not yet `intent` | `Invocation(prepared)` with key and input | **no, provably**: the call is made only after `prepared`→`intent` commits | **yes** | **yes**: same invocation, same key | `completed` | n/a | 1 |
| B4b | `intent` recorded, dispatch not known to have started | `Invocation(intent)` | maybe | **no**: an intent is written before the call and proves nothing | **no** | `uncertain` | yes | 0 (here) |
| B5, B6 | dispatch begun / provider executing, died before its write committed (*provider*) | `Invocation(intent)` | maybe (here: no) | no | **no** | `uncertain` | yes: lookup answers *absent, strong, fenced* → `confirmed-not-executed`; a late arrival of the key is refused | 0 |
| B7 | provider committed, died before responding (*provider*) | `Invocation(intent)` | **yes** | no | **no** | `uncertain` | yes: lookup answers *recorded*, verification confirms → `confirmed-completed` | 1 |
| B8 | response received, outcome not recorded | `Invocation(intent)` | **yes** | no (the response was in memory only) | **no** | `uncertain` | as B7 | 1 |
| B9 | outcome recorded, step not completed | `Invocation(succeeded, output)` | yes, and recorded | yes | continue; **no call** | `completed` | n/a | 1 |
| B10 | step completed, next step not begun | `StepAttempt(completed)`, run at next step | yes, recorded | yes | continue | `completed` | n/a | 1 |
| B11 | verification done, terminal state not committed | `Verification` records | yes, recorded | yes | continue; recorded verifications are reused, not redone | `completed` | n/a | 1 |
| B9a | result recorded; verification found nothing, died before the step took its edge | `Invocation(succeeded)`, `Verification(inconclusive)` | yes, and recorded | yes | continue; **no call**; the inconclusive finding is probed again | `completed` if the evidence is now there, else `uncertain` (recorded-unverified) | via §6.6 | 1 |
| B11a | probe answered, finding not recorded | `Invocation(succeeded)`, earlier findings only | yes, recorded | yes | continue; the observation is repeated; **no call** | `completed` | n/a | 1 |
| B11b | verification finished (finding recorded), step not committed | `Verification(confirmed)` | yes, recorded | yes | continue; the finding is reused, nothing probed or called | `completed` | n/a | 1 |
| B12 | immediately after the terminal commit | `RecipeRun(finished)` | yes, recorded | yes | nothing to do | unchanged (`completed`) | n/a | 1 |

Verification recovery (`test/verification.test.ts`, real processes): a result recorded with verification unavailable, lagging or
contradicted; recovery by `reconcile` after a crash or without one; the same repeated while still inconclusive; a recoverer killed mid-verification and then resumed by
several workers; two recoverers at once; a stale verifier; a lookup answer made stale by another settlement. In every case the ledger holds exactly one invoice and the
step has exactly one invocation.

Stale and concurrent workers (`test/workers.test.ts`): a worker that returns from the provider after its lease was taken over cannot record
the outcome (`CONFLICT`; the successor's `uncertain` stands); one parked after recording a success cannot complete the step once another
worker has; several processes resuming one dead worker's run at once produce one claim, one invocation and one effect; two answers, or an
answer racing an expiry, produce exactly one transition; a runtime home created by the first release opens under this flow.

The conservative rule is unchanged: where the table says the runtime cannot establish whether the operation occurred, it does not call again.
