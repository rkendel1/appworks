# AppWorks

AppWorks is the product for **discovering, packaging, composing and incrementally replacing business functionality**, in new applications and
in applications that already exist. It is built on [AppPort](https://github.com/rkendel1/appport), which makes business functions
discoverable and invocable through canonical capability contracts, and uses
[Distribution Protocol](https://github.com/rkendel1/distribution-protocol) to publish and acquire packages.

- [Product charter](docs/charter.md): mission, the three concepts (capability, package, recipe), the two entry points, and what exists today.
- [Architecture](docs/architecture.md): layers, repositories versus package names, dependency rules.
- [Compatibility and evolution](docs/compatibility.md): versioning, the AppPort APIs used before they are published, provenance.
- [Recipe specification](spec/recipe-1.md): `appport.recipe/1`, `appport.recipe-lock/1`, `appport.recipe-package/1`, and the Distribution
  Protocol boundary.
- [Assessment specification](spec/assessment-1.md): `appport.application-assessment/1`, the static reading of an existing application.
- [Extraction specification](spec/extraction-1.md): `appport.capability-extraction/2`, one assessed operation exposed through the
  application's existing AppPort boundary, with its contract, adapter and per-behavior verification.
- [First extraction](extractions/memos-reactions): Memos `ListMemoReactions` as `memos.reactions.list@1`, with its AppPort fulfillment
  claim published by the Memos bridge, verified against the real Memos (revision 2; revision 1 and its undeclared claim kept as history).

## Status

**Draft.** This repository contains the recipe source model, its validation, dependency locks, source packages, the boundary with
Distribution Protocol, the first existing-application assessment (Go and Protocol Buffers), and the first capability extraction
(read-only operations, exposed through the application's existing AppPort boundary), and the project workspace that carries a pinned
revision through them with durable state, approvals and verification. There is **no compiler, no runtime, no publishing or
acquisition, no source extraction and no migration** yet: nothing here executes a recipe, rewrites an application or establishes a
business outcome; an assessment verifies nothing, and an extraction verifies only the behaviors it records as passed. See the charter's
status table.

## Packages

Published under the `@appport/*` ecosystem scope; owned, versioned and released by this repository.

| Package | Contents | Depends on |
|---|---|---|
| [`@appport/recipe`](packages/recipe) | recipe source model, expressions, validation, locks, packages, JSON Schemas | `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1, `@appport/integration` 1.2.0 (published); tested against `@appport/core` 1.3.0 |
| [`@appport/recipe-distribution`](packages/recipe-distribution) | publish, acquire (verified, with receipts) and install recipe packages over a release channel; `appworks package` | `@appport/recipe`, `@distribution-protocol/protocol` 1.0.0 |
| [`@appport/recipe-runtime`](packages/recipe-runtime) | durable recipe execution through AppPort: verification, crash recovery, reconciliation; `appworks recipe` (private) | `@appport/recipe`, `@appport/core` 1.3.0, `@feltdb/core` 0.12.0 |
| [`@appport/assessment`](packages/assessment) | static assessment of an existing repository: evidence, capability candidates, readiness, a recommended exposure candidate (`appworks-assess`) | `@appport/protocol` 1.2.0 |
| [`@appport/workspace`](packages/workspace) | the project workspace and orchestrator (private, not published): FeltDB-backed workflow from a pinned revision to a verified extraction, contract adoption and a verified, reviewable integration change; web workspace and `appworks project` / `appworks serve`; the agent runtime (`appworks agent`) with Anthropic, OpenAI and deterministic agents | `@appport/extraction`, `@appport/assessment`, `@appport/client` 1.1.3, `@appport/github` 1.0.2, `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1, `@feltdb/core` 0.12.0, `@anthropic-ai/sdk` 0.135.0, `openai` 7.39.0 |
| [`@appport/extraction`](packages/extraction) | extraction artifacts: eligibility, contract and mapping checks, adapter identity, fulfillment declarations, per-behavior verification records, revision rules; the `appworks` CLI | `@appport/assessment`, `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1 |

Adapters and their verification suites live in private, unpublished packages under [`extractions/`](extractions).

```ts
import { validateRecipe, createRecipeLock, createRecipePackage, loadRecipePackage } from "@appport/recipe";

const { ok, sourceOk, findings } = validateRecipe(recipe);                       // source only
validateRecipe(recipe, { contracts, providers });                                // and against an environment
```

```sh
appworks assess ../memos --output memos-assessment.json   # read-only; summary on stdout; partial assessments say so
appworks verify memos-assessment.json --repo ../memos     # digest, evidence, no verified or authority claims, locations
appworks extract memos-assessment.json --candidate cand-memos.api.MemoService.ListMemoReactions --repo ../memos \
         --plan extractions/memos-reactions/extraction-plan.json --verification results.json --output extraction.json
appworks verify-extraction extraction.json --assessment memos-assessment.json --repo ../memos --plan-dir extractions/memos-reactions
```

## Example

[`examples/supplier-invoice`](examples/supplier-invoice): intake and validation, duplicate detection, a conditional human approval,
submission through a canonical accounting capability, independent verification, and explicit rejection, failure and uncertain outcomes. Its
accounting contract is illustrative and **unresolved**.

## Development

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm build            # tsc project references
pnpm typecheck        # sources and tests
pnpm test             # vitest
pnpm boundary:check   # dependency rules (docs/architecture.md §3)
pnpm release:check    # pack, install outside the repository from the registry, run consumers and the installed CLI
```

`APPWORKS_MEMOS_REPO=<checkout of rkendel1/memos at e0ce856> pnpm test` also assesses the whole Memos repository
(`packages/assessment/test/memos-full.test.ts`), and `MEMOS_REPO=<checkout> pnpm extraction:memos --check --mutations` builds and runs that Memos,
verifies the extraction's declaration and behaviors against it, requires `extractions/memos-reactions/revisions/2/extraction.json` to
reproduce and every known adapter defect to be caught. CI does both in
its `memos` job (Go from the checkout's `go.mod`).

### The web workspace

```sh
pnpm install
pnpm serve                          # builds, then serves the workspace on http://127.0.0.1:4300 (loopback only)
pnpm serve --port 4400 --home ./my-workspace
pnpm appworks project list          # the same workspace from the CLI (any `appworks` command: project, serve, assess, ...)
```

State lives in `--home` (`APPWORKS_HOME`, default `~/.appworks`); reviewed extractions are read from `./extractions`. Open the printed
URL, create a project from a repository (the ref defaults to its default branch), and run the agent or follow the workspace's next actions. Every action the page offers is also
`pnpm appworks project <action> <id>`.

### The agent

An agent can carry a project through the workflow by itself: it proposes one action at a time, and AppWorks validates and runs each
through the same workflow, authority and approvals, pausing whenever a person must approve something.

```sh
APPWORKS_AGENT_PROVIDER=anthropic APPWORKS_AGENT_MODEL=<model> pnpm appworks agent check   # shows the agent; never the key
pnpm appworks agent run <project>                     # runs until a blocker or an approval; prints every decision and result
pnpm appworks project approve <project> --action generate-files --subject <subject printed by the run>
pnpm appworks agent resume <project>                  # [--answer "..."] for a question; [--switch-agent --agent openai --model <m>]
pnpm appworks agent status <project>    |   pnpm appworks agent stop <project>
pnpm appworks agent run <project> --agent deterministic   # no model: follows the advisor
```

Providers: `anthropic` (`ANTHROPIC_API_KEY`), `openai` (`OPENAI_API_KEY`), `deterministic`. Keys come from the environment or an
optional `.env.local` in the working directory (or `--env-file`), which is read and never printed or stored. The web workspace has the
same controls in its Agent section. Discovery finds a running application from the ports its source names, so no origin needs typing.
A repository without an AppPort integration gets one: the agent proposes an AppPort application in a new directory and, once a person
approves it, AppWorks adds it to an isolated worktree, installs its packages (scripts disabled), starts it and discovers it, then
continues.
`APPWORKS_LIVE_ANTHROPIC_MODEL=<m>` / `APPWORKS_LIVE_OPENAI_MODEL=<m>` with a key enable the live adapter checks in
`test/agent-conformance.test.ts`; `APPWORKS_AIDER_E2E=1` runs the agent on Aider-AI/aider (network: it installs AppPort there,
discovers it, and stops where the evidence does: Python is not assessed, so there is no candidate).

`APPWORKS_MEMOS_E2E=1 APPWORKS_MEMOS_REPO=<checkout> pnpm vitest run packages/workspace/test/memos-e2e.test.ts` runs the same Memos
through the project workspace end to end (acquisition through `@appport/github`, discovery of the running bridge, assessment,
reconciliation, approval, the extraction runner, verification); `appworks serve` shows the result.

No AppPort checkout is needed: AppPort and Distribution Protocol come from the npm registry at the versions the package manifests pin.

## License

Not yet chosen: the packages are marked `UNLICENSED` until the owner decides.
