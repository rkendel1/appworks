# @appport/recipe-distribution

The boundary between AppWorks recipe packages and [Distribution Protocol](https://github.com/rkendel1/distribution-protocol) releases
(`distribution/1`, `@distribution-protocol/protocol` 1.0.0). The only AppWorks package that depends on Distribution Protocol.

- `recipeReleaseManifest(pkg, options)`: the release manifest for a recipe package, validated by Distribution Protocol. Sign and publish it
  with Distribution Protocol's own tools.
- `acceptAcquiredRecipePackage({ release, artifactId, bytes, expect, trust? })`: release signature, publisher trust (with a policy), the
  signed `appport/recipe-package/1` binding against the expected package digest, artifact digest and size, then the package itself with its
  identity recomputed from the bytes.

Since 0.2.0, the whole lifecycle over a file channel (`spec/distribution-1.md`):

- `FileChannel`, `publishRecipePackage`: a signed release bound to the publisher's document, written so a release never names missing
  bytes; a published version never changes.
- `acquireRecipePackage`: release signature first, then the consumer's *anchored* trust policy, then bytes fetched against the signed digest
  (none returned unless they match), then the package against the digest the consumer expects; a validated Distribution Protocol receipt.
- `InstallStore`, `installRecipePackage`, `readInstalledPackage`: checks the recipe against the receiving environment, builds that
  environment's own lock, refuses without verified trust, writes the install whole or not at all, and **authorizes nothing**.
- `appworks package keygen | trust | publish | verify | install | list | show`.

Not implemented: an HTTPS registry, mirrors, upgrade or uninstall, key rotation tooling. Acceptance grants no authorization, proves no fulfillment and establishes no
business outcome; the result is never `executable`, and is `installable` only when publisher trust was evaluated and accepted.
