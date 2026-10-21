# Architecture and dependency boundaries

## 1. Layers

| Layer | Responsibility | Where |
|---|---|---|
| **AppPort** | Canonical capability contracts, discovery, fulfillment validation, dependency resolution, invocation boundaries, reusable integration primitives (mapping rules, verification, schema compatibility) | `rkendel1/appport`: `@appport/protocol`, `@appport/schema`, `@appport/integration`, `@appport/core`, … |
| **AppWorks** | Application assessment, business-capability extraction, the project workspace that orchestrates them, recipe composition, versioned business packages, replacement planning; later, compilation and execution of business processes | this repository: `@appport/assessment`, `@appport/extraction`, `@appport/recipe`, `@appport/recipe-distribution`, `@appport/workspace` (private application); adapters in `extractions/` (private) |
| **Distribution Protocol** | Independent publication, acquisition and verification of software releases | `rkendel1/distribution-protocol`: `@distribution-protocol/*` |
| **Execution and authority infrastructure** | Authorization grants, bindings, execution control, durable state, evidence | AppPort's established layers (`@appport/core`, `@appport/authorization`); unchanged by AppWorks |

## 2. Repository, package name and responsibility are three different things

AppWorks publishes under the `@appport/*` npm scope. The scope names the **ecosystem** a developer installs from; it is not a statement that
a package belongs to the AppPort protocol or lives in the AppPort repository.

| | Repository | Packages | Responsibility |
|---|---|---|---|
| Protocol layer | `rkendel1/appport` | `@appport/protocol`, `@appport/integration`, `@appport/core`, `@appport/sdk`, … | capability protocol, discovery, fulfillment, integration |
| Product | `rkendel1/appworks` | `@appport/assessment`, `@appport/extraction`, `@appport/recipe`, `@appport/recipe-distribution`; later, when its boundary justifies it, e.g. a compiler | business recipes, packages, modernization |
| Distribution | `rkendel1/distribution-protocol` | `@distribution-protocol/*` | publication, acquisition, verification |

Likewise, the recipe formats are named `appport.recipe/1`, `appport.recipe-lock/1` and `appport.recipe-package/1`, the Distribution
Protocol binding scheme `appport/recipe-package/1`, the assessment format `appport.application-assessment/1`, and the extraction formats
`appport.capability-extraction/1` (with its plan and verification-results inputs): ecosystem names, specified and owned here
(`spec/recipe-1.md`, `spec/assessment-1.md`, `spec/extraction-1.md`). AppPort's protocol
specification does not define them, and AppPort's packages neither implement nor read them.

Each package is versioned and released independently, with its own changelog and compatibility contract. A new recipe release does not
require an AppPort release, and an AppPort release does not require an AppWorks release.

## 3. Dependency rules

```
@appport/recipe-distribution ──→ @appport/recipe ──→ @appport/integration ──→ @appport/protocol
            │                          └────────────→ @appport/schema ──────────→ @appport/protocol
            └──→ @distribution-protocol/protocol

@appport/assessment ──→ @appport/protocol
@appport/extraction ──→ @appport/assessment, @appport/protocol, @appport/schema
@appport/workspace (private) ──→ @appport/extraction, @appport/assessment, @appport/protocol, @appport/client, @appport/github, @feltdb/core
extractions/* (private adapters) ──→ @appport/sdk at the version the application's own boundary pins; the application's boundary code, loaded in place

AppPort packages ──✗──→ anything in this repository
@appport/recipe  ──✗──→ @distribution-protocol/*, any registry; @appport/core only as a devDependency (tests)
@appport/assessment ──✗──→ @appport/core (not even for tests), @distribution-protocol/*, @appport/recipe, @appport/extraction
@appport/extraction ──✗──→ @appport/core, @appport/sdk, @distribution-protocol/*, any adapter
@appport/workspace  ──✗──→ @appport/core, @appport/services, another database or scheduler; @appport/sdk only as a devDependency (tests)
anything else      ──✗──→ @appport/workspace
```

