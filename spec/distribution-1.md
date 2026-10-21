# AppWorks recipe distribution, version 1 (draft)

A recipe is useful beyond the machine it was written on only if another environment can get *exactly* that recipe, prove who released
it, check that it can run there, and run it. This document specifies the lifecycle that does that: **publish, acquire, install,
run**. Distribution Protocol (`distribution/1`, `@distribution-protocol/protocol` 1.0.0) owns signed releases, publisher identity and
trust, digests, acquisition and receipts. AppWorks owns what is inside the artifact and what installing it means. The code is
`packages/recipe-distribution` (`@appport/recipe-distribution`, the only AppWorks package that depends on Distribution Protocol) and
`packages/recipe-runtime` (`loadInstalledRecipe`). No dependency was added: everything below uses what 1.0.0 already provides.

## 1. Four identities, never one another

| Identity | Names | Computed from | Owned by |
|---|---|---|---|
| recipe `id` | the business process (`org.example.recipes.supplier-invoice`) | chosen | AppWorks (`spec/recipe-1.md`) |
| package `digest` | one exact package: recipe, portable lock, contracts, roles, provenance | the package's content | AppWorks |
| artifact `digest` | the package's canonical bytes | the bytes | Distribution Protocol |
| release `product@version` | a publisher's signed statement that these bytes are this version | the signed manifest | Distribution Protocol |

The consumer states what it expects (the **package digest**, from its own pin or an out-of-band announcement). A release never states that
for it: a release that vouches for itself proves nothing.

## 2. Authority and what none of this grants

* Acquiring a package, installing it, or locking it grants **nothing**. The install record says `authorizes: "nothing"`. Invocation
  authority is the environment's durable grants, per consumer, per provider capability, checked at every invocation (`spec/runtime-1.md` §7).
* Trust is the consumer's policy, never the release's: a publisher is trusted by name **and anchored** (a document the consumer chose, or a
  pinned key). Trust by name alone is refused (`UNANCHORED_PUBLISHER`).
* A signature proves who released these bytes. It does not prove the recipe works, or that any capability behind it behaves.

## 3. Publishing

`publishRecipePackage` (CLI `package publish`):

1. The package is built from the recipe and a **portable lock** (canonical contract digests; no provider, no environment) against the
   publisher's own contract registry, with provenance (tool, source path, revision).
2. `recipeReleaseManifest` makes a `distribution/1` manifest: one artifact (`recipe-package`, media type `application/vnd.appport.recipe-package+json`,
   the bytes' digest and size) and one signed binding `appport/recipe-package/1` → the package digest.
3. The release is signed with the publisher's Ed25519 key **and bound to the publisher's document**: signing is refused unless the key is
   declared there, so a release cannot be made under an identity whose keys are not the signer's.
4. Written to the channel in this order: artifact bytes, the publisher's document lineage, **then the release**, so a release never names
   bytes that are not there.
5. **A published version is immutable.** The same package again is a no-op (`unchanged`); different content (including different
   provenance, which is part of the package digest) under the same `product@version` is `RELEASE_CONFLICT` and writes nothing.

## 4. The channel, and acquisition

A channel is a directory (`FileChannel`): `releases/<ns>/<slug>/<version>.json`, `artifacts/sha256-<hex>.json`, `publishers/<ns>.json`. It is
storage and decides nothing; whatever it holds is untrusted until acquisition has verified it. (An HTTPS registry is the same data behind
another transport and is not implemented.) **Where the bytes live is not signed**: the 1.0.0 manifest has no `sources` member (its
validator rejects one), so the channel derives the location from the signed digest, and a mirror may serve the same bytes without being able to change what they are.

`acquireRecipePackage` (CLI `package verify` / `install`), in order, stopping at the first failure and naming it:

| Stage | Check | Refuses |
|---|---|---|
| `resolve` | the release exists in the channel | an unknown version |
| `release` | the release signature verifies, **before anything in it is read** (including where its bytes are) | altered signature, altered signed binding, redirected artifact digest |
| `trust` | the publisher is in the consumer's policy **and anchored**, and the key is current (`verifyAcquisitionTrust`) | an untrusted publisher, trust by name only, an attacker's own document for the same publisher id |
| `binding` | the signed `appport/recipe-package/1` binding equals the package digest the consumer expects | a genuine release of a different package |
| `artifact` | the bytes are fetched and hashed **against the signed digest**; none are returned until they match; the size matches | a flipped byte, a missing artifact |
| `package` | the bytes load as that package: format, recomputed digest, embedded recipe and lock | a self-inconsistent package |
| `accepted` | a Distribution Protocol receipt is made and validated against the release | |

The receipt (`distribution/receipt`) records what was verified (`digest`, `signature`, `publisherTrust`, `revocation`, the trust anchor and
the publisher document). Distribution Protocol's validator rejects a receipt that over-claims (trust without a revocation check or an
anchor). Without a policy a package can be **inspected** (`installable: false`) but never installed. `executable` is always false.

## 5. Installing

`installRecipePackage` (CLI `package install`) puts an acquired, trusted package into an `InstallStore`
(`<store>/<ns>/<slug>/<version>/`). Stages:

