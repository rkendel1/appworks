# Compatibility and evolution policy

## 1. What is versioned, and how

| Axis | Identifier | Rule |
|---|---|---|
| Recipe source format | `format: "appport.recipe/1"` | A reader accepts exactly the versions it implements and refuses every other (`RECIPE_FORMAT`), and refuses undocumented members. A new major format is a new string. |
| Lock format | `appport.recipe-lock/1` | as above (`LOCK_FORMAT`) |
| Extraction format | `appport.capability-extraction/1`; inputs `appport.capability-extraction-plan/1`, `appport.capability-verification-results/1` | as above (`EXTRACTION_FORMAT`). An extraction's own `identity.revision` increases whenever source revision, contract or adapter change, and names the previous digest; a breaking contract change needs a new capability version; results apply only to the source, contract and adapter they name (`spec/extraction-1.md` §7) |
| Assessment format | `appport.application-assessment/1` | as above (`ASSESSMENT_FORMAT`). The scanner rules are versioned separately (`configuration.scanner`, `appport.assessment-scanner/1`): a change in what is recognized or how candidates are classified is a new scanner version, so the same tree may assess differently under a new tool version; the digest covers the tool version |
| Package format | `appport.recipe-package/1`, `kind` | as above; an unknown or reserved `kind` (`compiled`) is refused, never read as executable |
| Package content | package `digest` | any change to any member gives a new digest; a package is immutable |
| Logical recipe | recipe `id` (reverse-domain) | stable across revisions and releases |
| Recipe release | Distribution Protocol product release, SemVer | immutable once published; owned by Distribution Protocol |
| Canonical capability | AppPort contract id, capability, integer major version, `contractDigest`, `capabilityDigest` | owned by AppPort; never SemVer |
| npm packages | `@appport/recipe`, `@appport/recipe-distribution`, `@appport/assessment`, `@appport/extraction` versions | SemVer for the library API and the `appworks` CLI (commands, options, exit statuses), independently of the formats they read. The `appworks` command is `@appport/extraction`'s; `@appport/assessment` alone installs `appworks-assess` (same `assess` and `verify` commands) |
| Distribution Protocol | `distribution/1` | the adapter pins the protocol version and package version it was written against |

Changes that are **compatible** within a format version: adding a finding code, adding a warning, tightening a message. Changes that are
**not**: accepting a document a previous reader refused only if every previous reader would interpret it the same way; anything else is a
new format version. Library releases follow SemVer: a new required option, a removed export or a changed result shape is a major release.

## 2. Format namespace

The formats keep the names they were drafted under (`appport.recipe/1`, …). `appport.*` names the ecosystem; it does not make these formats
part of the AppPort protocol, which neither defines nor reads them (`docs/architecture.md` §2). They were never released by AppPort, so moving
their implementation here changes no installed base.

## 3. AppPort versions and APIs

AppWorks consumes the **published** AppPort canonical-capability release, at exact versions:

| Package | Version | Used by | For |
|---|---|---|---|
| `@appport/protocol` | 1.2.0 | `@appport/recipe`, `@appport/assessment`, `@appport/extraction` | assessment: `digestOf`, `canonicalize`, `sha256`, `isDigest`, `isValidName`, `JSON_SCHEMA_DIALECT`, `CapabilityVersionEntry`, `CapabilityEffect`, `JSONSchema`; recipe: `Dependency` and `CanonicalDependencyTarget`, `isCanonicalDependencyTarget`, `lintIntegration`, `isCanonicalContract`, `compareSchemas`, `FulfillmentClaim`, `FulfillmentStatus`, digests, pointers, versions |
| `@appport/schema` | 1.1.1 | `@appport/recipe`, `@appport/extraction` (schema compilation); `@appport/assessment` tests only | input validation (`fromJSONSchema`); pinned to the version `@appport/integration` 1.2.0 pins, so one copy is installed |
| `@appport/integration` | 1.2.0 | `@appport/recipe` | `lintRule`, `requiredTargetsNotProduced`, `Rule` |
| `@appport/core` | 1.3.0 | tests only (`devDependency`) | real canonical contracts, discovery, resolution, `resolvedDependency()`, bindings, grants and invocation in `canonical-resolution.test.ts` and the release check |
| `@appport/sdk` | 1.2.2 | `extractions/memos-reactions` only (private, unpublished) | the exact version the Memos bridge's `package-lock.json` pins, with the same `@appport/*` 1.1-line dependencies, so the adapter runs on the bridge's own AppPort runtime |

