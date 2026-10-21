# AppWorks product charter

## Mission

Make business functionality something an organization can **find, package, compose and replace** deliberately: in applications it is
building, and in applications it already runs.

AppWorks is a product in the AppPort ecosystem. AppPort makes a business function discoverable and invocable through a canonical contract.
AppWorks works one level up: it decides which functions an application needs or has, packages them with their requirements, composes them
into business processes, and plans how one implementation replaces another.

## Three concepts, kept apart

| Concept | What it is | Defined by | Example |
|---|---|---|---|
| **Capability** | A business function with a canonical contract, discoverable and invocable through AppPort. Applications fulfil it under their own names; a valid fulfillment claim, not a matching name, makes a provider eligible. | AppPort (`@appport/protocol`, `@appport/core`) | `org.example.accounting` / `invoice.submit@1` |
| **Package** | A versioned, immutable artifact that contains or describes a unit of business functionality together with its requirements: the contracts it relies on, at which revisions, and what an environment must provide. | AppWorks (`appport.recipe-package/1`, today for recipes) | the supplier-invoice recipe package, digest `sha256:…` |
| **Recipe** | A composition of capabilities, rules, transformations and human decisions that describes one business process, with its verification. | AppWorks (`appport.recipe/1`) | receive → check duplicate → approve if required → submit → verify |

A capability is not a package: it is a contract, and many implementations can fulfil it. A recipe is not a capability: it composes
capabilities and never names a provider. A package is not a release: Distribution Protocol releases packages, and a release's signature is
not evidence that anything inside it works.

## Two entry points, one model

**New applications.** Define the capabilities and requirements first, as canonical contracts. Implement them, and package them with their
requirements. Compose them into applications and business processes as recipes.

**Existing applications.** Inspect the codebase and discover the behavior it already has. Expose that behavior as capabilities through
AppPort. Characterize it: what it does, what it relies on, how its effects are verified. Extract functionality into packages, and replace
implementations incrementally, one capability at a time, with the recipe unchanged because it names the capability, not the implementation.

Both paths converge on **the same canonical capability contracts and the same package model**. A capability discovered in a legacy system and
one designed for a new application are the same kind of thing, fulfilled, resolved and invoked the same way.

## What exists today

