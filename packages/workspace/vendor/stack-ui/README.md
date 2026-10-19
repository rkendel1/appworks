# Vendored @stack-ui static build

The shared Stack design system ([rkendel1/stack-ui](https://github.com/rkendel1/stack-ui)), vendored the same way AppPort Services
and AppBoundry vendor it: the workspace pages are server-delivered HTML with no client build step, and stack-ui is not on npm.

- Every file except this README comes unmodified from `release/stack-ui-static-0.5.0/` of `rkendel1/stack-ui` at
  `0af953e4349c3dfcfa02f46c1603d5962e67b070` (`pnpm install --frozen-lockfile && pnpm build && node scripts/package-static.mjs`).
- `src/ui.ts` inlines `tokens.css`, `core.css` and `stack-ui-core-stateless.js` into every workspace page, followed by
  `ui/workspace.css` and `ui/workspace.js`. No other asset routes are served.
- The stateless build keeps nothing in browser storage; the pages follow the operating system's colour scheme.
  `stack-ui-core.js` (the full build) is kept only so this directory stays identical to the release.
- stack-ui owns presentation and interaction behaviour only. Project state, authorization and execution stay in the workspace
  domain (`src/`) and FeltDB.
- `test/ui.test.ts` checks every file against `SHA256SUMS` and that the pages load nothing else.

To upgrade: copy the new release directory over this one (keep this README), update the commit above and run the tests.
