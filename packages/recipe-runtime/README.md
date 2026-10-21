# @appport/recipe-runtime

Durable execution of validated `appport.recipe/1` recipes (private; first vertical slice). Contract: [`spec/runtime-1.md`](../../spec/runtime-1.md).

```sh
appworks recipe run examples/supplier-invoice/recipe.json --input @invoice.json --environment ./my-environment.mjs
appworks recipe status <run>
appworks recipe resume <run> --environment ./my-environment.mjs
appworks recipe reconcile <run> --environment ./my-environment.mjs      # an uncertain run: look the original operation up, never resubmit
appworks recipe answer <run> <step> --response '{"decision":"approved"}' --environment ./my-environment.mjs
appworks recipe expire <run> <step> --environment ./my-environment.mjs
```

Run an installed package instead of a file with `appworks recipe run --package <installed-dir> …`: the package is re-verified against the digest
recorded at install every time, and the run records the package and release as its `origin` (`spec/distribution-1.md` §6).

The environment module default-exports `({ home }) => ({ gateway, authority?, close? })`. The gateway (`createAppPortGateway`) reaches
capabilities only through `@appport/core`: each invocation is resolved, authorized from durable grants and invoked afresh. A recipe names
no provider.

What it guarantees, each with a test in `test/runtime.test.ts`:

* an invalid or unsupported recipe, or invalid input, never starts and writes nothing;
* authorization is checked at every invocation; a revoked grant is seen by the next step, and a lock or claim grants nothing;
* intent is recorded before a consequential call; if its outcome is lost (a dropped response, a crash), the step is `uncertain` and is
  never invoked again, by resume, restart or another worker;
* `completed` is reported only after the contract's verification methods, the step's additional methods and the recipe's outcome
  verification confirm the effect by reading the provider's own state; a contradiction is `failed`, an inconclusive check is `uncertain`;
* a recorded provider result is never taken for the business outcome: an inconclusive verification is re-evaluated (never reused as a verdict), without invoking again;
* state is FeltDB's and survives restart; a dead worker's lease expires and any worker may resume; a worker that has lost its lease cannot write;
* a different provider of the same canonical contract runs the identical recipe.

### Operating an interrupted or uncertain run

| You see | Meaning | Do |
|---|---|---|
| `status: running`, `interrupted` | a worker died or stalled; its lease has expired | `resume` (a lease still running is refused, `RUN_LEASED`) |
| `waiting`, a pending task | a person must decide | `answer` (or `expire`) |
| `finished / uncertain`, assessment `invocation-outcome-unknown` | a consequential call may have happened and **no result was recorded**; nothing was or will be resubmitted | `reconcile` (looks the operation up by its key) |
| `finished / uncertain`, assessment `recorded-unverified` | the provider's **result is recorded** and the operation is not repeated, but verification found nothing conclusive (store unavailable, record not yet visible, no usable evidence). The `evidence` lines say which check and why | `reconcile` again once the evidence can exist: it re-verifies, **never invokes**, and can stay `recorded-unverified` as often as needed. If it never resolves, check the provider's own state by hand |
| `finished / failed`, assessment `business-outcome-unexpected` | independent state **contradicts** the expected result. The operation **may have executed** and produced something else; this is not "nothing happened" | inspect and correct or compensate by hand; the run is final and is not retried |
| `reconcile` → `confirmed-completed` | the provider reports the operation recorded **and** verification confirmed the business state | the run reopens at its success path and completes |
| `reconcile` → `confirmed-not-executed` | the provider reports it absent, strongly consistent, and has fenced the key against a late arrival | the run reopens at its failure path |
| `reconcile` → `indeterminate` | the contract declares no lookup, the lookup failed or is not conclusive, or verification disagreed | the run stays uncertain, with the reason; investigate in the provider, then `reconcile` again or decide by hand |

Never read "succeeded" from the provider's response alone: `verified` means independent state confirmed it. `reconcile` for a `recorded-unverified` run needs only the capabilities the recipe's verification already uses (current grants are rechecked); for an `invocation-outcome-unknown` run it needs the environment to have granted the contract's lookup capability to the runtime, and the operator to be permitted
(`canReconcile`). It uses the contract's `org.appworks.reconciliation/1` attribute (spec §6.5); the accounting example declares it.
Crash and recovery behaviour at every boundary is tabulated in spec §13 and exercised with real process kills in `test/conformance.test.ts`.

Not yet: `enum`/`unit`/`encoding` rules and preconditions (refused), remote providers, timers, reconciling a run that is uncertain for a reason other than one lost invocation or one unverified recorded result, a task UI, packages as a source (spec §12).

`test/accounting/` is a small accounting application (its own FeltDB ledger, two providers with different capability names) used only by the tests.
