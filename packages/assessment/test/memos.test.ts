/**
 * The assessment of a real application: a verbatim subset of Memos (test/fixtures/memos, PROVENANCE.md). Assertions
 * check structure, codes, locations and evidence classes, never English wording.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isValidName, type JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { assessRepository, verifyAssessment, type ApplicationAssessment, type Candidate, type Evidence } from "../src/index.js";
import { MEMOS_FIXTURE, clone, reseal, treeHash } from "./helpers.js";

const line = (path: string, n: number) => readFileSync(join(MEMOS_FIXTURE, path), "utf8").split("\n")[n - 1]!;

describe("assessing Memos (user-service slice)", () => {
  let before: string;
  let a: ApplicationAssessment;
  let ev: (id: string) => Evidence;
  let listUsers: Candidate;

  beforeAll(() => {
    before = treeHash(MEMOS_FIXTURE);
    a = assessRepository(MEMOS_FIXTURE, { now: () => new Date("2026-01-01T00:00:00Z"), id: () => "run-1" });
    const byId = new Map(a.evidence.map((e) => [e.id, e]));
    ev = (id) => byId.get(id)!;
    listUsers = a.candidates.find((c) => c.id === "cand-memos.api.UserService.ListUsers")!;
  });

  it("finds the real entry points declared in the proto service, at their real lines", () => {
    expect(a.target).toEqual({ name: "memos", nameSource: "go.mod" });
    expect(a.inventory.constructs.protoServices).toBe(1);
    expect(a.candidates).toHaveLength(a.inventory.constructs.protoMethods);
    const rpc = ev(listUsers.entryPoints[0]!.evidence[0]!);
    expect(rpc).toMatchObject({ class: "observed", kind: "proto.rpc", method: "proto-static", location: { path: "proto/api/user_service.proto" } });
    expect(line(rpc.location!.path, rpc.location!.startLine)).toMatch(/^\s*rpc ListUsers\(ListUsersRequest\) returns \(ListUsersResponse\)/);
    const http = listUsers.entryPoints.find((e) => e.kind === "http-binding")!;
    expect(http.subject).toBe("GET /api/users");
    expect(line("proto/api/user_service.proto", ev(http.evidence[0]!).location!.startLine)).toContain('get: "/api/users"');
  });

  it("links the handler by name and request type, as inferred evidence citing observed declarations", () => {
    expect(listUsers.implementation).toMatchObject({ symbol: "server/api:APIService.ListUsers", link: "name-and-request-type", location: { path: "server/api/user_service.go" } });
    expect(line("server/api/user_service.go", listUsers.implementation!.location.startLine)).toMatch(/^func \(s \*APIService\) ListUsers\(ctx context\.Context, request \*apipb\.ListUsersRequest\)/);
    expect(line("server/api/user_service.go", listUsers.implementation!.location.endLine)).toBe("}");
    const link = listUsers.implementation!.evidence.map(ev).find((e) => e.kind === "link.rpc-handler")!;
    expect(link.class).toBe("inferred");
    expect(link.basis!.map(ev).map((e) => [e.class, e.kind])).toEqual(expect.arrayContaining([["observed", "proto.rpc"], ["observed", "go.function"]]));
    expect(listUsers.confidence).toBe("linked");
  });

  it("describes inputs and outputs from the declared messages under the proto3 JSON mapping", () => {
    expect(listUsers.inputs).toMatchObject({ message: "memos.api.ListUsersRequest", resolved: true, unresolvedTypes: [] });
    expect(listUsers.inputs!.fields.map((f) => f.jsonName)).toEqual(["pageSize", "pageToken", "filter", "showDeleted"]);
    expect(listUsers.outputs!.fields.find((f) => f.name === "users")).toMatchObject({ type: "User", label: "repeated" });
    const capability = listUsers.exposure.capability!;
    expect(isValidName(capability.name)).toBe(true);
    const input = fromJSONSchema(capability.inputSchema as JSONSchema);
    expect(input.validate({ pageSize: 10, filter: 'username == "a"' }).ok).toBe(true);
    expect(input.validate({ pageSize: "ten" }).ok).toBe(false);
    // INPUT_ONLY fields never appear in an output schema.
    const user = (capability.outputSchema.$defs as Record<string, JSONSchema>)["memos.api.User"]!;
    expect(Object.keys(user.properties!)).not.toContain("password");
    expect(Object.keys(user.properties!)).toContain("username");
  });

  it("characterizes side effects, authorization, validation and tests with located evidence", () => {
    expect(listUsers.sideEffects.persistence.length).toBeGreaterThan(0);
    for (const p of listUsers.sideEffects.persistence) {
      expect(p.operation).toBe("read");
      const e = ev(p.evidence[0]!);
      expect(e.location!.path).toBe("store/db/sqlite/user.go");
      expect(readFileSync(join(MEMOS_FIXTURE, e.location!.path), "utf8").split("\n").slice(e.location!.startLine - 1, e.location!.endLine).join("\n")).toContain("SELECT");
    }
    expect(listUsers.sideEffects.outboundHttp).toEqual([]);
    expect(listUsers.sideEffects.async).toEqual([]);
    // The handler's own Unauthenticated and PermissionDenied codes, at their lines.
    const handler = listUsers.implementation!.location;
    const direct = listUsers.authorization.denials.map(ev).filter((e) => e.location!.path === handler.path && e.location!.startLine >= handler.startLine && e.location!.endLine <= handler.endLine);
    expect(direct.map((e) => e.subject).sort()).toEqual(["PermissionDenied", "Unauthenticated"]);
    for (const e of direct) expect(line(e.location!.path, e.location!.startLine)).toContain(`codes.${e.subject}`);
    expect(listUsers.validation.rejections.length).toBeGreaterThan(0);
    expect(listUsers.tests.map((t) => t.symbol).sort()).toEqual(["TestListUsersDefaultPageSizeReturnsAllWhenSmall", "TestListUsersInvalidPageToken", "TestListUsersPagination"]);
    for (const t of listUsers.tests) expect(ev(t.evidence[0]!).class).toBe("inferred");
    // The call graph reaches the SQLite driver through the store facade and the Driver interface.
    expect(listUsers.dependencies.reachableFunctions.map((f) => f.symbol)).toEqual(expect.arrayContaining(["store:Store.ListUsers", "store/db/sqlite:DB.ListUsers"]));
    const viaInterface = listUsers.dependencies.reachableFunctions.find((f) => f.symbol === "store/db/sqlite:DB.ListUsers")!;
    expect(ev(viaInterface.evidence[0]!)).toMatchObject({ class: "inferred", kind: "link.interface-call" });
    // A write path is classified as writing, and its effect proposed as consequential.
    const update = a.candidates.find((c) => c.id === "cand-memos.api.UserService.UpdateUser")!;
    expect(update.sideEffects.persistence.some((p) => p.operation === "write")).toBe(true);
    expect(update.exposure.effectBasis.effect).toBe("consequential");
  });

  it("keeps observed, inferred and unknown apart", () => {
    for (const e of a.evidence) {
      if (e.class === "observed") expect(e.location).toBeDefined();
      if (e.class === "inferred") expect(e.basis!.some((b) => ev(b).class === "observed")).toBe(true);
      if (e.class === "unknown") expect(e.basis).toBeUndefined();
    }
    expect(listUsers.unknowns.map(ev).map((e) => e.class)).toEqual(listUsers.unknowns.map(() => "unknown"));
    expect(listUsers.unknowns.map(ev).map((e) => e.kind)).toContain("unknown.permissions");
    // RPCs whose handlers are outside the subset are reported unknown, never guessed.
    const unlinked = a.candidates.filter((c) => !c.implementation);
    expect(unlinked.length).toBeGreaterThan(0);
    for (const c of unlinked) {
      expect(c.readiness.class).toBe("insufficient-evidence");
      expect(c.unknowns.map(ev).some((e) => e.kind === "unknown.implementation")).toBe(true);
    }
  });

  it("recommends one supported candidate and explains why", () => {
    expect(listUsers.readiness.class).toBe("exposure-candidate");
    expect(listUsers.readiness.criteria.every((c) => c.satisfied)).toBe(true);
    expect(a.recommendation).toMatchObject({ candidate: listUsers.id, readiness: "exposure-candidate", ranking: { position: 1 } });
    expect(a.recommendation!.reasons).toEqual(expect.arrayContaining(["implementation:handler-matched-by-name-and-request-type", "authorization:denial-code-reachable", "tests:tests-call-handler-with-request-type", "effect:observation"]));
    expect(a.recommendation!.ranking.rules[0]).toBe("readiness-class");
    expect(a.recommendation!.beforeExposure).toEqual(expect.arrayContaining(listUsers.unknowns));
    expect(a.questions.find((q) => q.id === a.recommendation!.beforeExposure.find((b) => b.startsWith("q-")))?.candidate).toBe(listUsers.id);
    expect(listUsers.exposure).toMatchObject({ status: "proposed", authoritative: false, capability: { name: "users.list", version: 1, kind: "request", effect: "observation" } });
    expect(listUsers.exposure.missing).toEqual(expect.arrayContaining(["permissions", "fulfillment-claim", "verification-method"]));
  });

  it("reports coverage gaps honestly", () => {
    expect(a.coverage.skipped).toContainEqual({ path: "proto/gen/api/common.pb.go", reason: "generated" });
    expect(a.coverage.languages).toContainEqual({ language: "typescript", files: 1, supported: false });
    expect(a.coverage.partial).toBe(true);
    expect(a.coverage.partialReasons).toEqual(expect.arrayContaining(["unsupported-languages", "unsupported-ignore-patterns"]));
    expect(a.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["LANGUAGE_UNSUPPORTED", "IGNORE_PATTERN_UNSUPPORTED", "IMPLEMENTATION_UNLINKED", "REVISION_UNKNOWN"]));
    expect(a.limitations.map((l) => l.code)).toEqual(expect.arrayContaining(["static-only", "generated-code", "dynamic-dispatch", "middleware"]));
    // PublicMethods-style lists are surfaced as questions, not interpreted.
    expect(a.questions.some((q) => q.id.startsWith("q-policy-list-server/api/acl_config.go#"))).toBe(true);
  });

  it("is stable across runs: only the volatile block differs, and the digest is equal", () => {
    const b = assessRepository(MEMOS_FIXTURE, { now: () => new Date("2027-06-01T00:00:00Z"), id: () => "run-2" });
    expect(b.digest).toBe(a.digest);
    expect({ ...b, assessment: null }).toEqual({ ...a, assessment: null });
    expect(b.assessment).not.toEqual(a.assessment);
  });

  it("verifies, including every observed location against the files, and rejects a modified artifact", () => {
    expect(verifyAssessment(a)).toEqual({ ok: true, findings: [] });
    expect(verifyAssessment(a, { repository: MEMOS_FIXTURE })).toEqual({ ok: true, findings: [] });
    const edited = clone(a);
    edited.recommendation!.candidate = "cand-memos.api.UserService.UpdateUser";
    expect(verifyAssessment(edited).findings.map((f) => f.code)).toContain("DIGEST_MISMATCH");
    const moved = clone(a);
    const target = moved.evidence.find((e) => e.kind === "go.function")!;
    target.location = { ...target.location!, startLine: target.location!.startLine + 3, endLine: target.location!.endLine + 3 };
    const resealed = reseal(moved);
    expect(verifyAssessment(resealed).ok).toBe(true);
    expect(verifyAssessment(resealed, { repository: MEMOS_FIXTURE }).findings.map((f) => f.code)).toContain("LOCATION_SUBJECT");
  });

  it("does not modify the repository", () => {
    expect(treeHash(MEMOS_FIXTURE)).toBe(before);
  });
});
