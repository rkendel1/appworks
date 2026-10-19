# Extraction: Memos `MemoService.ListMemoReactions` → `memos.reactions.list@1`

The first AppWorks extraction (`spec/extraction-1.md`), against the Memos fork `rkendel1/memos` (public). The current revision 2 is at
`e0ce8569589b2eccafd13e262ea3e320251858f2` (branch `appport/bridge-manifest-attributes`). That commit is `c0eeec7` plus one change
to the Memos AppPort bridge, described below; Memos' Go code and protos are unchanged. The extraction never writes to the Memos checkout.

| File | What it is |
|---|---|
| `contract.json` | the proposed canonical contract `org.appworks.contracts.memos`, capability `memos.reactions.list@1` |
| `extraction-plan.json` | the reviewable plan (`appport.capability-extraction-plan/2`): candidate, mapping (every difference from the assessment's proposal, with its reason), adapter, fulfillment declaration, runtime, authorization, environment, limitations, questions |
| `runtime/adapter.mjs` | the adapter: one capability definition that calls Memos' own `GET /api/{parent}/reactions` through the bridge kit with the caller's credential |
| `runtime/fulfillment.json` | the fulfillment declaration the host publishes: one `appport.fulfillment/1` claim, made with `@appport/protocol`'s `claimFor` and `fulfillmentAttributes` |
| `runtime/declaration.mjs` | checks the declaration against `contract.json` before it is published, and against the bridge's own manifest after; fails closed with a reason code |
| `runtime/host.mjs` | adds the capability and its declaration to the **existing** Memos AppPort bridge (`appport-bridge/`), loaded unmodified from the checkout |
| `runtime/register.mjs`, `resolve-hooks.mjs` | let the checkout's bridge modules resolve `@appport/sdk` 1.2.2 (the version its lockfile pins) from this package, so nothing is installed into the checkout |
| `test/behavior.test.mjs` | the behavioral verification suite against a real Memos server |
| `scripts/extract.mjs` | the end-to-end run (§ Run it); `scripts/mutations.mjs`: the mutation check |
| `revisions/1/extraction.json` | revision 1 (`appport.capability-extraction/1`, at `c0eeec7`): **kept as recorded**, with its failed fulfillment claim |
| `revisions/2/extraction.json` | revision 2 (`appport.capability-extraction/2`, at `e0ce856`): current; names revision 1's digest as `previous` |

## Why the claim was undeclared in revision 1, and the fix

Revision 1 recorded `integration.fulfillment-claim` as **failed**: AppPort's `evaluateFulfillment` reported `claim.undeclared` for the
live bridge's manifest. The cause was **an unsupported bridge capability**. It was not an AppPort limitation, a contract-version
mismatch or an adapter defect.

* The bridge's runtime is `@appport/sdk` 1.2.2 with `@appport/core` 1.1.0. Its public `createApplication` publishes manifest
  `extensions` and `attributes`, which is exactly how an `appport.fulfillment/1` claim is published.
* The bridge kit's `startBridge` (`appport-bridge/lib/bridge-kit.mjs` at `c0eeec7`) built the application from `application`,
  `capabilities`, `resources` and the authorizer only. A host adding capabilities had no supported way to publish a claim, short of
  forking the kit.

The smallest change is in the bridge, not in AppWorks or AppPort. Commit `e0ce856` makes `startBridge` pass optional `extensions` and
`attributes` through to `createApplication`, unchanged otherwise. It adds `test/kit.test.mjs` to the bridge's own suite, covering:
publication, the unchanged default, that an anonymous caller is still refused, and that `appport.integration/1` stays reserved. The
bridge's full suite passes (17 tests). The change is pushed to `rkendel1/memos` as branch `appport/bridge-manifest-attributes`; it is
not merged into Memos' `main` (question `q-merge-bridge`).

**The supported declaration path** is the host. It builds the declaration with AppPort's own `claimFor` and `fulfillmentAttributes` and
publishes it through the bridge's `startBridge`. It then confirms, from the bridge's own `appport.manifest`, that the declaration was
published exactly. A declaration that is missing (`FULFILLMENT_MISSING`), malformed (`FULFILLMENT_MALFORMED`), for another contract,
capability or version (`FULFILLMENT_MISMATCH`), stale against the contract (`FULFILLMENT_STALE`) or not actually published
(`FULFILLMENT_UNPUBLISHED`, for example on the `c0eeec7` bridge) stops the host. The capability is never served undeclared. A claim
is a declaration about the interface: it grants nothing, and every call is still authenticated by the bridge, authorized by AppPort
(`memos.read`) and decided by Memos.

## Why this operation

Of the assessment's 42 exposure candidates, `ListMemoReactions` has the clearest evidence for every requirement and the least
sensitive data:

* **contract**: `ListMemoReactionsRequest { parent (REQUIRED), page_size, page_token }` → `{ reactions: [Reaction], next_page_token }`,
  with every type resolved; served at `GET /api/{parent=memos/*}/reactions`;
* **implementation**: `server/api/reaction_service.go` `APIService.ListMemoReactions`, linked by name and request type;
* **authorization**: resource-specific: it calls `checkMemoReadAccess` on the parent memo, which answers `NotFound`, `Unauthenticated`
  or `PermissionDenied`, and visibility (PRIVATE, PROTECTED, PUBLIC; creator; administrators) is Memos' own;
* **persistence**: reads only (`SELECT … FROM reaction`); no outbound HTTP, no goroutines;
* **tests**: five related tests in Memos;
* **bounded**: 55 reachable functions, call graph complete.

Not chosen: `UserService.ListPersonalAccessTokens` (credentials), `GetUserWebhookSigningSecret` (secrets), `ListUsers` (admin-only,
returns e-mail addresses), and `GetMemo`, which the bridge already exposes as `memos.get`.

## Run it

```sh
git clone https://github.com/rkendel1/memos ../memos-e0ce856
git -C ../memos-e0ce856 checkout --detach e0ce8569589b2eccafd13e262ea3e320251858f2
pnpm install --frozen-lockfile && pnpm build

MEMOS_REPO=$PWD/../memos-e0ce856 pnpm extraction:memos --check --mutations
```

It runs, in this order, and stops at the first broken step:

1. Validates the source revision (the checkout's HEAD is the plan's pin), then assesses and verifies the assessment.
2. Checks that revision 1 still verifies as recorded and is the plan's `previous`, and reads the plan, contract, declaration and
   boundary files.
3. Builds Memos into a temporary directory with the declared build: `-buildvcs=false`, which keeps git out of the checkout, plus the
   version Memos derives for this revision.
4. Starts it with synthetic users and memos created through Memos' own API, using the bridge's harness.
5. Starts the unmodified bridge with the host.
6. Verifies the declaration and discovery.
7. Runs the behavioral and authority tests.
8. Writes the verification record and the `appport.capability-extraction/2` artifact, and verifies it against the assessment,
   repository and adapter sources.
9. Confirms the checkout is unchanged (a tree hash over every file, `.git` included).
10. Reports passed, failed, inconclusive and not-run behaviors separately, with what each ran against.

It exits non-zero unless every required behavior passed, the checkout is unchanged, the artifact reproduces (`--check`) and no mutant
survives (`--mutations`). It depends on no running server and on no prior state: `MEMOS_BIN` is ignored, and a Memos build made any
other way gives another runtime digest, which `appworks extract` refuses. `--write` instead regenerates `revisions/2/extraction.json`.

## What revision 2 establishes

**21 of 21 required behaviors passed**, for exactly the subject each result names: source `e0ce856`, capability digest `sha256:8d67db5c…`,
the adapter digest, the declaration digest and the runtime digest.

* **Declaration and discovery** (`integration.fulfillment-claim`): AppPort client discovery (`appport.manifest`) returns
  `appport.fulfillment/1` with exactly the declared claim. `claimsFor` finds `com.usememos.memos` `memos.reactions.list@1` claiming
  `org.appworks.contracts.memos` `memos.reactions.list@1`, and `evaluateFulfillment` finds it **valid**: compatible, no findings.
* **Fails closed** (`integration.declaration-fails-closed`): the host refuses missing, malformed, mismatched (another contract, an extra
  claim) and stale declarations. It refuses a bridge that does not publish them (`FULFILLMENT_UNPUBLISHED`; that manifest is
  `claim.undeclared`). A changed contract makes the published claim `stale`.
* **Authority** (`authorization.*`):
  * neither discovery nor a valid published claim grants anything;
  * anonymous and forged credentials are denied;
  * carol is denied bob's private memo (`FORBIDDEN`, while the database shows it exists), administrators and PROTECTED readers are
    not;
  * the caller's own credential is used for each call (bob, carol, bob again);
  * the adapter holds no credential and reads no database.
* **Behavior against the original operation**:
  * for each caller × memo, the AppPort answer equals Memos' own API answer with the same credential and input, or the AppPort error
    matching its HTTP status; results match Memos' `reaction` table read directly;
  * empty and multiple results, field mapping, optional and null inputs, invalid input and not-found are all covered;
  * outputs carry only contracted fields: no credential, secret or personal data.
* **Failures** (`errors.*`): stopping the real Memos under the running host gives `INTERNAL_ERROR`, never a result, while the declaration
  stays valid: a valid claim says nothing about whether a call succeeded. A stub application covers 500, 503, non-JSON, malformed
  shapes, redirects and an unreachable server. Each result names its target (`[real-application]`, `[stub-application]` or `[none]`),
  so stub-only evidence stays visible.
* **Mutations** (`scripts/mutations.mjs`): the suite catches all six known defects. These are fabricating a field, fabricating data,
  swallowing errors, reusing the first caller's credential, publishing no declaration, and publishing a stale claim.

## Limitations

* Verified on SQLite with synthetic data. MySQL and PostgreSQL drivers, archived memos, Spaces and public-access instance settings were
  not exercised.
* AppPort's in-process canonical discovery (`@appport/core` `discoverCanonical`) reads an `ApplicationRegistry`, which accepts only an
  in-process application's `verify()` result; registering the remote bridge's manifest would fabricate that state. Discovery is verified
  through AppPort client discovery plus `claimsFor` and `evaluateFulfillment`, the checks `discoverCanonical` applies to each candidate.
* Through AppPort a credential is always required, although Memos lists `ListMemoReactions` among its public methods: access is
  narrower, never wider.
* Memos ignores `page_size` and `page_token` here; the capability passes them through and inherits that behavior.
* `null` inputs are refused by the contract rather than treated as absent.
* The host re-states the bridge's `build()` descriptor because the bridge has no extension point for extra capabilities. A test checks
  the composed manifest against the unmodified bridge's.
* The pinned revision is on a branch of the fork, not on Memos' `main`.

This extraction does not rewrite Memos, guarantee semantic equivalence beyond these behaviors, grant access, publish or deploy anything,
produce a portable implementation, or replace Memos.
