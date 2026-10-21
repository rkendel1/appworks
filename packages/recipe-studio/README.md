# @appport/recipe-studio

Author a business recipe, check it against a real environment, preview it, and package it. Private; not published.

The Studio edits the canonical `appport.recipe/1` document and calls the same validation, lock and package code as the CLI. It has no
recipe format, package format, authority, signing key or execution of its own. **Publishing, trust, installation and running are the existing
commands**: `appworks package publish | verify | install` and `appworks recipe run --package`, each of which checks everything again.

```
appworks studio serve --dir ./recipes --environment dev=./environments/dev.mjs
```

serves the page on `127.0.0.1` (loopback only; it acts as you and has no authentication, like the workspace). `--environment` takes one or
more `[name=]module` entries, the same module the CLI's `--environment` takes: it default-exports `({ home }) => ({ gateway, authority? })`.
The environment is the operator's: where providers are, which grants exist, who may start a recipe. The Studio reads it and never writes to it.

## The recipe card

A recipe is shown in the visual format of a printed recipe:

| | |
|---|---|
| title and purpose | the recipe's name, and its objective in parentheses |
| full-width rows above the grid | what the environment must provide, like "preheat the oven": each capability needed (from which contract, whether it only reads), and the roles asked to answer |
| the left columns | the ingredients: each input, its type, and how it is prepared (its declared constraints) |
| the step columns | the steps in the order they happen; each **spans exactly the inputs it reads**, and a step that reads only earlier results spans every row, like a final "fold" |
| below | what a completed run produces, how the outcome is verified, and each way a run can end |

Branches do not fit a straight grid, so each step cell lists where it can go next. The card is computed from the recipe alone: it names no
provider and is identical in every environment.

## What you can do

- **Define**: name, identity, purpose and description; inputs and outputs (the recipe's contract, as JSON Schema with AppPort's semantic
  annotations); the release you intend (a distribution product and a version: a recipe has no version, a release does).
- **Steps**: add a step from a capability in the environment's catalog. The dependency, the shapes the step expects, its effect and the
  verification methods the contract declares are *derived from the contract*; same-named inputs of the same type and concept are wired for
  you, and nothing is guessed beyond that. Routes, other mappings, decisions, tasks and ends are yours (a step is edited as its canonical
  JSON). Inspecting a step shows what it needs and which of that is mapped, what it produces, its routes, and the authority its contract
  declares.
- **Readiness**: the recipe checked against the chosen environment (below).
- **Package**: the canonical package, and the exact existing commands that carry it on.
- **Source**: the canonical `recipe.json`, exactly. Hand edits, imports and saves go through the same path.

## What is saved, and what is not

A project is a directory under `--dir`:

| file | holds |
|---|---|
| `recipe.json` | the canonical recipe and nothing else: the exact file `appworks package publish` reads. A draft may be invalid; it is saved as it is |
| `studio.json` | a revision counter (a save over a newer revision is refused, never merged), the intended release, and the last package's *portable* lock, to notice a later contract change |
| `recipe.package.json` | the package last made |

**Provider bindings, grants, keys and trust are never saved here**, because they are not the recipe's. They are read from the environment each
time, so the same project opened against another environment shows that environment's providers, and the recipe, the card and the package
digest do not change. A test writes a project, looks at it from two environments with different providers, and checks that no file in it
names either.

A recipe cannot acquire authority by being created, edited, imported or installed: the format has no member that holds any, and an unknown
member is a source error. Authority is a durable grant in the environment's AppPort, made by the environment's owner.

## Readiness

`validateRecipe` (with the environment's contracts), the environment's resolution, AppPort's own binder (asked through the gateway's
read-only `access`, which invokes and grants nothing), `checkRecipeLock` against the last package, and the environment's runtime authority.

| verdict | meaning |
|---|---|
| `invalid` | the recipe has source errors; nothing about any environment is claimed |
| `unassessed` | sound; no environment was supplied |
| `blocked` | sound, but this environment cannot run it as things stand (each finding names the step or dependency and what to do) |
| `ready-with-unresolved` | every fact the environment could report holds; the facts it could not are listed |
| `ready` | every checkable fact holds |

Findings include: a capability or contract the environment lacks; a step that expects what the contract does not give; no provider, or more than
one (the Studio does not choose; that is the environment's); authority not delegated (the Studio cannot grant it, and says who can); a
contract that changed since the recipe was last packaged; a principal who may not start it. **A recipe that asks a human role is at best
`ready-with-unresolved`**: whether the environment's authority defines that role is not checkable until a task exists (install records it as a
requirement). `executable` is always `false`: a verdict is not an execution, and a run is the runtime's decision, at start, from the installed package.

## Packaging and what happens next

"Make package" builds the package with `packageForPublish`, the function `appworks package publish` uses, so the digest shown is the
digest that command publishes. A test publishes the Studio's file *and* the checked-in example with the CLI and gets the Studio's digest both
times. The package is loaded back as a consumer loads it before it is reported. Then the Studio stops, and prints the commands:

```
appworks package publish <project>/recipe.json --channel <dir> --product <product> --version <semver> --key <dir> --environment <module>
appworks package verify  --channel <dir> --product <product> --version <semver> --digest <digest> --policy <file> --recipe <id>
appworks package install --channel <dir> --product <product> --version <semver> --digest <digest> --policy <file> --store <dir> --environment <module>
appworks recipe run --package <installed-dir> --input <json|@file> --environment <module>
```

The Studio holds no key and no trust policy, so it cannot sign, trust or install; a published version is immutable (Distribution Protocol's
channel refuses a different package under a published version, and a test shows the Studio cannot get around that).

## CLI

`appworks studio serve | new | import | validate | card | package` (see `--help` output of `appworks studio`). `validate` exits 0 for `ready` and
`ready-with-unresolved`, 1 otherwise.

## Status

Implemented and tested (`packages/recipe-studio/test`, run by `pnpm test`; the exit test is `lifecycle.test.ts`):

- authoring, save and reopen without loss (an invalid draft survives; the recipe file is byte-stable; a lost update is refused);
- the supplier-invoice recipe built from an empty one through the Studio's edits, equal member for member to `examples/supplier-invoice/recipe.json`;
- readiness against real AppPort environments for each case above, including grants asked of AppPort's binder with the Studio changing none;
- the Studio's package published by the existing CLI at the same digest, verified, installed into a second environment with a different provider
  (and a third), executed by the runtime, with the run's origin naming the package; the portable definition unchanged throughout;
- negatives: tampering with the Studio's package file, the published artifact, and the installed package (including a self-consistent
  substitute); an untrusting consumer; a wrong expected digest; republishing a version; no provider, two providers, no grant; invalid and
  malformed drafts; a server with no route that grants, signs, publishes, installs or runs;
- the page's own script run against the real server (a small DOM, not a browser).

Of the supplier-invoice scenario's 15 steps (`docs/roadmap.md` §4) the Studio test exercises 4-9 (define, validate, package, acquire and verify in
another environment, resolve at install, execute durably), 11 (independent verification), 14 (a different provider) and the automatic path of
10. Steps 12 and 13 are covered by the runtime's own tests, not through a Studio-made package; 1-3 and 15 are not done.

Not implemented: a graph view, mapping and condition editors (expressions are edited as JSON), a run view (use `appworks recipe run | status`),
a way to pin or choose among several eligible providers (the environment's operator leaves exactly one), checking human roles, an
authentication boundary for anything but loopback, and any test in a real browser. The page's layout and styling have not been looked at in one.
