# Business recipes, dependency locks and packages (`appport.recipe/1`, `appport.recipe-lock/1`, `appport.recipe-package/1`)

**Status:** Draft, owned by AppWorks. Source model, validation, lock and package format, and the Distribution Protocol boundary: there is **no
recipe compiler and no recipe runtime yet**, so no recipe in this version is executable, and no package is distributed end to end.
Reference implementation: `@appport/recipe` and `@appport/recipe-distribution` in this repository. Schemas:
`packages/recipe/schemas/recipe.schema.json`, `recipe-lock.schema.json`, `recipe-package.schema.json` (shipped in `@appport/recipe`).
Example: `examples/supplier-invoice/`.

These formats are named in the `appport.*` ecosystem namespace and are **not** part of the AppPort protocol: AppPort does not define,
implement or depend on them (`docs/architecture.md` §2). They build on AppPort specifications, referred to below as AppPort `fulfillment-1`
([canonical capabilities and fulfillment](https://github.com/rkendel1/appport/blob/main/spec/fulfillment-1.md)), AppPort `dependencies-1`
([dependencies](https://github.com/rkendel1/appport/blob/main/spec/dependencies-1.md)) and AppPort `mapping-1`
([rules and verification](https://github.com/rkendel1/appport/blob/main/spec/mapping-1.md)).

## 1. Purpose, and the rule

A recipe states a business process as software: what it must accomplish, which canonical capabilities it composes, how data moves between
them, which rules decide the route, where a person must act, and how each effect and the final outcome are verified. The process is in the
source, not in a prompt, and is never reconstructed by a model at run time.

**A recipe names canonical capabilities, never providers.** Which application fulfils a capability is decided by resolution in the receiving
environment (AppPort `fulfillment-1` §5); the recipe does not change when an implementation does.

## 2. Responsibilities and dependency direction

| Layer | Owns | Package (repository) |
|---|---|---|
| AppPort protocol | canonical contracts, fulfillment, compatibility, integration semantics | `@appport/protocol`, `@appport/integration` (appport) |
| AppPort core | registration, discovery, resolution, bindings, authorization integration, invocation | `@appport/core` (appport) |
| Recipe source and package model | process structure, decisions, transformations, control flow, tasks, verification, dependency declarations, locks, packages | `@appport/recipe` (appworks) |
| Distribution boundary | recipe package ↔ `distribution/1` release manifest; consumer-side acceptance of acquired bytes | `@appport/recipe-distribution` (appworks) |
| Recipe compiler (future) | validated source → deterministic executable representation | not implemented |
| Recipe runtime (future) | durable execution through core's invocation, authorization and verification; task persistence; outcome aggregation | not implemented |
| Distribution Protocol | signed releases, registry-independent product identity, resolution, acquisition, content verification, receipts | `@distribution-protocol/*` (distribution-protocol) |

```
@appport/recipe-distribution ──→ @appport/recipe ──→ @appport/integration ──→ @appport/protocol
            │                          │      └────→ @appport/schema ───────────────↗
            └──→ @distribution-protocol/protocol    ┆ reads @appport/core's resolvedDependency() records structurally; no import
```

`@appport/recipe` depends only on published AppPort packages, and never on `@appport/core`, Distribution Protocol or a registry. Only
`@appport/recipe-distribution` depends on Distribution Protocol. AppPort depends on none of these. `scripts/check-boundary.mjs` enforces it.

**Reuse.** Rules are checked by AppPort's mapping lint (`lintMapping`), interfaces by its evolution rules (`compareManifests`), schemas
by its semantic-annotation checks, digests by `digestOf`, `contractDigest` and `capabilityDigest`, versions by its version constraints. The
canonical-capability additions to AppPort (the canonical-contract marker and the canonical dependency target) are merged on AppPort `main` but
not yet published; the few wire-format checks AppWorks needs from them are isolated in `packages/recipe/src/appport-compat.ts` until they
are (`docs/compatibility.md` §3).

## 3. Source model (`appport.recipe/1`)

### 3.1 Identity and metadata

| Member | Meaning |
|---|---|
| `format` | `"appport.recipe/1"`. Any other value is refused (`RECIPE_FORMAT`); there is no best-effort reading of a later version. |
| `id` | The recipe's **business identity**: a reverse-domain identifier (`org.example.recipes.supplier-invoice`). Stable across revisions and releases. Never a URL, never a digest of the content. |
| `name`, `description` | Prose. |
| `objective` | The business objective, in prose. |
| `inputs`, `outputs` | Object JSON Schemas with optional `x-appport-*` annotations (concept, unit, encoding). `outputs` is the contract of a `completed` run. |
| `outcome` | `{ description, effects?, verify }`: the final business outcome, its declared effect types, and its state verification. |
| `requires` | Declared canonical dependencies (§3.3). |
| `start`, `steps` | The first step and the steps (§3.5–§3.8). |
| `provenance` | `{ authors?, source?: { repository?, path?, revision? } }`. Descriptive: never an identity or a trust claim. |

Every object is closed: an undocumented member is an error, never ignored, so no member can quietly acquire meaning.

A release of a recipe is **not** identified here. Release lineage and versions belong to Distribution Protocol (§7.2).

### 3.2 Data

Recipe data is `{ "input": …, "steps": { "<id>": { "output": … } } }`, addressed by JSON Pointer: `/input/amount`,
`/steps/check-duplicate/output/duplicate`. Each step output is typed by a schema the recipe declares (a capability step's `expects.output`, a
transform's `output`, a task's `response`); decisions and ends have none. State is explicit and single-assignment: a transform step defines a
named, typed value. There is no mutable state.

A reference to a step output is valid only where that step has **completed with an output on every path** to the referencing step
(`REFERENCE_UNAVAILABLE` otherwise). A capability's output is not available along its `failure` or `uncertain` edges; a task's response is not
available along `unanswered`.

### 3.3 Dependencies

`requires` holds `Dependency` values (AppPort `dependencies-1` §3) with a **canonical target** `{ contract, capability, provider? }`, a
relationship of `invokes` or `observes`, and `required: true`. They are validated by the same rules as every AppPort dependency
(AppPort `lintIntegration`; until it is published with canonical targets, `appport-compat.ts`), plus: an application target is refused (`DEPENDENCY_NOT_CANONICAL`); optional and `delegates`/`consumes-event`
dependencies are not supported. Versions use AppPort's integer major versions and constraints (`1`, `^1`, `>=2`, …), never SemVer.

`target.provider` is a **constraint** on resolution, distinct from the canonical requirement: it restricts which claims may satisfy it. It is
never a guarantee that the provider fulfils the contract; only a valid fulfillment does. Steps and probes refer to dependencies by `id`.

### 3.4 Expressions

Decisions and computed values use a closed JSON expression form:

```json
{ "op": "or", "args": [
  { "op": "gt", "args": [{ "ref": "/input/amount" }, { "value": 10000 }] },
  { "op": "not", "args": [{ "op": "exists", "args": [{ "ref": "/input/purchaseOrder" }] }] } ] }
```

| Form | Type |
|---|---|
| `{ "value": scalar }` | the literal's type; a list literal only as the second operand of `in` |
| `{ "ref": pointer }` | from the schema at the pointer; carries its `x-appport-unit` |
| `eq`, `ne` | two scalars of overlapping type and, if both have units, the same unit → boolean |
| `lt`, `le`, `gt`, `ge` | two numbers, same unit if both have one → boolean |
| `and`, `or` (2–16), `not` | booleans → boolean |
| `exists` | a reference → boolean |
| `coalesce` (2–16) | the first present operand; the last must always be present |
| `if` | boolean, then, else → the branches' type |
| `in` | a scalar and a list literal → boolean |

There are no functions, variables, loops, clocks, randomness or code. Nesting is bounded (32). A value that may be absent (not required on
every level of its schema) must be tested with `exists` or given a fallback with `coalesce` before it is consumed (`EXPRESSION_OPTIONAL`);
`and(exists(x), …)` and `if(exists(x), …, …)` guard `x` for the operands they govern. `evaluateExpression` is a pure reference evaluator that
fails closed on an operand of the wrong type rather than coercing it, so rules can be tested on their own.

### 3.5 Capability steps

```json
{ "id": "submit", "kind": "capability", "uses": "submit-invoice", "effect": "consequential",
  "expects": { "input": { … }, "output": { … } },
  "input": [ { "op": "copy", "from": "/input/amount", "to": "/amount" } ],
  "approval": { "task": "request-approval" },
  "preconditions": [ … ], "verify": { "methods": ["invoice-recorded"], "additional": [ … ] },
  "on": { "success": "submitted", "failure": "submission-failed", "uncertain": "submission-uncertain" } }
```

* `uses` names a declared canonical dependency. `effect` is what the recipe relies on; the environment check compares it with the contract.
* `expects` are the canonical shapes the recipe was written against. Recipe data references use `expects.output`; the environment check
  compares both with the contract by AppPort's evolution rules (`compareManifests`), with the same direction rules as manifest evolution and fulfillment.
* `input` uses the `appport.mapping/1` rule vocabulary (`copy` for selection and renaming with an explicit `default` for missing data, `const`,
  `enum`, `unit`, `encoding`) plus `compute` (`{ op, to, expr }`). Rules are checked by **AppPort's own `lintMapping`**, rule by rule, as mapping artifacts are:
  declared pointers, types, units, encodings, enum tables, concepts, and optional-to-required without a default. Every required input field
  must be produced (`MAPPING_INCOMPLETE`). A concept change needs `conceptRelation: "exact"`: recipes have no way to declare a loss of
  meaning.
* `approval.task` names a task step with `approval: true` that is answered on every path to this step.
* `preconditions` and `verify.additional` are `appport.integration/1` preconditions and state verifications (`StateExpectation`, `ValueRef`)
  whose probe is a declared dependency (`via: { uses, input }`); `$input`/`$output` refer to this invocation. They **add** to the
  capability's own preconditions and verification and never replace them.
* `verify.methods` names the canonical capability's declared verification methods. Every declared state method of the contract must be listed
  (`ENV_VERIFICATION_WEAKENED`): composing a capability never weakens it.

**Outcomes.** Invocation completion and verification are kept apart:

| Edge | Taken when |
|---|---|
| `success` | the invocation completed **and** every required verification method confirmed the effect (or none is required: observation) |
| `failure` | the invocation failed with declared effect `none`, or verification contradicted the effect (it MUST be treated as not having happened) |
| `uncertain` | the effect may or may not have happened: a failure with effect `possible` or `unknown`, or verification that reached no conclusion |

`uncertain` is required for a consequential step (`UNCERTAIN_UNHANDLED`) and, in an environment, for any step whose contract declares a
failure that may have had an effect (`ENV_UNCERTAIN_UNHANDLED`). Nothing is retried implicitly: there is no retry member, and cycles are
refused. Re-invoking the same consequential dependency after an uncertain outcome must be written as a separate step and is reported
(`REINVOKED_AFTER_UNCERTAIN`), because the first effect may already have happened.

### 3.6 Decisions

`{ "kind": "decision", "cases": [ { "when": expression, "next": id } ], "otherwise": id }`: the first case whose condition holds, else
`otherwise`. Conditions are boolean and always present.

### 3.7 Transforms

`{ "kind": "transform", "output": schema, "rules": [ … ], "next": id }`: computes a named, typed value from recipe data with the rule
vocabulary of §3.5, checked the same way.

### 3.8 Human tasks

`{ "kind": "task", "purpose", "assignee": { "role" }, "approval"?, "present": [ { "label", "value": pointer } ], "response": schema,
"cases", "otherwise", "unanswered" }`. A task declares what is asked, of which role (a semantic identifier, never a person), what the person
is shown, the response schema (the step's output), the route on the response, and the route if the task is never answered. AppPort's core
invocation layer does not execute tasks and does not record approvals: the future runtime owns task persistence and orchestration, and
records who answered. A contract that requires approval (`integration.approval.required`) must be met by an approval task, assigned to the
named approver role, on every path to the invocation (`ENV_APPROVAL_REQUIRED`).

### 3.9 Ends and the final outcome

`{ "kind": "end", "outcome": "completed" | "rejected" | "failed" | "uncertain", "output"? }`. Only `completed` produces the recipe outputs
(rules into `outputs`, every required field produced) and is subject to `outcome.verify`, the **final business-outcome verification**,
which uses `$input`/`$output` for the recipe's own input and output. `uncertain` ends keep uncertainty visible for reconciliation; they are
never reported as success. A recipe with consequential steps must declare outcome verification (`VERIFICATION_MISSING`).

Three levels are distinct: **invocation completion** (a step's response), **step verification** (§3.5), **outcome verification** (here). No new
evidence format is defined: a runtime records verification as `VerificationEvidence` (AppPort `mapping-1` §10.2).

## 4. Validation

`validateRecipe(source, environment?)` is deterministic and side-effect free. It returns `{ ok, sourceOk, findings }`; each finding has a
stable `code`, `severity` (`error` | `warning`), `scope`, a JSON Pointer `path` into the source and a `message`. It never throws on
malformed input.

* **`source`** findings are defects of the recipe itself, true in every environment.
* **`environment`** findings are facts about one environment, supplied by the caller (`contracts`: active canonical contracts by id;
  `providers`: per dependency, the number of eligible providers from `discoverCanonical`). Nothing is fetched.

| Code | Scope | Meaning |
|---|---|---|
| `RECIPE_FORMAT` | source | unsupported or missing format version |
| `RECIPE_STRUCTURE` | source | missing, malformed or undocumented member |
| `RECIPE_ID_INVALID` | source | id is not a reverse-domain identifier |
| `SCHEMA_INVALID` | source | not an object schema, or invalid `x-appport-*` annotations |
| `STEP_DUPLICATE_ID`, `STEP_UNKNOWN_KIND` | source | step identity and kind |
| `TARGET_MISSING` | source | `start` or an edge names no step |
| `PATH_UNHANDLED` | source | a step does not say where an outcome leads |
| `UNCERTAIN_UNHANDLED` | source | a consequential step has no `uncertain` route |
| `CYCLE` | source | control flow cycles (not supported) |
| `STEP_UNREACHABLE` | source (warning) | not reachable from `start` |
| `REFERENCE_INVALID`, `REFERENCE_UNAVAILABLE` | source | undeclared data, or data not produced on every path |
| `EXPRESSION_INVALID`, `EXPRESSION_TYPE`, `EXPRESSION_OPTIONAL` | source | malformed, ill-typed, or unhandled absent value |
| `MAPPING_INVALID`, `MAPPING_INCOMPLETE`, `SCHEMA_MISMATCH` | source | malformed rule, unproduced required field, type/unit/encoding/enum/concept mismatch |
| `DEPENDENCY_INVALID`, `VERSION_CONSTRAINT_INVALID`, `DEPENDENCY_NOT_CANONICAL`, `DEPENDENCY_UNDECLARED` | source | dependency declarations |
| `DEPENDENCY_UNUSED` | source (warning) | declared but unused |
| `VERIFICATION_MISSING` | source | a consequential step or the outcome declares no verification |
| `APPROVAL_TASK_INVALID` | source | approval task missing, not an approval, or not answered on every path |
| `OUTCOME_OUTPUT_MISSING` | source | no completed end, or a completed end without outputs |
| `REINVOKED_AFTER_UNCERTAIN` | source (warning) | §3.5 |
| `ENV_CONTRACT_UNAVAILABLE`, `ENV_CAPABILITY_UNAVAILABLE` | environment | contract absent, not canonical, or no accepted version |
| `ENV_SCHEMA_INCOMPATIBLE`, `ENV_EFFECT_MISMATCH` | environment | the contract no longer matches `expects` / `effect` |
| `ENV_VERIFICATION_WEAKENED`, `ENV_VERIFICATION_UNKNOWN` | environment | a declared state method is dropped, or an unknown one named |
| `ENV_APPROVAL_REQUIRED`, `ENV_UNCERTAIN_UNHANDLED`, `ENV_PROBE_NOT_OBSERVATION` | environment | §3.5, §3.8 |
| `ENV_NO_ELIGIBLE_PROVIDER` / `ENV_AMBIGUOUS_PROVIDER` (warning) | environment | provider availability |

Validation makes no network call, invokes nothing, executes no business action, selects no provider and grants no authority.
`validateRecipeInput` validates an input against `inputs` before anything runs.

## 5. Dependency lock (`appport.recipe-lock/1`)

```json
{ "format": "appport.recipe-lock/1",
  "recipe": { "id": "org.example.recipes.supplier-invoice", "requires": "sha256:…" },
  "dependencies": [ {
    "id": "submit-invoice",
    "declared": { "id": "submit-invoice", "relationship": "invokes", "target": { "contract": "org.example.accounting", "capability": "invoice.submit" }, "required": true, "versionConstraint": "^1" },
    "canonical": { "contract": "org.example.accounting", "contractDigest": "sha256:…", "capability": "invoice.submit", "version": 1, "capabilityDigest": "sha256:…" },
    "resolution": {
      "provider": { "application": "com.example.ledger", "capability": { "name": "ledger.post", "version": 1 } },
      "registration": { "registrationId": "reg_…", "fingerprint": "…", "revision": 1 },
      "contractRevision": 1,
      "fulfillment": { "claim": "sha256:…", "status": "valid", "compatible": true } } } ] }
```

* `recipe.requires` is `digestOf(recipe.requires)`: the lock pins the dependency **declarations**, so editing steps does not invalidate it.
* `canonical` is **portable**: contract id, `contractDigest`, canonical capability, integer major version, `capabilityDigest`. Contracts are
  referenced by digest, never copied in.
* `resolution` is **environment-specific**: the provider and its own capability, the registration incarnation (an ephemeral registry identity,
  never a package or product identity), the contract registry revision, and the claim's digest with its status. A **portable lock** has none.
* `createRecipeLock(recipe, { contracts, resolutions? })` builds it from core's `resolvedDependency()` records and refuses any resolution
  that is for another canonical capability, was evaluated against another contract revision, or whose fulfillment is not `valid`.

**Validity** (`checkRecipeLock(lock, recipe, environment?)`, each finding with the action it requires):

| Finding | Action |
|---|---|
| declarations changed (`LOCK_DECLARATIONS_CHANGED`), entries missing or undeclared, recipe id differs | regenerate |
| `contractDigest` changed (`LOCK_CONTRACT_CHANGED`) | revalidate, even when the locked capability's own digest did not change: a fulfillment also depends on the contract's other capabilities (probes), as in AppPort `fulfillment-1` §5.3 |
| `capabilityDigest` changed (`LOCK_CAPABILITY_CHANGED`) | revalidate: claims pinned to the old revision are stale |
| contract unavailable | revalidate |
| provider registration or fingerprint changed, provider retired or gone (`LOCK_PROVIDER_CHANGED`, `LOCK_PROVIDER_UNAVAILABLE`) | re-resolve and re-check fulfillment; the recipe source is **not** invalidated |
| a resolution whose fulfillment is not `valid` (`LOCK_FULFILLMENT_INELIGIBLE`) | re-resolve |

A provider changes only through `substituteProvider(lock, id, resolution)`, which requires the same canonical capability at the same
contract and capability digests and a valid fulfillment. A different canonical revision is not a substitution.

**What a lock guarantees.** It makes dependency selection and contract assumptions explicit and checkable. It does **not** guarantee that
external systems behave deterministically, that two runs have the same business outcome, or that a package came from a trusted publisher. It
grants no authority: binding still requires an authorization grant for the provider's capability, exactly as without a lock.

## 6. Package (`appport.recipe-package/1`)

```json
{ "format": "appport.recipe-package/1", "kind": "source",
  "recipe": { … }, "lock": { … portable … },
  "contracts": [ { "id": "org.example.accounting", "digest": "sha256:…" } ],
  "requirements": { "roles": ["role:ap-manager"] },
  "provenance": { "tool": "…" },
  "validation": { "format": "appport.recipe-validation/1", "sourceOk": true, "warnings": [] },
  "digest": "sha256:…" }
```

* `kind` is `"source"`. A source package is **not executable**: there is no compiler. `"compiled"` is reserved for a future compiler and its
  artifact; this reader refuses it (`PACKAGE_KIND_UNSUPPORTED`) rather than mistaking it for something that can run. Compiled output will be a
  new kind or format version; nothing here claims deterministic compilation.
* `lock` is portable (`PACKAGE_LOCK_NOT_PORTABLE` otherwise). `contracts` (the contract revisions it names) and `requirements` (roles human
  tasks are assigned to) are derived and checked for consistency.
* `provenance` is descriptive content. `validation` is informational: a consumer **must** validate again.
* **Digest.** `digest` is `sha256:` of the RFC 8785 canonical JSON of every other member (`digestOf`, as everywhere in AppPort). It
  identifies one exact package content, whatever its encoding, location or registry. `createRecipePackage` is deterministic.
* **Identity.** `recipePackageIdentity` is `{ recipe: recipe.id, digest }`: the logical recipe, shared by all its releases, and the exact
  package. It contains no registry, URL or location.
* **Bytes.** `serializeRecipePackage` produces the canonical JSON, UTF-8, media type `application/vnd.appport.recipe-package+json`. The SHA-256
  of those bytes is a Distribution Protocol **artifact digest**: it identifies bytes, differs from the package digest by construction, and is
  never used in its place.
* **Compatibility.** A reader accepts exactly `appport.recipe-package/1` with a known kind and refuses undocumented members. A package's
  embedded recipe and lock carry their own format versions.

`loadRecipePackage(bytes, { binding?, digest?, recipe? })` parses the bytes, recomputes the digest from the content, compares it with the
stated digest, the signed binding value and the consumer's expectations, re-validates the source and checks the lock belongs to it. It
returns `executable: false` always.

## 7. Distribution Protocol boundary

[Distribution Protocol](https://github.com/rkendel1/distribution-protocol) (`distribution/1`, packages `@distribution-protocol/protocol`,
`registry`, `conformance`, `cli`, 1.0.0) owns distribution identity, signed immutable releases, content addressing, resolution, acquisition,
verification and receipts. AppPort owns capability identity, fulfillment, compatibility, authorization integration and invocation. The recipe
package owns process structure, dependencies and declared outcomes. The future recipe runtime owns durable execution and outcome aggregation.
None of these stands in for another. This section is the interface contract. `@appport/recipe-distribution` implements its two
AppWorks-side steps against the published 1.0.0 API (§7.5); fetching, registries, publishing and receipts are not implemented.

### 7.1 Lifecycle

1. Validate the recipe source (`validateRecipe`). 2. Resolve dependencies and check them (`discoverCanonical`, `resolvedDependency`,
`createRecipeLock`, `validateRecipe` with an environment). 3. Produce the package (`createRecipePackage`; portable lock). 4. Create the release
manifest (`distribution/1`): one artifact with `target: { "os": "any", "arch": "any" }`,
`mediaType: application/vnd.appport.recipe-package+json`, the `digest` and `size` of the serialized bytes, and
`bindings: [{ "scheme": "appport/recipe-package/1", "value": <package digest> }]`; the manifest's required `interfaces`, `permissions` and
`requirements` are chosen by the adapter (§10). 5. Sign it (`signRelease`). 6. Publish it to a
configured registry. 7. In another environment, resolve and acquire it (`resolveFromReleases`, `acquire`). 8. Verify the release signature,
the consumer's trust policy (`verifyAcquisitionTrust`), the artifact digest and size, and, when the consumer expects a package, the signed
binding against that expectation **before accepting the bytes** (`checkArtifactBinding`). 9. Load the package (`loadRecipePackage`, passing
the authenticated binding value and the expectations): the identity is recomputed from the bytes. 10. Revalidate against this environment:
`validateRecipe` with its contracts and providers, re-resolve, and create a new environment lock; the package's portable lock tells it which
contract revisions the recipe was checked against (`checkRecipeLock`). 11. Execute through the receiving environment's AppPort runtime, with
its own bindings and grants (future). 12. Verify the outcome with the declared verifications (future runtime).

The named functions are those exported by the published `@distribution-protocol/protocol` 1.0.0, which `@appport/recipe-distribution`
pins. Steps 2 and 10 need AppPort's canonical discovery and `resolvedDependency()` (merged on AppPort `main`, not yet published in
`@appport/core`); a lock reads those records structurally and is tested against their documented shape.

### 7.2 Identities

| Concept | Where | Form |
|---|---|---|
| Canonical capability major version | canonical contract | integer (`invoice.submit@1`); never SemVer |
| Exact canonical contract revision | lock, package `contracts` | `contractDigest`, `capabilityDigest` |
| Recipe source format version | recipe `format` | `appport.recipe/1` |
| Logical recipe identity | recipe `id` | reverse-domain identifier |
| Distribution product and release lineage | Distribution Protocol | `product://ns/slug`, `product://ns/slug@1.2.0` (SemVer, publisher-signed) |
| Exact package content | package `digest` | `sha256:` of canonical content |
| Distributed bytes | Distribution Protocol artifact `digest` | `sha256:` of bytes |
| Publisher and signature | Distribution Protocol release | `publisher://ns`, Ed25519 over canonical manifest bytes |

A package mints no release identity: the stable release lineage is the Distribution Protocol product, and a release version is SemVer
there only. Which product publishes which recipe is the publisher's choice; a consumer pins the pair it expects (product release, and recipe
id with package digest). SemVer is not adopted for canonical contracts.

### 7.3 The `appport/recipe-package/1` binding

Distribution Protocol carries signed identity bindings `{ scheme, value }` for identities owned by other systems, and carries a scheme it
does not know opaquely. AppPort defines `appport/recipe-package/1`; its `value` is the package digest (`sha256:<64 hex>`).

* The signature authenticates the **publisher's claim** that the artifact is that package. It does not prove the bytes contain it. The
  consuming loader recomputes the package digest from the acquired bytes (`loadRecipePackage`) and refuses a mismatch
  (`PACKAGE_BINDING_MISMATCH`).
* The binding value is not the artifact digest, is not derived from it, and never replaces it: Distribution Protocol still verifies the
  artifact digest and size first.
* A binding is read only from a release whose signature verified. A consumer that requires a package refuses a release with no binding in this
  scheme or a different one before accepting bytes.

### 7.4 Trust, installation and execution are separate decisions

A valid signature, a trusted publisher, a matching digest and a verified binding establish only that these bytes are the package a trusted
publisher released. They do **not** grant authorization, bypass fulfillment or dependency validation, bypass the consumer's trust policy or
recipe validation, or establish that any business outcome occurred. Installing a package and authorizing its execution are separate
decisions, made by the receiving environment under its own authority.

### 7.5 What `@appport/recipe-distribution` implements

* `recipeReleaseManifest(pkg, { product, publisher, interfaces, … })`: step 4. Builds the manifest and the artifact bytes and has
  Distribution Protocol's own `validateManifest` accept it. `interfaces` is required: no interface kind is chosen on the caller's behalf.
* `acceptAcquiredRecipePackage({ release, artifactId, bytes, expect, trust? })`: steps 8–9 on bytes the caller acquired, in order —
  `verifyRelease`; `verifyAcquisitionTrust` when a trust policy is given; `checkArtifactBinding` against the consumer's expected package
  digest; `verifyArtifactBytes` and size; `loadRecipePackage` with the signed binding value. The result is `installable` only when publisher
  trust was evaluated and accepted, and is never `executable`.

**Observed in the published 1.0.0 API.** `validateManifest` does not enforce the interface `type` enum that Distribution Protocol's own
`manifest.schema.json` declares (it accepts `"type": "recipe"`). The adapter does not compensate; the discrepancy belongs to the
Distribution Protocol repository.

## 8. Evolution

| Axis | Rule |
|---|---|
| Recipe source format | `appport.recipe/1` readers refuse other versions. A new version is a new format string. |
| Canonical contract | A revision is visible as a changed `contractDigest`/`capabilityDigest` in the lock and requires revalidation; it never rewrites recipe source. |
| Implementation change | A provider re-registration requires re-resolution, never a source change. |
| Lock validity | §5. Locks are regenerated, not edited; substitution is explicit. |
| Recipe release | A new Distribution Protocol release; published releases are immutable. A new release never alters an existing installation or an execution already started. No automatic upgrade exists. |
| Package content | Any change gives a new package digest. |
| Distribution Protocol | The adapter pins the protocol version it supports (`distribution/1`). AppPort formats do not depend on it. |

## 9. Security considerations

* A recipe, lock or package is untrusted input until validated in the receiving environment. Validation is bounded (expression depth, no
  cycles) and executes nothing.
* No construct embeds code. Expressions and rules are data with a closed vocabulary.
* A lock and a package grant nothing. Authorization is the existing grant-and-binding system, keyed by the provider's capability.
* A package's `validation` summary and `provenance` are claims of the packager and are never relied on.

## 10. Open decisions before a compiler

* **Executable representation.** What the compiler emits, how it is identified (a new kind and its own digest), and what "deterministic
  compilation" will be required to mean.
* **Runtime semantics of outcomes.** Exactly which invocation results and verification outcomes map to `success` / `failure` / `uncertain`
  (§3.5), and how reconciliation of `uncertain` ends is represented.
* **Task persistence and approval evidence.** How a runtime records who answered a task, under which authority, and how that is shown to a
  capability whose contract requires approval, without AppPort core recording approvals.
* **Loops and repetition.** Recipe/1 has none. Batch or per-item processing needs a bounded construct with explicit idempotency rules.
* **Provider selection policy.** Ambiguity is reported; how a deployment records its explicit choice (beyond `substituteProvider`) is open.
* **Concept changes in transforms.** Recipes cannot declare a loss of meaning; whether they should, as mapping artifacts do, is open.
* **Distribution manifest mapping.** `distribution/1` requires `interfaces` (kinds `api`, `cli`, `desktop`, `library`, `mobile`, `service`,
  `stream`, `web`), `permissions` and `requirements`; none of the interface kinds names a recipe, and Distribution Protocol requirement
  tokens are not AppPort canonical dependencies. Which kind to declare, and whether to mirror anything into `requirements`, is open; AppPort
  dependencies stay in the package and are checked by AppPort, never by distribution resolution.
* **Distribution adapter.** Which Distribution Protocol version it pins, how product identity is chosen for a recipe, and how a consumer
  states its expectation (recipe id and package digest) in its install request.
