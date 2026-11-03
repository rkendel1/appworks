# Changelog: @appport/recipe

## 0.1.1

Dependency refresh. No change to the API or to behavior.

- `@appport/protocol` 1.2.0 → 1.3.0, `@appport/schema` 1.1.1 → 1.1.3, `@appport/integration` 1.2.0 → 1.2.2; development dependency `@appport/core` 1.3.0 → 1.4.0 (the version this package is tested against).
- Checked against the published 0.1.0: every compiled module except `index.js` is byte-for-byte identical, and `index.js` differs only in a comment naming the dependency versions. Recipe, lock and package digests are unchanged.

## 0.1.0

First release: the `appport.recipe/1` source model, expressions, validation, dependency locks and source packages.
