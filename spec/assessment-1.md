# Existing-application assessment (`appport.application-assessment/1`)

**Status:** Draft, owned by AppWorks. Reference implementation: `@appport/assessment` in this repository (library and `appworks` CLI).
Schema: `packages/assessment/schemas/application-assessment.schema.json` (shipped in the package). Real-application fixture: a verbatim
subset of Memos, `packages/assessment/test/fixtures/memos/` (`PROVENANCE.md`).

The format is named in the `appport.*` ecosystem namespace and is **not** part of the AppPort protocol, which neither defines nor reads it
(`docs/architecture.md` §2).

## 1. Purpose, and what an assessment is not

An assessment reads an existing application's repository and records, with evidence, what business functionality it appears to expose,
where that functionality is implemented, what it reads, writes and calls, how it is authorized, validated and tested, and which candidate
is the most reasonable first one to expose through AppPort.

An assessment is a **static reading**. It is not:

* **verification**: no code is built, executed or contacted, so no behavior is observed. Nothing in an assessment is "verified";
* **a contract, fulfillment claim or registration**: a proposed capability shape is a starting point for a contract author, not an AppPort
  contract, and it is registered nowhere;
* **authority**: an assessment grants nothing. Binding a capability still requires an AppPort authorization grant;
* **extraction, compilation, execution or migration**: nothing in the target is rewritten, generated or moved.

## 2. Four concepts, kept apart

| Concept | What establishes it | In the artifact |
|---|---|---|
| **Discovered construct** | the source declares it (an RPC, a message, a function, a SQL literal) | observed evidence; `inventory` |
| **Capability candidate** | an entry point, with whatever implementation, inputs, outputs and effects the reading could link to it | `candidates[]` |
| **AppPort exposure candidate** | a candidate that satisfies every readiness criterion (§7) and has no blocking concern | `readiness.class: "exposure-candidate"`; at most one is `recommendation` |
| **Verified capability** | AppPort fulfillment and verification against a running implementation | **never** produced by an assessment; the verifier rejects any such claim (§8) |

Names and comments are never semantic evidence. They are used to *link* declarations (an RPC to the method that implements it, a test to
the method it calls) and the link is recorded as an inference with its basis; they are never used to say what code does.

## 3. The artifact

```
{
  "format": "appport.application-assessment/1",
  "assessment": { "id", "createdAt" },            volatile: excluded from the digest
  "tool": { "name", "version" },
  "target": { "name", "nameSource", "repository"?, "revision"?, "ref"? },
  "configuration": { "scanner": "appport.assessment-scanner/1", limits and thresholds },
  "coverage": { files seen and analyzed, languages, skipped (with reasons), malformed, partial, partialReasons },
  "evidence": [ Evidence ],
  "inventory": { manifests, constructs, entryPoints, persistence, integrations, configuration, authorization, tests },
  "candidates": [ Candidate ],
  "recommendation": Recommendation | null,
  "findings": [ { code, severity, message, path?, evidence? } ],
  "limitations": [ { code, description } ],
  "questions": [ { id, candidate?, question, evidence } ],
  "scope": { "grantsAuthority": false, "verifiesBehavior": false, "modifiesTarget": false },
  "digest": "sha256:<hex>"
}
```

* **Digest.** `digest` is `digestOf` of `@appport/protocol` (RFC 8785 canonical JSON, sha256) over the artifact **without** `digest` and
  `assessment`. This is the same rule recipe packages use. Two assessments of the same tree with the same configuration and tool version have the same digest.
* **Determinism.** Every list is sorted by a stated key; paths are repository-relative with `/`; no absolute path, timestamp, host name or
  environment value appears outside `assessment`. File creation order, traversal order and the checkout directory do not change the
  content: the target name comes from `go.mod` or `package.json` before the directory name, and `nameSource` says which.
* **Target identity.** `repository`, `revision` and `ref` are read from `.git` files (never by running git). Credentials in a remote URL are
  removed. An assessment without a revision is reported (`REVISION_UNKNOWN`).
* **Closed members.** A reader refuses undocumented members at the top level, in evidence records and in candidates, and refuses any other
  `format`. A new major format is a new string.

## 4. What is read

The walker visits the root in sorted order and either analyzes each file or reports it in `coverage.skipped` with a reason:

| Reason | When |
|---|---|
| `excluded-directory` | `.git`, `.hg`, `.svn`, `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `.next`, `.turbo`, `coverage`, `__pycache__`, `.venv` (configurable) |
| `ignored` | matched by the root `.gitignore` (subset: blank lines, comments, `dir/`, `*`, `?`, anchoring by a leading or inner `/`). Negation, `**`, character classes and escapes are **not applied** and listed in `coverage.unsupportedIgnorePatterns` |
| `symlink` | any symbolic link, file or directory, pointing inside or outside the root. Links are never followed |
| `generated` | a Go file whose header, before the package clause, matches `// Code generated … DO NOT EDIT.` |
| `too-large` | larger than `maxFileBytes` (1 MiB by default) |
| `binary` | a NUL byte in its first 8000 bytes |
| `unreadable` | the file or directory cannot be read |
| `special-file` | a FIFO, socket or device |

Containment: every read resolves inside the root, refuses a symbolic link, opens with `O_NOFOLLOW` and checks the open descriptor is a
regular file. Nothing is written to the target, nothing in it is executed or imported, and nothing is fetched: no network and no language
model is used.

## 5. Support matrix

| Input | Read as | Not interpreted |
|---|---|---|
| `*.proto` (§5.1) | packages, services, RPCs, `google.api.http` bindings, messages, fields, enums | everything in §5.1's last paragraph |
| `*.go` (§5.2) | imports, top-level functions and methods, structs, interfaces, constants and variables; calls, status codes, SQL literals, goroutines, configuration reads in bodies | everything in §5.2's last paragraph |
| `go.mod` | module path, direct requirements | replacements, workspaces |
| `package.json` | package name (target identity) | scripts, dependencies |
| TypeScript, JavaScript, Python, Java, Kotlin, Ruby, Rust, PHP, C#, Swift, Scala, C, C++, Vue, Svelte, Dart, Elixir | counted per language, reported `LANGUAGE_UNSUPPORTED` | everything |

A repository with files in an unsupported language, malformed files, unreadable or oversized files, unsupported ignore patterns, or a call
graph cut by its limits is a **partial** assessment (`coverage.partial`, with `partialReasons`).

### 5.1 Protocol Buffers

An entry point is an RPC of a `service`. Each RPC becomes one candidate (`cand-<package>.<Service>.<Method>`). Its `google.api.http` binding
(`get`/`put`/`post`/`delete`/`patch`, `body`) is a second entry point. Field labels (`repeated`, `optional`), `map<K, V>`, `oneof`,
`json_name` and `google.api.field_behavior` values are recorded; nested messages and enums are scoped by protobuf rules. Type references are
resolved within the analyzed files and the well-known types.

Not interpreted: custom options other than `google.api.http` and `google.api.field_behavior`, `additional_bindings` (counted), `custom`
HTTP patterns, extensions, groups, editions features, and imports not present in the repository (their types are reported unresolved).

### 5.2 Go

Go is read by a tokenizer and declaration parser, not a type checker. Implementation linking, the call graph and the facts it collects:

1. **RPC → handler.** A method named like the RPC, taking a direct pointer to the request message type (`*pb.GetMemoRequest`), is the
   handler (`link: "name-and-request-type"`). Wrappers taking the type as a type argument (`*connect.Request[pb.GetMemoRequest]`) are not
   handlers. If no method takes the type but exactly one has the name, the link is `name-only` (weaker, never sufficient for exposure). More
   than one match, or none, is recorded as unknown; nothing is chosen.
2. **Calls.** From the handler, breadth first, up to `maxCallDepth` (12) and `maxReachableFunctions` (400): `f()` in the same package;
   `r.M()` on the receiver, including methods promoted from embedded fields; `r.Field.M()` through the field's declared type;
   `pkg.F()` for repository packages (located through `go.mod` module paths). A call through an interface type is attributed to same-name
   methods, in the interface's package or a package importing it, whose parameter and result types match the interface method once the
   interface package's qualifier is removed (an inference). Calls into packages outside the repository are recorded as external packages
   and not followed. Every other call site (through local variables, closures, function-typed fields, method values) is counted as
   unresolved.
