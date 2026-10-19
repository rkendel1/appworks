# @appport/recipe

AppWorks business recipes: the `appport.recipe/1` source model, a closed typed expression form, validation with structured findings,
dependency locks (`appport.recipe-lock/1`) and source packages (`appport.recipe-package/1`). Specification: `spec/recipe-1.md` in
[rkendel1/appworks](https://github.com/rkendel1/appworks). JSON Schemas ship in `schemas/`.

| Area | Exports |
|---|---|
| Source | types, `validateRecipe` (`source` vs `environment` findings), `validateRecipeInput`, `recipeDependencies` |
| Expressions | `checkExpression`, `evaluateExpression` |
| Lock | `createRecipeLock`, `checkRecipeLock`, `portableLock`, `substituteProvider` |
| Package | `createRecipePackage`, `recipePackageDigest`, `serializeRecipePackage`, `loadRecipePackage`, `recipePackageIdentity`, `recipePackageBinding` |

Depends only on the published `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1 and `@appport/integration` 1.2.0, and uses their
checks directly: `lintIntegration` for dependencies (canonical targets included), `lintRule` for rules, `compareSchemas` for interfaces.
Canonical discovery, fulfillment evaluation, resolution and binding are AppPort's (`@appport/core` 1.3.0): resolve with it, then pass the
`resolvedDependency()` records to `createRecipeLock`.

```ts
import { resolvedDependency } from "@appport/core";
import { createRecipeLock, checkRecipeLock, portableLock } from "@appport/recipe";

const lock = createRecipeLock(recipe, { contracts, resolutions: { "submit-invoice": resolvedDependency(result) } });
checkRecipeLock(lock, recipe, { contracts, providers });   // findings say: regenerate, revalidate or re-resolve
portableLock(lock);                                         // canonical identity only: what a package carries
```

A lock's `canonical` part (contract and capability digests) is portable; its `resolution` part (provider, registration, claim) belongs to
one environment. A contract change requires revalidation; a provider change requires re-resolution; neither invalidates the recipe
source. A lock grants no authority: binding still requires a grant for the provider's capability.

It executes nothing, selects no provider, grants no authority, and does not depend on Distribution Protocol or any registry. A source
package is never executable. Not implemented: a compiler, a runtime, repository assessment, extraction and migration. Part of the AppPort
ecosystem, not of the AppPort protocol.
