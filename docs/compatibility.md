# Compatibility and evolution policy

## 1. What is versioned, and how

| Axis | Identifier | Rule |
|---|---|---|
| Recipe source format | `format: "appport.recipe/1"` | A reader accepts exactly the versions it implements and refuses every other (`RECIPE_FORMAT`), and refuses undocumented members. A new major format is a new string. |
| Lock format | `appport.recipe-lock/1` | as above (`LOCK_FORMAT`) |
| Package format | `appport.recipe-package/1`, `kind` | as above; an unknown or reserved `kind` (`compiled`) is refused, never read as executable |
| Package content | package `digest` | any change to any member gives a new digest; a package is immutable |
| Logical recipe | recipe `id` (reverse-domain) | stable across revisions and releases |
| Recipe release | Distribution Protocol product release, SemVer | immutable once published; owned by Distribution Protocol |
| Canonical capability | AppPort contract id, capability, integer major version, `contractDigest`, `capabilityDigest` | owned by AppPort; never SemVer |
| npm packages | `@appport/recipe`, `@appport/recipe-distribution` versions | SemVer for the library API, independently of the formats they read |
| Distribution Protocol | `distribution/1` | the adapter pins the protocol version and package version it was written against |

Changes that are **compatible** within a format version: adding a finding code, adding a warning, tightening a message. Changes that are
**not**: accepting a document a previous reader refused only if every previous reader would interpret it the same way; anything else is a
new format version. Library releases follow SemVer: a new required option, a removed export or a changed result shape is a major release.

## 2. Format namespace

The formats keep the names they were drafted under (`appport.recipe/1`, …). `appport.*` names the ecosystem; it does not make these formats
part of the AppPort protocol, which neither defines nor reads them (`docs/architecture.md` §2). They were never released by AppPort, so moving
their implementation here changes no installed base.

## 3. AppPort APIs used before they are published

AppWorks builds against **published** AppPort 1.1.0. The canonical-capability work is merged on AppPort `main` (rkendel1/appport#276,
#277) but not released. Until it is, `packages/recipe/src/appport-compat.ts` holds the minimum AppWorks needs from it, and nothing else:

| Item in `appport-compat.ts` | Defined by (AppPort `main`) | Replace with, once published |
|---|---|---|
| `CANONICAL_CONTRACT_EXTENSION`, `isCanonicalContract` | AppPort `fulfillment-1` §2 | the same exports of `@appport/protocol` |
| `CanonicalDependencyTarget`, `RecipeDependency`, `isCanonicalDependencyTarget` | AppPort `dependencies-1` §3, canonical targets | `Dependency`, `CanonicalDependencyTarget`, `isCanonicalDependencyTarget` |
| `lintCanonicalDependencies` | the canonical-target branch of `lintIntegration` | `lintIntegration` on a manifest carrying the dependencies |
| `FulfillmentStatus` | AppPort `fulfillment-1` §4 | `FulfillmentStatus` |

And two adapters over published APIs that can become direct calls:

| Adapter | Uses today | Direct call once published |
|---|---|---|
| `rules.ts` (`lintRecipeRules`) | `lintMapping`, rule by rule, on a synthetic source record | `lintRule` (`@appport/integration`, merged on `main`) |
| `interfaceChanges` in `validate.ts` | `compareManifests` on single-capability manifests | `compareSchemas` (`@appport/protocol`, merged on `main`) |

Each replacement is a patch-level change if behavior is identical, which the existing tests check (`schemas.test.ts` asserts the rule adapter
reports exactly what `lintMapping` reports).

Not used at all yet, because not published: AppPort `@appport/core`'s canonical discovery, `resolvedDependency()` and canonical bindings.
`createRecipeLock` reads `resolvedDependency()` records structurally (`ResolvedDependencyRecord`) and is tested against their documented
shape; once `@appport/core` publishes them, add a test that feeds real records (the AppPort branch had one: see §5).

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
| calls to unpublished `lintRule`, `requiredTargetsNotProduced`, `schemaTypes`, `compareSchemas`, `lintIntegration` (canonical targets) | published `lintMapping` / `compareManifests` through `rules.ts` and `interfaceChanges`; `appport-compat.ts` (§3) |
| `spec/recipe-1.md`, `spec/schemas/recipe*.schema.json` | `spec/recipe-1.md`, `packages/recipe/schemas/` |
| `examples/supplier-invoice-recipe/` | `examples/supplier-invoice/` |
| `packages/integration/test/recipe*.ts` | `packages/recipe/test/` (same cases) |
| `spec/test/recipe-contract.test.ts` | schema alignment: `packages/recipe/test/schemas.test.ts`; tests over real `@appport/core` resolution: pending its release (§3) |

Semantics are unchanged: the same 62 source, lock and package test cases (44 + 18) pass against published AppPort.

The generic part of that commit, extracting `lintRule` from `lintMapping`, is an AppPort integration primitive and stays in AppPort.
