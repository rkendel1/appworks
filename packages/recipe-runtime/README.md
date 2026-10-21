# @appport/recipe-runtime

Durable execution of validated `appport.recipe/1` recipes (private; first vertical slice). Contract: [`spec/runtime-1.md`](../../spec/runtime-1.md).

```sh
appworks recipe run examples/supplier-invoice/recipe.json --input @invoice.json --environment ./my-environment.mjs
appworks recipe status <run>
appworks recipe resume <run> --environment ./my-environment.mjs
```

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
* state is FeltDB's and survives restart; a dead worker's lease expires and any worker may resume;
* a different provider of the same canonical contract runs the identical recipe.

Not yet: `enum`/`unit`/`encoding` rules and preconditions (refused), remote providers, timers, reconciling an uncertain run, answering a
task from the CLI (the API has `answerTask`/`expireTask`), packages as a source (spec §12).

`test/accounting/` is a small accounting application (its own FeltDB ledger, two providers with different capability names) used only by the tests.