1. **AppWorks depends on AppPort; AppPort does not depend on AppWorks.** AppWorks consumes AppPort's **published** packages at exact versions,
   so it builds, tests and installs without an AppPort checkout. No `workspace:`, `link:`, `file:` or git dependency on an AppPort package,
   and no import, path alias or project reference into a sibling checkout.
2. **`@appport/recipe` depends only on `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1 and `@appport/integration` 1.2.0 at run time.**
   It builds locks from `@appport/core`'s `resolvedDependency()` records, which the caller resolved. `@appport/core` 1.3.0 is a
   devDependency, so its tests run against real resolution and binding, and no shipped source imports it.
3. **Only `@appport/recipe-distribution` depends on Distribution Protocol.** The recipe model, validation, locks and package format work with
   no distribution layer and no registry.
4. **No code execution in the recipe model.** No `eval`, `Function`, dynamic import, `vm` or child process.
5. **No parallel implementations.** Canonical capability identity, fulfillment validation, discovery, resolution, authorization and
   invocation are AppPort's, used through its published API (`docs/compatibility.md` §3).
6. **Assessment only reads.** `@appport/assessment` depends on `@appport/protocol` alone, for `digestOf`, `canonicalize`, `isValidName`
   and the `CapabilityVersionEntry`, `CapabilityEffect` and `JSONSchema` types its proposals reuse. It does not need `@appport/core`: it
   resolves, registers, binds and invokes nothing, so a dependency on the runtime would only invite a parallel registry. Its source has no
   code-execution or network primitive, and only its CLI writes a file: the output, never inside the assessed repository.

7. **Extraction binds; it does not run.** `@appport/extraction` reads assessment artifacts, plans, contracts and file contents, and
   uses AppPort's published `compareSchemas`, `compareManifests`, `capabilityDigest`, `contractDigest`, `lintIntegration`,
   `isCanonicalContract` and `digestOf`. It never loads or executes an adapter, re-implements no scanner (it consumes
   `verifyAssessment`), and has no code-execution or network primitive; only its CLI writes, and only its output. Adapters are
   application-specific code in private packages under `extractions/`, run only by their own verification suites.

8. **The workspace orchestrates; it does not re-implement.** `@appport/workspace` keeps all durable state in FeltDB 0.12.0, modelled
   by its `feltdb.flow` (deployed, and enforced on every write). It resolves repositories through `@appport/github`, discovers through
   `@appport/client`, assesses, validates plans and verifies through `@appport/assessment` and `@appport/extraction`, and runs only the
   reviewed extraction runner, after an approval, and, after its own approval, an AppPort integration it installed (packages installed
   with scripts disabled, started on loopback in an isolated worktree). Processes run in `src/repository.ts` (git, against its own
   isolated checkout) and `src/runner.ts` only; only `src/server.ts` serves HTTP, on loopback. It is private: `@appport/github` 1.0.2 brings a second, older
   AppPort stack, which a published library must not.
   Its agent runtime (`src/agent/`) adds `@appport/schema` (validating decisions) and two model providers' SDKs, `@anthropic-ai/sdk`
   and `openai`, each imported only by its own adapter (`src/agent/providers/<provider>.ts`): the orchestrator, the action registry and
   the workflow see the provider-neutral `appworks.agent/1` contract and nothing else, so an adapter (Stack-Agent's, when it has a
   decision-only contract) can replace another without touching them.

9. **The runtime executes through AppPort; it is not the workspace.** `@appport/recipe-runtime` (private) depends at run time on
   `@appport/recipe`, `@appport/protocol`, `@appport/schema`, `@appport/core` and `@feltdb/core`, and on nothing else of AppWorks's: not
   `@appport/workspace`, assessment, extraction or distribution. It is the one package allowed to use `@appport/core` at run time,
   because resolution, authorization binding and invocation are core's and are called afresh for every invocation (`spec/runtime-1.md`
   §6-§7). Its durable state is its own `feltdb.flow` in FeltDB, opened in `src/store.ts` only. It starts no process, server or
   connection. The workspace reaches its CLI only by a lazy import through an optional peer dependency (the `recipe` command, and `package` for `@appport/recipe-distribution`), and shares
   no state with it.

`scripts/check-boundary.mjs` enforces 1–4, 6, 7, 8 and 9 on every build (including that `@appport/core` is a runtime dependency of `@appport/recipe-runtime` only,
and a test-only `devDependency` everywhere else). Rule 5 is a review rule.

## 4. How the recipe layer uses AppPort

| AppWorks needs | Published AppPort API used |
|---|---|
| Check transformation rules (types, units, encodings, enums, concepts, defaults, required fields) | `lintRule`, `requiredTargetsNotProduced` (`@appport/integration`) |
| Compare a step's expected interface with the contract | `compareSchemas` (`@appport/protocol`) |
| Check dependency declarations, including canonical targets | `lintIntegration`, `isCanonicalDependencyTarget`, `Dependency` (`@appport/protocol`) |
| Recognize a canonical contract | `isCanonicalContract` (`@appport/protocol`) |
| Digests and canonical JSON | `digestOf`, `canonicalize`, `contractDigest`, `capabilityDigest`, `isDigest` |
| Pointers and schema lookup | `schemaAt`, `isRequiredAt`, `parsePointer`, `isPointer`, `readPointer` |
| Versions and dependency references | `isVersionConstraint`, `satisfiesVersionConstraint`, `parseDependencyRef` |
| Contract metadata | `getIntegration`, `findCapabilityVersion`, `validateSemanticAnnotations`, `isValidApplicationId` |
| Input validation | `fromJSONSchema` (`@appport/schema`) |
| Verification and precondition model | `StateExpectation`, `ValueRef`, `EffectDescriptor` types |

A recipe **environment** uses AppPort's runtime directly: `CanonicalContractRegistry` for contracts, `ApplicationDependencyResolver`
(`discoverCanonical`, `resolveRequirement`) for discovery and resolution, `resolvedDependency()` for the records a lock is built from, and
`CapabilityBinder` with authorization grants for bindings (`@appport/core`). AppWorks adds the recipe-level checks around them
(`validateRecipe` with an environment, `createRecipeLock`, `checkRecipeLock`, `substituteProvider`) and nothing in their place.

## 5. How the assessment layer uses AppPort

An assessment produces **proposals** in AppPort's vocabulary and nothing AppPort acts on. A proposed capability is a name that passes
AppPort's `isValidName` and the fields of AppPort's `CapabilityVersionEntry` (`version`, `kind`, `inputSchema`, `outputSchema`,
`effect`). It has no permissions, no fulfillment claim and no verification method; it is not a canonical contract and is registered
nowhere. The path from a proposal to an invocable capability is AppPort's: author a contract, implement or bridge it, claim fulfillment,
verify, resolve, and bind with a grant. The artifact's digest uses AppPort's `digestOf`, the same rule as recipe packages.

## 6. How an extraction uses AppPort and the application's boundary

The adapter is hosted by the application's **existing** AppPort boundary, never by a new server. For Memos that boundary is the
bridge at `appport-bridge/` (trusted-boundary mode: `@appport/sdk` 1.2.2, `createServer`, `permissionAuthorizer`, the caller's Memos
credential forwarded to Memos' own HTTP API). `extractions/memos-reactions/runtime/host.mjs` loads that bridge unmodified from the
checkout and adds one capability definition to the same server, so discovery, transport, authentication and AppPort authorization are
the bridge's, and every access decision is Memos'. The proposed contract is an AppPort canonical contract; conformance of the live
capability is checked with AppPort's `compareSchemas`.

The fulfillment claim is published through the same boundary. The host builds it with `@appport/protocol`'s `claimFor` and
`fulfillmentAttributes` and passes it as manifest `extensions` and `attributes` to the bridge's `startBridge`, which hands them to
AppPort's `createApplication`. That pass-through is a bridge change in the Memos fork (`e0ce856`); before it, the bridge had no supported
way to publish a claim. The host checks the declaration against the contract before publishing and against the published manifest
after, and stops otherwise. Discovery uses AppPort's client (`appport.manifest`), and the claim is judged by AppPort's `claimsFor` and
`evaluateFulfillment`. AppWorks adds no declaration format, registry or authority, and the claim grants nothing.

## 7. How the workspace uses the stack

| The workspace needs | It uses |
|---|---|
| Durable state, schema, concurrency | FeltDB 0.12.0: `deployFlowSpec` of `feltdb.flow`, `transaction` with `requireAbsent` / `ifVersion`, `updateIfVersion`, indexes |
| Repository refs, branches, commits, pull requests | `@appport/github` 1.0.2 (`repositories.get/source`, `branches.get`, `commits.list`, `pullRequests.list/create`), capabilities decided by the workspace authority |
| The commit's files | git, by SHA, into an isolated checkout (no `@appport/github` contract exists for it) |
| Existing capabilities | `@appport/client` `discoverApplication`; claims through `@appport/protocol` `claimsFor` and `evaluateFulfillment` |
| Assessment, plan validation, verification | `assessRepository`, `verifyAssessment`; `createExtraction` (without results), `readPlan`, `candidateRefusals`, `verifyExtractionAt` |
| Contract adoption | `isCanonicalContract`, `capabilityDigest`, `contractDigest`, `compareSchemas`, `digestOf` (`@appport/protocol`); `contractProblems`, `fulfillmentProblems`, `contractChanges`, `verifyExtraction` (`@appport/extraction`). No registry: the adopted contract is a file the promotion adds, published through the application's own boundary |
| Promotion | a reviewed promotion plan per extraction; byte-for-byte copies of verified files; an isolated git worktree of the pinned revision; the extraction's own behavioral suite and mutation check run against the promoted copy |
| Presentation | stack-ui 0.5.0 static release (vendored, unmodified) |
| Agent runs | the same FeltDB (`AgentRun`, `AgentTurn` in `feltdb.flow`; transactions fenced on versions); model providers through their SDKs in one adapter each; FeltDB's agent APIs are server-only or in-process in 0.12.0 (`openAgentState`, 0.12.1, is a candidate for the run store later) |

Not used, with the reason in `spec/workspace-1.md` §10 and the package README: `@appport/services` jobs, secrets, API keys and webhooks;
Chip; AuthBoundry in process.

## 8. Authority and evidence

AppWorks introduces none. In particular:

* a lock records assumptions and grants nothing; binding still requires an authorization grant for the provider's capability;
* a valid Distribution Protocol signature, a trusted publisher, a matching artifact digest and a verified package binding establish that bytes
  are the package a publisher released, not that it fulfils any contract, may run, or achieved anything;
* verification of steps and outcomes is declared in AppPort's state-verification model; the evidence a future runtime records is AppPort's
  `VerificationEvidence`;
* an assessment's evidence describes source text (observed), conclusions drawn from it (inferred) and what could not be determined
  (unknown). It is not AppPort verification evidence, and its `scope` states that it grants nothing, verifies nothing and modified nothing;
* the workspace's approvals are per action class and per exact subject, and are enforced where the action runs; a verified extraction
  is not an approval, and `ready-for-promotion` deploys nothing;
* an adopted contract is a reviewed decision to publish a contract through the application's own integration; it grants no authority,
  registers nothing and claims no equivalence. A verified promotion is verified for exactly the extraction's subject, not approved for
  review, commit, push or production;
* an extraction's verification records state, per behavior, what a named procedure established for one source revision, contract and
  adapter. They are not authorization: a caller still needs its own application credential and AppPort's authorization at the boundary,
  and discovering the capability grants nothing.