| Stage | Meaning |
|---|---|
| `trust` | refused: nothing accepted, or its trust was not evaluated |
| `environment` | refused: the recipe does not validate against this environment (`ENV_*` findings: contract missing or incompatible, no eligible provider, approval or verification weakened), or its dependencies do not resolve to exactly one provider each |
| `conflict` | refused: this `product@version` is installed with a different package. An installed version never changes |
| `installed` / `already-installed` | done (the same package again is a no-op; a concurrent install of the same package is too) |

The receiving environment decides compatibility, with its own contracts and providers, validated afresh (the package's own validation is
informational). It builds **its own lock** with `createRecipeLock` from AppPort's `resolvedDependency()` records: the providers *this*
environment resolves, not the publisher's. Where a contract's revision here differs from the one the publisher locked, the install record lists
the drift; compatibility is decided by validation, not by equality.

The directory is written whole and moved into place, so an install is all there or not there:

| File | Content |
|---|---|
| `package.bin` | the accepted package, exactly the bytes that were verified |
| `lock.json` | this environment's lock |
| `release.json`, `receipt.json` | the signed release and the acquisition receipt |
| `install.json` | `appworks.recipe-install/1`: product, release (publisher, key), package digest and recipe id, artifact digest, **lock digest**, required roles, the trust that was verified, contract drift, time, `authorizes: "nothing"` |

The roles that human tasks are assigned to (`requirements.roles`) are recorded but cannot be checked here: they are the environment's authority to honour.

## 6. Running from an installed package

`appworks recipe run --package <installed-dir> --input … --environment …` (`loadInstalledRecipe`). The runtime reads `install.json`
but does not import the distribution package: the record's format is the contract. Every time a run starts it:

1. re-loads `package.bin` against the package digest and recipe id **recorded at install** (so a package that was edited, or replaced by a
   different but self-consistent one, is refused with `RECIPE_INVALID`);
2. re-checks that `lock.json` is the lock the record names and still matches the recipe's declared dependencies;
3. then validates the recipe against the *current* environment and runs, as for any recipe (`spec/runtime-1.md` §4).

The run records its **origin** (`kind: installed-package`, package digest, recipe id, release id, publisher, lock digest) in its
`RecipeRun` record, so every run can be traced to the exact release it executed. A source checkout is never read: the tests delete the channel
and the publisher's environment before the run.

## 7. CLI

`appworks package keygen | trust | publish | verify | install | list | show` (`--json` for machine output). Exit `0` done, `1` refused (the stage
is printed), `2` usage. `keygen` writes a private key (mode 0600) and a self-signed publisher document and prints the **document id**, which
consumers anchor trust on (`package trust`). `publish` takes `--environment`, the same operator module as `recipe run`, for the contracts the
portable lock pins. `verify` acquires and checks without writing state. The command is delegated lazily by the workspace CLI; the workspace takes no hard dependency.

## 8. Findings about Distribution Protocol 1.0.0

Observed while integrating; none needed an upstream change.

* A manifest's artifacts may not carry `sources` (the validator rejects it): locations are outside the signed release by design.
* The `file` transport accepts only `file://` URIs or absolute paths, never a relative path, and never infers a base directory.
* A receipt must record `digest: verified` and `signature: verified`; it may not claim publisher trust without a revocation check and an anchor.
* The last base64url character of a 64-byte signature has spare bits: changing it can leave the signature unchanged. Tamper tests must change a
  character elsewhere (an early version of this suite did not, and was flaky).
* `verifyAcquisitionTrust` refuses trust by name alone; an attacker's self-consistent document for the same publisher id is refused because the consumer anchored the real one.

## 9. Attack matrix (`packages/recipe-distribution/test/lifecycle.test.ts`, `e2e.test.ts`)

| Attack | Refused at |
|---|---|
| unknown version | `resolve` |
| signature altered; signed binding altered; artifact digest redirected | `release` |
| publisher not in policy; trusted by name only; forged document for the publisher's id | `trust` |
| a genuine release of another package than the one expected | `binding` |
| artifact byte flipped; artifact missing | `artifact` |
| installed `package.bin` edited after install; replaced by a different self-consistent package; installed lock edited | run start (`RECIPE_INVALID`), with nothing written and nothing invoked |
| a different package under an installed version; different content under a published version | `conflict` / `RELEASE_CONFLICT` |
| an environment with no provider of the contract | `environment` |
| a package acquired without trust evaluation | `trust` (install) |

## 10. Not implemented (stated, not implied)

* An HTTPS or other registry transport, mirrors, a discovery service, and an artifact cache (Distribution Protocol provides them; they are not wired).
* Upgrading or uninstalling an installed version, and resolving versions or ranges: a version is named explicitly, and the consumer's pin is the digest.
* Key rotation and revocation tooling (the trust check honours a revoked key in a presented lineage; AppWorks does not produce one), publisher-side receipts, and signed install records.
* A package depending on other packages, and recipes compiled to anything other than source (`compiled` is refused).
* Checking the lock against the live registry at run start (`checkRecipeLock` with an environment): a run validates the recipe against the current environment, which is the compatibility gate, but does not refuse a drifted lock.
* Checking that the roles human tasks need exist in the environment's authority.
* Publishing the illustrative `org.example.accounting` contract: the package pins its digest, and the test registry is where it exists.
