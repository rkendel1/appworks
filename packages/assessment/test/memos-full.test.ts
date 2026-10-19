/**
 * The whole Memos repository at the pinned commit, when `APPWORKS_MEMOS_REPO` names a checkout of it (CI provides one;
 * see .github/workflows/ci.yml). Every observed location is checked against the files.
 */
import { describe, expect, it } from "vitest";
import { assessRepository, verifyAssessment } from "../src/index.js";
import { MEMOS_COMMIT, treeHash } from "./helpers.js";

const repo = process.env.APPWORKS_MEMOS_REPO;

describe.skipIf(!repo)("assessing the full Memos repository", () => {
  it("is tied to the pinned revision, verifies against the files, is stable, and modifies nothing", () => {
    const before = treeHash(repo!);
    const a = assessRepository(repo!);
    expect(a.target.revision).toBe(MEMOS_COMMIT);
    expect(verifyAssessment(a, { repository: repo! })).toEqual({ ok: true, findings: [] });
    expect(a.candidates).toHaveLength(a.inventory.constructs.protoMethods);
    expect(a.candidates.length).toBeGreaterThan(50);
    expect(a.coverage.skipped.some((s) => s.reason === "generated" && s.path.startsWith("proto/gen/"))).toBe(true);
    expect(a.coverage.languages.find((l) => l.language === "typescript")?.supported).toBe(false);
    const recommended = a.candidates.find((c) => c.id === a.recommendation?.candidate)!;
    expect(recommended.readiness.class).toBe("exposure-candidate");
    expect(recommended.readiness.criteria.every((c) => c.satisfied)).toBe(true);
    expect(recommended.implementation?.link).toBe("name-and-request-type");
    const getMemo = a.candidates.find((c) => c.id === "cand-memos.api.MemoService.GetMemo")!;
    expect(getMemo.implementation?.symbol).toBe("server/api:APIService.GetMemo");
    expect(getMemo.authorization.policyReferences.length).toBeGreaterThan(0);
    expect(assessRepository(repo!).digest).toBe(a.digest);
    expect(treeHash(repo!)).toBe(before);
  });
});