`@appport/recipe` does not depend on `@appport/core` at run time: `createRecipeLock` takes `resolvedDependency()` records from whoever resolved
them, and `ResolvedDependencyRecord` is the part of that record it reads. The tests check, at compile time and against installed artifacts,
that core's published `ResolvedDependency` satisfies it.

**Removed in this release of the AppWorks packages** (they existed only while the AppPort API was unpublished):

| Removed | Replaced by |
|---|---|
| `appport-compat.ts`: `CANONICAL_CONTRACT_EXTENSION`, `isCanonicalContract` | the same exports of `@appport/protocol` 1.2.0 |
| `appport-compat.ts`: `CanonicalDependencyTarget`, `RecipeDependency`, `isCanonicalDependencyTarget` | `Dependency`, `CanonicalDependencyTarget`, `isCanonicalDependencyTarget` of `@appport/protocol` |
| `appport-compat.ts`: `lintCanonicalDependencies` | `lintIntegration`, which checks canonical targets |
| `appport-compat.ts`: `FulfillmentStatus` | `FulfillmentStatus` of `@appport/protocol` |
| `rules.ts`: `lintRecipeRules` (a `lintMapping` adapter) | `lintRule` and `requiredTargetsNotProduced` of `@appport/integration` |
| `interfaceChanges` (a `compareManifests` adapter) | `compareSchemas` of `@appport/protocol` |

No gap remains: every check AppWorks needed is published. These were exports of an unreleased `@appport/recipe` 0.1.0, so nothing published
changes. Validation behavior is unchanged; all source, lock and package tests pass against the published APIs.

**Known AppPort limitations that apply to recipe environments** (AppPort `fulfillment-1` §7): authority equivalence decisions are supplied to
the resolver, not stored, so a binding is not revalidated when they change; the synchronous withdrawal fence that refuses a stale binding
before execution is per registry instance, so another process sharing a store sees a revision on its next authority read.

## 4. Evolution rules

* **A change to one capability implementation never rewrites recipe source.** A provider re-registration requires re-resolution
  (`LOCK_PROVIDER_CHANGED`), not a source change.
* **A change to a canonical contract is visible as a contract change.** A changed `contractDigest` or `capabilityDigest` requires
  revalidation (`LOCK_CONTRACT_CHANGED`, `LOCK_CAPABILITY_CHANGED`).
* **A package release is immutable** once published through Distribution Protocol. A new release does not alter an existing installation or
  an execution already started. There is no automatic upgrade.
* **Locks are regenerated, not edited**; a provider changes only through `substituteProvider`, which requires a valid fulfillment of the same
  canonical revision.

## 5. Provenance of this code

The recipe model was first written on AppPort branch `claude/canonical-capability-discovery-rzlpmy`, commit `fe35f4f`, as
`packages/integration/src/recipe*.ts`, `spec/recipe-1.md`, three schemas, an example and tests. It moved here, where it belongs:

| At `fe35f4f` (AppPort) | Here |
|---|---|
| `packages/integration/src/recipe.ts`, `recipe-expression.ts`, `recipe-validate.ts`, `recipe-lock.ts`, `recipe-package.ts` | `packages/recipe/src/source.ts`, `expression.ts`, `validate.ts`, `lock.ts`, `package.ts` |
| calls to `lintRule`, `requiredTargetsNotProduced`, `schemaTypes`, `compareSchemas`, `lintIntegration` (canonical targets) | the same published calls (§3), except `schemaTypes`, now a local helper in `expression.ts`; adapters used before AppPort 1.2.0 are removed |
| `spec/recipe-1.md`, `spec/schemas/recipe*.schema.json` | `spec/recipe-1.md`, `packages/recipe/schemas/` |
| `examples/supplier-invoice-recipe/` | `examples/supplier-invoice/` |
| `packages/integration/test/recipe*.ts` | `packages/recipe/test/` (same cases) |
| `spec/test/recipe-contract.test.ts` | schema alignment: `packages/recipe/test/schemas.test.ts`; locks, substitution and bindings over real `@appport/core` resolution: `packages/recipe/test/canonical-resolution.test.ts` |

Semantics are unchanged. Lock cases that needed a resolution, which once used hand-built records, now run against real AppPort resolution.

The generic part of that commit, extracting `lintRule` from `lintMapping`, is an AppPort integration primitive and stays in AppPort.
