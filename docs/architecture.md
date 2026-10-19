# Architecture and dependency boundaries

## 1. Layers

| Layer | Responsibility | Where |
|---|---|---|
| **AppPort** | Canonical capability contracts, discovery, fulfillment validation, dependency resolution, invocation boundaries, reusable integration primitives (mapping rules, verification, schema compatibility) | `rkendel1/appport`: `@appport/protocol`, `@appport/schema`, `@appport/integration`, `@appport/core`, … |
| **AppWorks** | Application assessment, business-capability extraction, recipe composition, versioned business packages, replacement planning; later, compilation and execution of business processes | this repository: `@appport/recipe`, `@appport/recipe-distribution` |
| **Distribution Protocol** | Independent publication, acquisition and verification of software releases | `rkendel1/distribution-protocol`: `@distribution-protocol/*` |
| **Execution and authority infrastructure** | Authorization grants, bindings, execution control, durable state, evidence | AppPort's established layers (`@appport/core`, `@appport/authorization`); unchanged by AppWorks |

## 2. Repository, package name and responsibility are three different things

AppWorks publishes under the `@appport/*` npm scope. The scope names the **ecosystem** a developer installs from; it is not a statement that
a package belongs to the AppPort protocol or lives in the AppPort repository.

| | Repository | Packages | Responsibility |
|---|---|---|---|
| Protocol layer | `rkendel1/appport` | `@appport/protocol`, `@appport/integration`, `@appport/core`, `@appport/sdk`, … | capability protocol, discovery, fulfillment, integration |
| Product | `rkendel1/appworks` | `@appport/recipe`, `@appport/recipe-distribution`; later, when their boundaries justify it, e.g. a compiler or assessment package | business recipes, packages, modernization |
| Distribution | `rkendel1/distribution-protocol` | `@distribution-protocol/*` | publication, acquisition, verification |

Likewise, the recipe formats are named `appport.recipe/1`, `appport.recipe-lock/1` and `appport.recipe-package/1`, and the Distribution
Protocol binding scheme `appport/recipe-package/1`: ecosystem names, specified and owned here (`spec/recipe-1.md`). AppPort's protocol
specification does not define them, and AppPort's packages neither implement nor read them.

Each package is versioned and released independently, with its own changelog and compatibility contract. A new recipe release does not
require an AppPort release, and an AppPort release does not require an AppWorks release.

## 3. Dependency rules

```
@appport/recipe-distribution ──→ @appport/recipe ──→ @appport/integration ──→ @appport/protocol
            │                          └────────────→ @appport/schema ──────────→ @appport/protocol
            └──→ @distribution-protocol/protocol

AppPort packages ──✗──→ anything in this repository
@appport/recipe  ──✗──→ @appport/core, @distribution-protocol/*, any registry
```

1. **AppWorks depends on AppPort; AppPort does not depend on AppWorks.** AppWorks consumes AppPort's **published** packages at exact versions,
   so it builds, tests and installs without an AppPort checkout. No `workspace:`, `link:`, `file:` or git dependency on an AppPort package,
   and no import, path alias or project reference into a sibling checkout.
2. **`@appport/recipe` depends only on `@appport/protocol`, `@appport/schema` and `@appport/integration`.** It reads `@appport/core`'s
   `resolvedDependency()` records structurally and has no dependency on the runtime.
3. **Only `@appport/recipe-distribution` depends on Distribution Protocol.** The recipe model, validation, locks and package format work with
   no distribution layer and no registry.
4. **No code execution in the recipe model.** No `eval`, `Function`, dynamic import, `vm` or child process.
5. **No parallel implementations.** Canonical capability identity, fulfillment validation, resolution, authorization and invocation are
   AppPort's. Where AppWorks needs an AppPort check that is merged but not yet published, it is isolated in `appport-compat.ts`, limited to
   wire-format constants and shape checks, and listed in `docs/compatibility.md` §3 for removal.

`scripts/check-boundary.mjs` enforces 1–4 on every build. Rule 5 is a review rule.

## 4. How the recipe layer uses AppPort

| AppWorks needs | Published AppPort API used |
|---|---|
| Check transformation rules (types, units, encodings, enums, concepts, defaults, required fields) | `lintMapping`, `schemaIdentity` (`@appport/integration`), through `rules.ts` |
| Compare a step's expected interface with the contract | `compareManifests` (`@appport/protocol`) |
| Digests and canonical JSON | `digestOf`, `canonicalize`, `contractDigest`, `capabilityDigest`, `isDigest` |
| Pointers and schema lookup | `schemaAt`, `isRequiredAt`, `parsePointer`, `isPointer`, `readPointer` |
| Versions and dependency references | `isVersionConstraint`, `satisfiesVersionConstraint`, `parseDependencyRef` |
| Contract metadata | `getIntegration`, `findCapabilityVersion`, `validateSemanticAnnotations`, `isValidApplicationId` |
| Input validation | `fromJSONSchema` (`@appport/schema`) |
| Verification and precondition model | `StateExpectation`, `ValueRef`, `EffectDescriptor` types |

Not reused because not yet published: the canonical-contract marker and canonical dependency targets (AppPort `fulfillment-1` and
`dependencies-1`; see `docs/compatibility.md` §3), and canonical discovery and resolution in `@appport/core`, which recipe environments
need (`spec/recipe-1.md` §7.1, steps 2 and 10).

## 5. Authority and evidence

AppWorks introduces none. In particular:

* a lock records assumptions and grants nothing; binding still requires an authorization grant for the provider's capability;
* a valid Distribution Protocol signature, a trusted publisher, a matching artifact digest and a verified package binding establish that bytes
  are the package a publisher released, not that it fulfils any contract, may run, or achieved anything;
* verification of steps and outcomes is declared in AppPort's state-verification model; the evidence a future runtime records is AppPort's
  `VerificationEvidence`.