| Area | Status |
|---|---|
| Recipe source model, expressions, validation (`@appport/recipe`) | implemented, draft format `appport.recipe/1` |
| Dependency locks and source packages (`@appport/recipe`) | implemented, draft formats `appport.recipe-lock/1`, `appport.recipe-package/1`; locks built from real AppPort resolution (`@appport/core` 1.3.0) |
| Distribution boundary: release manifest, acceptance of acquired bytes (`@appport/recipe-distribution`) | implemented against `@distribution-protocol/protocol` 1.0.0 |
| Publishing and acquisition (registries, fetching, receipts) | **not implemented** |
| Recipe compiler | **not implemented** (the runtime interprets validated source directly) |
| Recipe runtime (`@appport/recipe-runtime`, private, `spec/runtime-1.md`) | **first vertical slice**: durable runs in FeltDB; decisions, transforms, capability steps and human tasks over the `copy`/`const`/`compute` rules; capabilities resolved, authorized and invoked afresh through `@appport/core`; intent recorded before every invocation; independent verification before `completed`; a lost or unrecorded consequential outcome is `uncertain` and never resubmitted, and can be reconciled by looking the original operation up by its durable key (confirmed completion is verified independently; non-execution needs a strongly consistent, fenced provider answer; otherwise it stays uncertain); every crash boundary is tabulated and tested with real process kills (`spec/runtime-1.md` §13); a recorded result with inconclusive verification is recovered by re-verifying, never by invoking again, and is reported apart from an unknown outcome and from an unexpected one; a worker that lost its lease cannot write; `appworks recipe run`/`status`/`resume`/`reconcile`/`answer`/`expire`. Exercised by the supplier-invoice recipe against a ledger with persisted state (`packages/recipe-runtime/test`). **Not done:** `enum`/`unit`/`encoding` rules and preconditions (refused at start), a remote gateway, timers, reconciliation of a run that is uncertain for a reason other than one lost invocation or one unverified recorded result, a task UI, packages as a source, any real-world provider. The accounting contract is the example's illustrative one, registered only in the test registry |
| Repository assessment, capability discovery in existing code (`@appport/assessment`) | implemented for Go and Protocol Buffers, draft format `appport.application-assessment/1`: static, evidence-backed candidates and one recommended exposure candidate; verifies nothing |
| Capability extraction (`@appport/extraction`) | implemented for read-only request/response operations, draft format `appport.capability-extraction/2` (reads `/1`): one assessed candidate, a proposed AppPort canonical contract with an explained mapping, an adapter hosted by the application's existing AppPort boundary, the AppPort fulfillment claim that boundary publishes, and per-behavior verification tied to source revision, contract, adapter, declaration and runtime. First extraction: Memos `ListMemoReactions` as `memos.reactions.list@1`. Revision 1 (Memos `c0eeec7`): 17 of 18 passed, claim undeclared because the bridge could not publish manifest attributes. Revision 2 (Memos `e0ce856`, which adds that pass-through to the bridge): 21 of 21 passed against a real Memos, claim published, discovered and valid |
| Adoption of proposed contracts, in-process canonical registration of remote bridges, merging the Memos bridge change into upstream Memos (`usememos/memos`) | **not done** (open questions in the extraction; the fork `rkendel1/memos` merged it into its own `main` in #2) |
| Project workspace and orchestrator (`@appport/workspace`, private) | implemented: one FeltDB-backed workflow (`feltdb.flow`) from a pinned repository revision through integration inspection, discovery, assessment, reconciliation, selection, plan validation, approval, extraction and verification to readiness for promotion; web workspace (stack-ui) and `appworks project` CLI over the same domain; approvals enforced at the action boundary; resumable. End to end on Memos `e0ce856` |
| Contract adoption and promotion (`@appport/workspace`) | implemented: an explicit, approved contract-adoption proposal (`appworks.contract-adoption/1`), a deterministic promotion artifact (`appworks.promotion/1`) from a reviewed promotion plan, applied as additions to an isolated worktree under its own approval, verified with the extraction's own suite and mutants against the promoted copy, ready for review, committed locally under its own approval. End to end on Memos `e0ce856` |
| Push, pull requests for a promotion, deployment | **not implemented** (enforced and refused: `@appport/github` 1.0.2 has no push, commit or compare contract; no deployment contract) |
| Write-capability extraction, source extraction into portable implementations, replacement planning, migration | **not implemented** |
| Visual Recipe Studio | **not implemented** |

The recipe runtime executes recipes only in the slice above, against test providers; nothing in this repository extracts code, migrates an application or establishes that a business outcome occurred. An
assessment reads an application; it does not run it, change it, or establish that anything it describes behaves as described. An
extraction exposes one existing operation through the application's existing boundary without changing the application; it grants no
access, deploys nothing, and establishes only the behaviors its verification records say passed, for the revision, contract and adapter
they name.

## Principles

1. **AppWorks depends on AppPort; AppPort never depends on AppWorks.** AppWorks uses AppPort's published contracts and APIs and does not
   re-implement capability identity, fulfillment, resolution, authorization or invocation.
2. **No second authority.** AppWorks adds no control plane, authorization system, persistence authority or evidence format. A lock, a
   package, a signature or a verified binding grants nothing.
3. **Business processes are software.** A recipe is structured, inspectable source with a closed vocabulary, validated before anything
   runs. It is never reconstructed by a model at run time, and it embeds no code.
4. **Uncertainty stays visible.** An effect that may or may not have happened is routed explicitly, never retried implicitly, never reported
   as success.
5. **Say what is not implemented.** Documentation, findings and results state what a check establishes and what it does not.
