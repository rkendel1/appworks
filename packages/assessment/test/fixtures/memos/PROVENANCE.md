# Provenance

A verbatim subset of [Memos](https://github.com/usememos/memos) (MIT License, `LICENSE`), as integrated in the AppPort
work, taken from `https://github.com/rkendel1/memos` at commit `c0eeec7a260ee58e2ed1514a61bfff1fa013f42e`. No file was
edited; files outside the subset were left out, so calls into them are unresolved here by design.

The subset is the user-service slice: `proto/api/user_service.proto` and `common.proto`, one generated file
(`proto/gen/api/common.pb.go`, to exercise generated-code skipping), the `server/api` handlers, converters, access
configuration and one test file, the `store` facade and driver interface, the SQLite user driver, `go.mod`, the root
`.gitignore` and one TypeScript file (`web/…`, to exercise unsupported-language reporting).

It is test data. Nothing in it is built, imported or executed; `packages/assessment/test/memos.test.ts` reads it with
the assessment and hashes it before and after. The full-repository test (`memos-full.test.ts`) runs against a checkout
of that commit when `APPWORKS_MEMOS_REPO` names one.
