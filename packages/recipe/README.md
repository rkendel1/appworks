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

Depends only on published `@appport/protocol`, `@appport/schema` and `@appport/integration`. It executes nothing, selects no provider,
grants no authority, and does not depend on Distribution Protocol or any registry. A source package is never executable. Part of the
AppPort ecosystem, not of the AppPort protocol.
