# @appport/assessment

AppWorks existing-application assessment. It reads a repository statically and writes an `appport.application-assessment/1` artifact.
The artifact is an evidence-backed inventory of the business capabilities the application exposes, how they are implemented, what they
read, write and call, how they are authorized, validated and tested, and which one is the most reasonable first candidate for AppPort
exposure. Specification: `spec/assessment-1.md` in [rkendel1/appworks](https://github.com/rkendel1/appworks). JSON Schema ships in `schemas/`.

The `appworks` command comes with `@appport/extraction`. This package alone installs `appworks-assess`, which takes the same `assess`
and `verify` commands.

```sh
appworks assess ./memos --output memos-assessment.json     # exit 0 (complete or partial), 1 fatal, 2 usage, 3 --strict and partial
appworks verify memos-assessment.json --repo ./memos       # integrity, honesty, and every observed location against the files
```

```ts
import { assessRepository, verifyAssessment } from "@appport/assessment";

const assessment = assessRepository("./memos");
assessment.recommendation;            // { candidate, reasons, ranking, beforeExposure } or null
verifyAssessment(assessment, { repository: "./memos" });
```

| Export | Purpose |
|---|---|
| `assessRepository` | the assessment; options for limits, thresholds and (for tests) volatile metadata |
| `verifyAssessment` | structure, evidence classes and references, verified/authority claims, digest; locations with `repository` |
| `assessmentDigest`, `evidenceId` | the content rules (`digestOf` of `@appport/protocol`) |
| `proposeCapabilityName`, `messageSchema` | the AppPort proposal rules |
| types and constants | `ApplicationAssessment`, `Evidence`, `Candidate`, `ProposedCapability`, `ASSESSMENT_FORMAT`, `EVIDENCE_CLASSES`, `READINESS_CLASSES`, … |

**Supported:** Protocol Buffers services with `google.api.http`, and Go (handlers, call graph, SQL literals, status codes, goroutines,
outbound `net/http`, configuration keys, tests). `go.mod` and `package.json` are read as manifests. Other languages are counted and
reported, and make an assessment partial.

**Scanner 2** (`assessRepository(path, { scanner: 2 })`, `appworks assess --scanner 2`, format `appport.application-assessment/2`) also reads the HTTP
routes a JavaScript or TypeScript application registers (Express, Fastify, Koa router, Hono, NestJS), with the prefixes of the mounts that lead to
each, the middleware in front of it and, where one exists, its handler's definition. A route is evidence that an entry point exists and nothing
more: no handler body is read and no shape is assumed, so a route is `investigate` at best, is never recommended, and cannot yet be extracted.
Scanner 1 is the default and its output is unchanged, so existing digests still reproduce. See `spec/assessment-1.md` §11.

**Guarantees:** it never writes to, executes, builds or imports anything in the target; it never follows symbolic links; it uses no network
and no language model. Every observed fact has a location you can check; every inference names its basis; what it cannot determine is
recorded as unknown. It never claims verified behavior, grants no authority, registers nothing, and its proposed capability is not a
contract. Depends only on `@appport/protocol` 1.2.0. Part of the AppPort ecosystem, not of the AppPort protocol. Not implemented:
extraction, compilation, execution and migration.
