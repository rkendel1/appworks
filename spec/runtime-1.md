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
| `RecipeRun` | run | the exact recipe (`recipe`, `recipeDigest`), the input, the principal, `status`, `outcome`, `currentStep`, step outputs (`data`), lease (`owner`, `leaseExpiresAt`), event counter |
| `StepAttempt` | step execution (`<run>.<step>`) | `started` → `completed` / `waiting`; the edge taken and the next step |
| `Invocation` | capability call (`<run>.<step>.<n>`) | purpose `step` or `verification`; idempotency key; input digest; `intent` → `succeeded` / `failed` / `uncertain` / `abandoned`; resolved provider; error |
| `Verification` | verification of one method | step or `outcome`; method id and source (`contract`, `recipe`, `outcome`); `confirmed` / `contradicted` / `inconclusive`; each expectation with expected and actual |
| `HumanTask` | task step (`<run>.<step>`) | role, what is presented, `pending` → `answered` / `unanswered`; response and who answered |
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

For every invocation: (1) write the `Invocation` in `intent` (a transaction with the step attempt and an event); (2) call the gateway; (3)
record the outcome. Classification:

| Gateway result | Observation step | Consequential step |
|---|---|---|
| `success` | output recorded; step takes `success` | output held pending verification (§6.4) |
| `denied`, `unresolved`, `rejected` | `failure` edge; effect `none` | `failure` edge; effect `none` |
| `failed` | `failure` edge (an observation has no effect) | **`uncertain` edge; invocation `uncertain`** |

**Recovery.** If a worker finds, on resuming, a step whose latest `Invocation` is still `intent`, the previous worker died between
deciding to call and recording the outcome:

* observation: the invocation is `abandoned` and a new one (next ordinal, new key) is made; it is safe by definition;
* consequential: the invocation becomes `uncertain` (`cause: "outcome-not-recorded"`) and the step takes its `uncertain` edge. **The
  runtime never invokes a consequential capability again for a step whose invocation is `intent` or `uncertain`**, whether by resume,
  restart, or a second worker. Re-submission is a decision for a person or a separately written recipe step, after the effect has been
  reconciled (`REINVOKED_AFTER_UNCERTAIN`).

If the invocation is already `succeeded` or `failed` when a worker resumes, its recorded outcome is used and nothing is called.

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

Verification is *independent* in the sense AppPort defines: it reads application state through the provider's own observation capability,
not through the response of the call being verified.

## 7. Authority

* Each invocation, including each verification probe, is resolved and authorized when it is made, by the gateway, through AppPort: resolve
  the canonical requirement, then bind (the binder evaluates the **durable grant** for consumer × provider × capability), then invoke
  (the invoker refuses a stale binding). A grant revoked between two steps is observed by the next step.
* A lock, a package, or a claim is never read as permission. The runtime does not cache bindings across invocations.
* The runtime's **consumer identity** is an AppPort application registered by the host with `requires` matching the recipe's dependencies
  (`consumerRequirements(recipe)`); the principal who started the run is recorded and checked for starting and answering tasks (`Authority`), and is
  not a substitute for the consumer's grant.
* No credential is stored in a record. `denied` and `failed` messages are recorded; the gateway must not put secrets in them.

## 8. Driving, leases and restart

A worker `drive`s a run by claiming a lease (`owner`, `leaseExpiresAt`) with a version-fenced write. A run whose lease has not expired is
`RUN_LEASED` to every other worker. A worker renews its lease at each step boundary. A worker that dies simply stops renewing; after
`leaseExpiresAt`, `resume(run)` by any worker takes over and continues from `currentStep`, applying §6.3 to a step left mid-flight. A
worker that is not the holder when it writes loses (`CONFLICT`) and stops. The runtime does not catch its own faults to tidy state: an
unexpected error leaves the records exactly as they were, as a crash would.

## 9. Human tasks

A `task` step creates a `HumanTask` (`pending`) and the run becomes `waiting`; the lease is released. `answerTask(run, step, response,
principal)`:

1. the authority must permit the principal to answer for the task's role (`AUTHORITY_DENIED`);
2. the response is validated against the task's `response` schema (`RESPONSE_INVALID`);
3. in one transaction: the task is `answered` with `answeredBy` and time, the run records the output and moves along the edge the recipe's
   `cases` choose, and the run is `running`; a task can be answered once (`TASK_NOT_PENDING`);
4. the run continues.

`expireTask(run, step)` marks the task `unanswered` and takes the recipe's `unanswered` edge. A capability step that names an `approval` task
runs only if that task is `answered` in this run. This slice offers the API; the CLI shows pending tasks in `status` and offers no answer
command (§12).

## 10. CLI

`appworks recipe run <recipe.json> --input <json|@file> --environment <module> [--home <dir>] [--json]`,
`appworks recipe status <run> [--home <dir>] [--json]`, `appworks recipe resume <run> --environment <module>`. The environment module is
an operator-supplied ES module whose default export returns `{ gateway, authority? , close? }`; it is the one place that names a
provider's location and credentials, and is not part of any recipe. Exit status: `0` completed, `10` rejected, `11` failed, `12`
uncertain, `20` waiting for a task, `2` usage, `1` refused or error.

## 11. What a run establishes

A `completed` run establishes that, at the time of verification, the provider's own observation capability reported the state the
contract and the recipe expect, for the exact recipe digest, input and invocations recorded. It does not establish that the provider is
correct in general, that the contract is published beyond the registry used, or that anything outside the verified state is right.

## 12. Not in this slice (stated, not implied)

* Rules `enum`, `unit`, `encoding`; `preconditions`; event verification; a `transform` with non-trivial rules beyond §5: refused at start (`RECIPE_UNSUPPORTED`).
* Concurrency inside a run (there is none: the recipe has no parallelism), timers and automatic task expiry, notification, assignment to persons.
* Reconciling an `uncertain` run (reading the effect back and deciding), cancellation, compensation.
* A remote gateway (HTTP transport to providers). `createAppPortGateway` is in-process, over an AppPort registry, and is what the tests use.
* Recipe locks as a start condition, packages as a source of recipes (Phase 4), a task UI and `recipe answer` (Phase 5), run listing.
* Idempotency enforcement by the provider is the provider's; the runtime's guarantee is that it never calls a consequential operation twice for one step.
* The accounting contract used in tests is the example's illustrative `org.example.accounting`, registered in an AppPort registry; it is not published.
