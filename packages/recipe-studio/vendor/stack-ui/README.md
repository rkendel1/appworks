# Vendored: design foundation tokens (stack-ui static release)

`tokens.css` comes unmodified from `release/stack-ui-static-<VERSION>/` of `rkendel1/stack-ui`
(`node scripts/package-static.mjs`); `SHA256SUMS` is the release's line for it. The Studio serves it at
`/ui/vendor/tokens.css` before `studio.css`, whose colours resolve from it, so light and dark follow the
shared theme (System by default; the header's theme control applies a choice to the open page and stores
nothing). `test/ui.test.ts` checks the checksum. To upgrade: copy the new release's `tokens.css`,
`VERSION` and its `SHA256SUMS` line.
