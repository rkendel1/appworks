# @appport/workspace

The AppWorks project workspace and transformation orchestrator (private; not published). It carries one repository revision through
acquisition, AppPort integration inspection, capability discovery, assessment, reconciliation, candidate selection, extraction planning,
approval, extraction, verification and readiness for promotion, and records every step in FeltDB. Specification:
[`spec/workspace-1.md`](../../spec/workspace-1.md).

From the repository: `pnpm serve` (builds, then `appworks serve`) and `pnpm appworks <command>`.

```sh
appworks serve                                   # the web workspace on http://127.0.0.1:4300 (loopback only)
appworks project create --github rkendel1/memos --ref e0ce8569589b2eccafd13e262ea3e320251858f2
appworks project acquire <id>                    # then pin, inspect, discover [--endpoint <origin>], assess, reconcile,
appworks project select <id> --candidate cand-memos.api.MemoService.ListMemoReactions
appworks project plan <id> && appworks project request-approval <id>
appworks project approval-subject <id> --action generate-files
appworks project approve <id> --action generate-files --subject <digest>
appworks project execute <id> && appworks project verify <id> && appworks project ready <id>
appworks project show <id> [--json]              # the same view the web workspace renders
appworks agent run <id> [--agent anthropic|openai|deterministic] [--model <m>]   # or let an agent carry it
appworks agent status|stop|resume <id>           # resume [--answer] [--switch-agent]; appworks agent check
```

The ref is optional (the default branch), and `discover` needs no origin: it probes, on loopback, the ports the pinned source names.

Options: `--home <dir>` (`APPWORKS_HOME`, default `~/.appworks`), `--extractions <dir>` (`APPWORKS_EXTRACTIONS`, default
`./extractions`), `APPWORKS_LEASE_MS`. The acting principal is the operating-system user; `<home>/policy.json` restricts it.

| Part | What it is |
|---|---|
| `feltdb.flow` | the authoritative model: collections, the `transformation` workflow (stages, steps, evidence), the approval actions |
| `src/flow.ts`, `src/store.ts` | flow loading and checks; FeltDB deployment, conditional transactions, record validation, content-addressed artifact bodies |
| `src/workflow.ts` | the one workflow implementation: the step protocol, runs and leases, approvals at the action boundary, resume |
| `src/repository.ts` | ref resolution through `@appport/github` (or git), isolated acquisition by SHA, credentials by reference only |
| `src/discovery.ts` | discovery through `@appport/client` (`discoverApplication`), claims through `claimsFor` / `evaluateFulfillment` |
| `src/inspect.ts`, `src/reconcile.ts` | static integration inspection; the graded inventory |
| `src/runner.ts` | reviewed extraction directories and their runner contract (`scripts/extract.mjs --repo --output`); installing and starting an installed AppPort integration |
| `src/view.ts`, `src/actions.ts` | the project view and the action table shared by the web workspace and the CLI; the deterministic advisor |
| `src/server.ts`, `src/ui.ts`, `ui/` | the web workspace: stack-ui pages, JSON API |
| `src/install.ts` | installing AppPort in a revision without an integration: the proposal (files, digest) |
| `src/endpoints.ts` | finding a running instance: loopback origins from the ports the pinned source names |
| `src/agent/contract.ts` | `appworks.agent/1`: request, response, decision, adapter, errors, validation, redaction |
| `src/agent/actions.ts` | the action registry: workflow steps through `dispatch`, bounded reads of the pinned checkout and evidence |
| `src/agent/runner.ts` | the orchestrator: turns, validation, approvals and questions, leases, exclusivity, recovery, cancellation |
| `src/agent/config.ts`, `src/agent/operations.ts` | explicit agent selection from configuration; start/stop/resume and the agent view for CLI and web |
| `src/agent/providers/` | Anthropic and OpenAI adapters (their SDKs are imported only there), the deterministic agent, the scripted fake |
| `vendor/stack-ui` | the stack-ui 0.5.0 static release, unmodified (see its README) |

What it reuses, and what it does not:

* **FeltDB 0.12.0** (`@feltdb/core`): the only durable state, modelled in `feltdb.flow` and deployed with `deployFlowSpec`.
* **`@appport/github` 1.0.2**: ref, repository, branch and commit reads; pull requests. Its own FeltDB is kept in memory; it is not an
  authority for project state. It has no fetch, commit or push contract, so the resolved commit is fetched by SHA with git.
* **`@appport/client` 1.1.3**: discovery. **`@appport/assessment`, `@appport/extraction`**: assessment, plan validation, verification.
* **`@anthropic-ai/sdk` 0.135.0, `openai` 7.39.0**: model calls, each in its adapter, SDK retries off, nothing read from the
  environment by the SDK. **`@appport/schema` 1.1.1**: validating an agent's arguments against each action's schema.
* **stack-ui 0.5.0**: presentation only, vendored as AppPort Services and AppBoundry vendor it.
* Not used: `@appport/services` jobs (its stale-lease recovery does not work; see the spec, §10), its secrets (contracts only, no
  implementation: credentials are references resolved from the environment), its API keys (the workspace has no network authentication
  boundary) and webhooks; Chip (Node 24, Nitro, agent-loop approvals); AuthBoundry in process (an HTTP service; it can stand behind the
  `Authority` port).
