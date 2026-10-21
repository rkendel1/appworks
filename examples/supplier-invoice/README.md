# Supplier invoice recipe (example)

`recipe.json` is an `appport.recipe/1` source (`spec/recipe-1.md`) for processing a supplier invoice:

1. receive invoice data, validated against `inputs` before anything runs;
2. reject a non-positive amount (`validate-fields`);
3. look for a duplicate (`check-duplicate`, an observation) and reject one (`is-duplicate`);
4. decide whether approval is required: above 10000, or without a purchase order (`needs-approval`);
5. ask an `role:ap-manager` to approve when required (`request-approval`), with explicit routes for rejection and for no answer;
6. submit through the canonical `invoice.submit` capability (`submit` / `submit-approved`);
7. verify each submission by reading the invoice back, and verify the final outcome independently (`outcome.verify`);
8. route rejection, failure and an **uncertain** submission (the ledger may or may not have recorded it) to explicit ends.

The approved and automatic paths submit through separate steps on purpose: the approval must be answered on every path to the submission that
relies on it, and the source says so rather than merging the paths and losing that fact.

## Unresolved dependencies

**`org.example.accounting` is illustrative.** No such canonical contract is published, and nothing implements or registers a provider for it.
All three dependencies (`find-duplicate`, `submit-invoice`, `get-invoice`) are unresolved until an environment supplies that contract and an
eligible provider. Validating in an environment without it reports exactly that:

```ts
validateRecipe(recipe, {}).findings
// ENV_CONTRACT_UNAVAILABLE at /requires/0, /requires/1, /requires/2 (scope "environment"); no source error
```

The tests use a contract **test fixture** (`packages/recipe/test/fixtures.ts`) to exercise environment checks, locks and packages. It is not a
published contract and registers nothing. The recipe is executed by `@appport/recipe-runtime` in `packages/recipe-runtime/test` against a persisted test ledger (`spec/runtime-1.md`); the contract it runs against is still the illustrative one.

Tests: `packages/recipe/test/validate.test.ts` (the example and focused invalid variants), `lock-package.test.ts`, `schemas.test.ts`,
and `packages/recipe-distribution/test/boundary.test.ts`.
