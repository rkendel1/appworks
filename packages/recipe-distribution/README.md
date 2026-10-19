# @appport/recipe-distribution

The boundary between AppWorks recipe packages and [Distribution Protocol](https://github.com/rkendel1/distribution-protocol) releases
(`distribution/1`, `@distribution-protocol/protocol` 1.0.0). The only AppWorks package that depends on Distribution Protocol.

- `recipeReleaseManifest(pkg, options)`: the release manifest for a recipe package, validated by Distribution Protocol. Sign and publish it
  with Distribution Protocol's own tools.
- `acceptAcquiredRecipePackage({ release, artifactId, bytes, expect, trust? })`: release signature, publisher trust (with a policy), the
  signed `appport/recipe-package/1` binding against the expected package digest, artifact digest and size, then the package itself with its
  identity recomputed from the bytes.

Not implemented: fetching, registries, publishing, receipts. Acceptance grants no authorization, proves no fulfillment and establishes no
business outcome; the result is never `executable`, and is `installable` only when publisher trust was evaluated and accepted.
