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
| Dependency locks and source packages (`@appport/recipe`) | implemented, draft formats `appport.recipe-lock/1`, `appport.recipe-package/1` |
| Distribution boundary: release manifest, acceptance of acquired bytes (`@appport/recipe-distribution`) | implemented against `@distribution-protocol/protocol` 1.0.0 |
| Publishing and acquisition (registries, fetching, receipts) | **not implemented** |
| Recipe compiler | **not implemented** |
| Recipe runtime, durable orchestration, human-task persistence | **not implemented** |
| Repository assessment, capability discovery in existing code | **not implemented** |
| Automated extraction, replacement planning, migration | **not implemented** |
| Visual Recipe Studio | **not implemented** |

Nothing in this repository executes a recipe, extracts code, migrates an application or establishes that a business outcome occurred.

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
