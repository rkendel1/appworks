# @appport/extraction

AppWorks capability extraction. It takes one candidate from a verified `appport.application-assessment/1` artifact and binds four
things into a versioned, content-addressed `appport.capability-extraction/1` artifact:
- the existing operation, at an immutable source revision;
- a proposed AppPort canonical contract;
- the adapter that exposes the operation through the application's existing AppPort boundary;
- verification records for named behaviors, each tied to the source, contract and adapter it tested.

Specification: `spec/extraction-1.md` in [rkendel1/appworks](https://github.com/rkendel1/appworks). The JSON Schema ships in
`schemas/`. This package also provides the `appworks` command:

```sh
appworks assess <repo> --output assessment.json
appworks extract assessment.json --candidate <id> --repo <repo> --output proposed.json            # no plan: a proposal
appworks extract assessment.json --candidate <id> --repo <repo> --plan plan.json --verification results.json --output x.json
appworks verify-extraction x.json --assessment assessment.json --repo <repo> --plan-dir <dir>
```

Exit codes: 0 when the artifact is written or valid, 1 for an unreadable input or an invalid artifact, 2 for invalid arguments or an
output that would overwrite or land inside the repository, and 4 when the extraction is refused (always with reason codes).

| Export | Purpose |
|---|---|
| `createExtraction` | the eligibility, contract, mapping, adapter, verification and revision rules; throws `ExtractionRefused` with every reason |
| `verifyExtraction`, `verifyExtractionAt` | integrity and honesty of an artifact, optionally against its assessment, repository and adapter sources |
| `compareExtractions` | revision rules; contract differences are AppPort's `compareManifests` |
| `candidateRefusals`, `assessmentRefusals`, `contractProblems`, `schemaProblems`, `contractChanges` | the individual checks |
| `BEHAVIORS`, `REQUIRED_BEHAVIORS`, `VERIFICATION_STATUSES` | what a read-only extraction verifies, and how results are stated |

It reads JSON and files and executes nothing: it never runs, imports or loads an adapter, and it uses no network or language model.
An extraction grants no authority, is not executable, establishes no equivalence beyond the behaviors recorded as passed, modifies
nothing and deploys nothing. Read-only request/response operations only.

Runtime dependencies are `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1 and `@appport/assessment`. It does not depend on
`@appport/core`, `@appport/sdk` or Distribution Protocol. Adapters live in private packages under `extractions/`.
