# Changelog: @appport/recipe-distribution

## 0.2.0

The whole lifecycle over a file channel (`spec/distribution-1.md`), on top of the 0.1.0 boundary.

- Publish (`publishRecipePackage`, `packageForPublish`), acquire with a validated Distribution Protocol receipt (`acquireRecipePackage`), and install into an environment (`installRecipePackage`, `InstallStore`, `readInstalledPackage`): signature verified before a release is read, the consumer's anchored trust policy, the signed digest before any bytes are returned, installation written whole or not at all, and **installation authorizes nothing**.
- `appworks package keygen | trust | publish | verify | install | list | show` (`appworks-package` binary, `./cli` export).
- A published version never changes: a different package under a published version is refused.
- Depends on `@appport/recipe` 0.1.1 (was 0.1.0) and `@distribution-protocol/protocol` 1.0.0.

Not included: an HTTPS registry, mirrors, upgrade or uninstall, key rotation tooling.

## 0.1.0

First release: the boundary between recipe packages and Distribution Protocol releases (`recipeReleaseManifest`, `acceptAcquiredRecipePackage`).
