# AppWorks

AppWorks is the product for **discovering, packaging, composing and incrementally replacing business functionality**, in new applications and
in applications that already exist. It is built on [AppPort](https://github.com/rkendel1/appport), which makes business functions
discoverable and invocable through canonical capability contracts, and uses
[Distribution Protocol](https://github.com/rkendel1/distribution-protocol) to publish and acquire packages.

- [Product charter](docs/charter.md): mission, the three concepts (capability, package, recipe), the two entry points, and what exists today.
- [Architecture](docs/architecture.md): layers, repositories versus package names, dependency rules.
- [Compatibility and evolution](docs/compatibility.md): versioning, the AppPort APIs used before they are published, provenance.
- [Recipe specification](spec/recipe-1.md): `appport.recipe/1`, `appport.recipe-lock/1`, `appport.recipe-package/1`, and the Distribution
  Protocol boundary.

## Status

**Draft.** This repository contains the recipe source model, its validation, dependency locks, source packages, and the boundary with
Distribution Protocol. There is **no compiler, no runtime, no publishing or acquisition, no repository assessment, no extraction and no
migration** yet: nothing here executes a recipe or establishes a business outcome. See the charter's status table.

## Packages

Published under the `@appport/*` ecosystem scope; owned, versioned and released by this repository.

| Package | Contents | Depends on |
|---|---|---|
| [`@appport/recipe`](packages/recipe) | recipe source model, expressions, validation, locks, packages, JSON Schemas | `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1, `@appport/integration` 1.2.0 (published); tested against `@appport/core` 1.3.0 |
| [`@appport/recipe-distribution`](packages/recipe-distribution) | recipe package ↔ `distribution/1` release manifest; acceptance of acquired bytes | `@appport/recipe`, `@distribution-protocol/protocol` 1.0.0 |

```ts
import { validateRecipe, createRecipeLock, createRecipePackage, loadRecipePackage } from "@appport/recipe";

const { ok, sourceOk, findings } = validateRecipe(recipe);                       // source only
validateRecipe(recipe, { contracts, providers });                                // and against an environment
```

## Example

[`examples/supplier-invoice`](examples/supplier-invoice): intake and validation, duplicate detection, a conditional human approval,
submission through a canonical accounting capability, independent verification, and explicit rejection, failure and uncertain outcomes. Its
accounting contract is illustrative and **unresolved**.

## Development

Requires Node 20+ and pnpm 10.

```sh
pnpm install
pnpm build            # tsc project references
pnpm typecheck        # sources and tests
pnpm test             # vitest
pnpm boundary:check   # dependency rules (docs/architecture.md §3)
pnpm release:check    # pack, install outside the repository from the registry, run a consumer
```

No AppPort checkout is needed: AppPort and Distribution Protocol come from the npm registry at the versions the package manifests pin.

## License

Not yet chosen: the packages are marked `UNLICENSED` until the owner decides.
