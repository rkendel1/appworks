# Changelog: @appport/assessment

## 0.1.0

First release. Static assessment of an existing repository: evidence-backed capability candidates, readiness and a recommended exposure candidate. It reads; it executes, builds and writes nothing in the target.

- Scanner 1 (the default): Go and Protocol Buffers; writes `appport.application-assessment/1`.
- Scanner 2 (`assessRepository(path, { scanner: 2 })`, `appworks assess --scanner 2`): also reads HTTP routes registered in JavaScript and TypeScript (Express, Fastify, Koa router, Hono, NestJS) and writes `appport.application-assessment/2`. A route is evidence that an entry point exists and nothing more: it is never recommended and is not yet extractable (`spec/assessment-1.md` §11).
- Scanner 1's output does not depend on scanner 2: assessments made with it reproduce.
- Depends only on `@appport/protocol` 1.3.0.