3. **Facts in reachable functions** (each observed at its line): authentication or authorization failure codes (`codes.Unauthenticated`,
   `codes.PermissionDenied`, `connect.CodeUnauthenticated`, `connect.CodePermissionDenied`, `http.StatusUnauthorized`,
   `http.StatusForbidden`); invalid-input codes (`codes.InvalidArgument`, `connect.CodeInvalidArgument`, `http.StatusBadRequest`,
   `http.StatusUnprocessableEntity`); SQL string literals beginning with `SELECT` (read), `INSERT`, `UPDATE`, `DELETE`, `REPLACE`,
   `UPSERT`, `MERGE` (write) or `WITH` (unknown); outbound HTTP through `net/http` (`Get`, `Post`, `Head`, `PostForm`, `NewRequest`,
   `NewRequestWithContext`, `DefaultClient`); `go` statements.
4. **Tests.** A `func TestX(t *testing.T)` in a `_test.go` file is related to a candidate when it calls a method of the RPC's name **and**
   references the request type (an inference).
5. **Method lists.** A string literal equal to a full RPC method name (`/memos.api.MemoService/GetMemo`) is recorded with its enclosing
   declaration (`var PublicMethods`). Its meaning is not inferred; it becomes a question.
6. **Configuration.** `os.Getenv`/`os.LookupEnv`, `viper.Get*`/`SetDefault`/`BindEnv`/`IsSet`, and cobra/pflag `Flags().X(…)` keys.

Not interpreted: types of expressions and local variables; generics beyond skipping type parameters; build tags (the first declaration in
path order wins); `init` side effects; reflection; `net/http` or framework route registration (entry points come from Protocol Buffers in
this version); middleware and interceptors; ORMs and query builders; message queues and caches.

## 6. Evidence

```
{ "id": "ev-<16 hex>", "class": "observed" | "inferred" | "unknown", "kind", "location"?: { "path", "startLine", "endLine" },
  "subject"?, "observation", "method", "basis"?: [ids], "limitations"?: [text] }
```

* **observed**: a statement about what the repository text contains at a location: a declaration, a call, a literal, a status code. It
  carries a `location`, and its `subject` (symbol, route, key or keyword) occurs in the cited lines. Anyone can check it by reading them,
  and `verifyAssessment` with the repository does (§8).
* **inferred**: a conclusion drawn from evidence by a stated rule (§5.2): "rpc ListUsers is implemented by `server/api:APIService.ListUsers`",
  "`s.driver.ListUsers` may dispatch to `store/db/sqlite:DB.ListUsers`", "this test exercises ListUsers". It cites its `basis`, which
  includes at least one observed record and never an unknown. It may be wrong.
* **unknown**: something the assessment looked for and could not determine: an implementation not found, call sites not resolved, a
  message not declared, the permissions a caller must hold. It is never evidence that something is absent.

`method` is the collection method: `manifest-parse`, `proto-static`, `go-static`, `derivation` (inferences and unknowns), and the reserved
`scanner`, `path-convention` and `git-metadata`. The `id` is a hash of the rest of the record, so the same fact always has the same id
and an edited record no longer matches its id. Every reference to evidence elsewhere in the artifact is a string array under a member named
`evidence` (or `basis` inside evidence) and must resolve.

## 7. Candidates, readiness and the recommendation

A candidate records its operation, entry points, implementation (symbol, location, link kind), input and output messages with fields,
reachable functions, external packages, unresolved call count, side effects (persistence reads and writes, outbound HTTP, goroutines),
authorization (denial codes, method-list references), validation (invalid-input codes), related tests, unknowns, a link `confidence`
(`linked`, `weakly-linked`, `unlinked`: a statement about how the implementation was linked, not a probability), its readiness and its
exposure proposal.

**Readiness criteria** (each `{ criterion, satisfied, reason, evidence }`, with a stable reason code):

| Criterion | Satisfied when |
|---|---|
| `entry-point` | an RPC is declared |
| `implementation` | the handler is linked by name **and** request type |
| `io-schema` | request and response messages and every nested type resolve |
| `validation` | an invalid-input code is reachable from the handler |
| `authorization` | an authentication or authorization failure code is reachable from the handler |
| `tests` | at least one related test |
| `reachability-complete` | the call graph was explored within its limits |
| `small-surface` | the handler is at most 80 lines and at most 60 functions are reachable (configurable) |

**Concerns:** `outbound-http`, `async-work` and `unresolved-interface` (an interface call with no implementation found) **block** exposure;
`writes-state` does not, but ranks a candidate after read-only ones.

