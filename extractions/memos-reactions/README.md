# Extraction: Memos `MemoService.ListMemoReactions` → `memos.reactions.list@1`

The first AppWorks extraction (`spec/extraction-1.md`), against the Memos fork `rkendel1/memos` at
`c0eeec7a260ee58e2ed1514a61bfff1fa013f42e`, the revision the assessment workflow pinned. Nothing in Memos is changed.

| File | What it is |
|---|---|
| `contract.json` | the proposed canonical contract `org.appworks.contracts.memos`, capability `memos.reactions.list@1` |
| `extraction-plan.json` | the reviewable plan: candidate, mapping (every difference from the assessment's proposal, with its reason), adapter, authorization, environment, limitations, questions |
| `runtime/adapter.mjs` | the adapter: one capability definition that calls Memos' own `GET /api/{parent}/reactions` through the bridge kit with the caller's credential |
| `runtime/host.mjs` | adds the capability to the **existing** Memos AppPort bridge (`appport-bridge/`), loaded unmodified from the checkout |
| `runtime/register.mjs`, `resolve-hooks.mjs` | let the checkout's bridge modules resolve `@appport/sdk` 1.2.2 (the version its lockfile pins) from this package, so nothing is installed into the checkout |
| `test/behavior.test.mjs` | the behavioral verification suite against a real Memos server |
| `scripts/extract.mjs` | assess → verify → extract → verify-extraction, reproducibly |
| `extraction.json` | the result: `appport.capability-extraction/1` |

## Why this operation

Of the assessment's 42 exposure candidates at this revision, `ListMemoReactions` has the clearest evidence for every requirement and
the least sensitive data:

* **contract**: `ListMemoReactionsRequest { parent (REQUIRED), page_size, page_token }` → `{ reactions: [Reaction], next_page_token }`,
  all types resolved; `GET /api/{parent=memos/*}/reactions`;
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
git clone https://github.com/rkendel1/memos ../memos && git -C ../memos checkout c0eeec7a260ee58e2ed1514a61bfff1fa013f42e
pnpm install && pnpm build

# 1–2. assess the pinned repository and review the evidence and recommendation
node packages/extraction/dist/cli.js assess ../memos --output /tmp/memos-assessment.json
# 3–4. propose an extraction for the selected read-only candidate
node packages/extraction/dist/cli.js extract /tmp/memos-assessment.json --candidate cand-memos.api.MemoService.ListMemoReactions \
     --repo ../memos --output /tmp/proposed.json
# 5. the reviewed contract and mapping: extractions/memos-reactions/contract.json, extraction-plan.json
# 6–7. run the AppPort integration and the behavioral and authorization suite against the real operation
MEMOS_REPO=$PWD/../memos pnpm --filter @appworks-extractions/memos-reactions test
# 4–8. all of it, end to end, and check the committed artifact reproduces
MEMOS_REPO=../memos pnpm extraction:memos --check
# 8. verify the artifact against the assessment, the repository and the adapter sources
node packages/extraction/dist/cli.js verify-extraction extractions/memos-reactions/extraction.json --plan-dir extractions/memos-reactions
```

(`appworks` is the installed command for `packages/extraction/dist/cli.js`.)

## What the verification establishes

The suite builds Memos from the checkout into a temporary directory (`MEMOS_BIN` reuses a build; VCS stamping is off so git never runs
in the checkout, and the version Memos would derive for this revision is injected), starts a real Memos server (SQLite in a temporary directory), creates three synthetic users and
memos with zero, one and several reactions through Memos' own API, and hosts the capability in the real bridge. Each AppPort answer is
compared with the **original operation**, Memos' own HTTP API called with the same credential and input, and results are compared with
Memos' `reaction` table read directly (read-only). For every caller × memo combination, the capability returns exactly the original's
answer, or the AppPort error corresponding to its HTTP status (401 → `UNAUTHORIZED`, 403 → `FORBIDDEN`, 404 → `NOT_FOUND`).

Recorded result, `extraction.json`: **17 of 18 behaviors passed; `integration.fulfillment-claim` failed.** The bridge kit at this
revision cannot publish manifest attributes, so the boundary cannot publish a fulfillment claim, and AppPort's `evaluateFulfillment`
reports `claim.undeclared`. That is recorded as a failure rather than hidden; fixing it requires a change to the bridge at a new
Memos revision. `errors.failure-not-success` is verified with a stub application (500, 503, non-JSON, malformed shapes, redirects,
an unreachable server) behind the real adapter and bridge, and is labelled a unit test.

## Limitations

* Verified on SQLite with synthetic data; MySQL and PostgreSQL drivers, archived memos, Spaces and public-access instance settings
  were not exercised.
* Through AppPort a credential is always required, although Memos lists `ListMemoReactions` among its public methods: access is
  narrower, never wider.
* Memos ignores `page_size` and `page_token` here; the capability passes them through and inherits that.
* `null` inputs are refused by the contract rather than treated as absent.
* The host re-states the bridge's `build()` descriptor because the bridge has no extension point; a test checks the composed manifest
  against the unmodified bridge's.

It does not rewrite Memos, guarantee semantic equivalence beyond these behaviors, grant access, publish or deploy anything, produce a
portable implementation, or replace Memos.