**Classes:** `exposure-candidate` (all criteria satisfied, no blocking concern); `investigate` (an implementation is linked, but something
is unsatisfied or blocking); `insufficient-evidence` (no implementation linked). There is no score.

**Ranking** is a lexicographic order, recorded in `recommendation.ranking.rules`: readiness class, more criteria satisfied, fewer concerns,
`observation` before `consequential`, fewer reachable functions, candidate id. The **recommendation** is the first exposure candidate, with
the satisfied criteria and effect as `reasons`, up to three alternatives, and `beforeExposure`: the candidate's unknowns and questions,
always including which permissions a caller must hold. If no candidate is an exposure candidate the recommendation is `null` and
`NO_EXPOSURE_CANDIDATE` is reported.

## 8. Verification

`verifyAssessment(value, { repository? })` checks:

* format, closed members, evidence classes and methods, unique evidence and candidate ids, each evidence id against its content;
* every evidence reference resolves; inferred evidence cites at least one observed record and no unknown; observed evidence has a
  repository-relative location with a valid line range;
* readiness classes are the three of §7 and **no** `class`, `status`, `confidence`, `readiness` or `link` anywhere in candidates or the
  recommendation is `verified` (`VERIFIED_CLAIM`);
* `scope` is exactly `{ grantsAuthority: false, verifiesBehavior: false, modifiesTarget: false }`; every exposure is `proposed` and not
  authoritative;
* the recommendation names an exposure candidate in the artifact; questions name candidates in the artifact;
* the digest.

With `repository`, it also checks each observed location against the files (`LOCATION_MISSING`, `LOCATION_RANGE`, `LOCATION_SUBJECT`) and
the revision (`REVISION_MISMATCH`). An assessment that passes is internally consistent and its observations can be found where it says
they are. Its inferences remain inferences.

## 9. AppPort exposure proposals

`exposure` is `{ status: "proposed", authoritative: false, capability?, effectBasis, missing }`. `capability` uses AppPort's published
`CapabilityVersionEntry` fields (`version`, `kind`, `inputSchema`, `outputSchema`, `effect`) with a `name`:

* **name**: the RPC name split into words, operation last: `GetMemo` → `memo.get`, `ListMemoComments` → `memo.comments.list`. It is kept
  only if AppPort's `isValidName` accepts it (otherwise `missing` lists `capability-name`);
* **schemas**: the proto3 JSON mapping: lowerCamelCase or `json_name`, 64-bit integers as strings, enums as value names, well-known types
  as their JSON forms, maps as objects, nested messages under `$defs`. `REQUIRED` fields are `required` (a declaration, not proof of
  enforcement); `OUTPUT_ONLY` fields are left out of the input schema and `INPUT_ONLY` fields out of the output schema;
* **effect**: `consequential` if a SQL write, outbound HTTP or goroutine is reachable, or the HTTP binding is not `GET`; otherwise
  `observation`, with the reasons and evidence in `effectBasis`.

It has no `authorization` (permissions are unknown) and always lists `permissions`, `fulfillment-claim`, `verification-method` and
`contract-tests` as missing. Turning a proposal into a contract, a fulfillment claim and a verified binding is AppPort's process
(`fulfillment-1`), not the assessment's.

## 10. The CLI

```
appworks assess <repo> --output <file> [--force] [--strict]
appworks verify <file> [--repo <repo>]
appworks --version
```

`assess` writes the artifact (2-space JSON) and prints a summary: partial or complete, files, candidates by class, the recommendation, the
digest. It refuses an output path inside the assessed repository, and an existing output unless `--force` (and then only a regular file).

| Exit | Meaning |
|---|---|
| 0 | `assess`: an assessment was written, complete **or partial** (the summary's first word says which). `verify`: valid |
| 1 | fatal: the output cannot be written or the assessment failed; `verify`: the artifact is invalid or unreadable |
| 2 | invalid arguments: unknown command or option, missing `--output`, a repository path that is not a directory, an output directory that does not exist, an output inside the repository, or an existing output without `--force` |
| 3 | `assess --strict`: an assessment was written, but it is partial |

## 11. Not in this version

Automatic extraction, code generation, recipe compilation, execution, migration; HTTP-route discovery for frameworks; languages other than
Go and Protocol Buffers; runtime observation; any persistence, registry or service. An assessment feeds a person's decision about what to
expose; it does not make one.
