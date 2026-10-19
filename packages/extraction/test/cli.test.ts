import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { TOOL_VERSION } from "../src/index.js";
import { CANDIDATE, assess, planDirectory, repository, tempDir, treeHash } from "./fixtures.js";

const run = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { status, out: out.join("\n"), err: err.join("\n") };
};

describe("appworks extract", () => {
  const root = repository();
  const assessment = assess(root);
  const work = tempDir("extraction-cli-");
  const assessmentFile = join(work, "assessment.json");
  writeFileSync(assessmentFile, JSON.stringify(assessment));
  const dir = planDirectory(assessment);

  it("assesses, extracts and verifies through one command, leaving the repository unchanged", () => {
    const before = treeHash(root);
    const assessed = join(work, "again.json");
    expect(run("assess", root, "--output", assessed).status).toBe(0);
    const output = join(work, "x.json");
    const r = run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--plan", join(dir, "extraction-plan.json"), "--output", output);
    expect(r.status).toBe(0);
    const x = JSON.parse(readFileSync(output, "utf8"));
    expect(r.out).toContain(x.digest);
    expect(run("verify-extraction", output, "--assessment", assessmentFile, "--repo", root, "--plan-dir", dir).status).toBe(0);
    expect(run("verify-extraction", output, "--assessment", assessed).status).toBe(0); // the same content, another run
    expect(treeHash(root)).toBe(before);
    const proposed = join(work, "proposed.json");
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--output", proposed).out).toMatch(/^Proposed extraction note\.get/);
  });

  it("refuses with reason codes and exit 4", () => {
    const r = run("extract", assessmentFile, "--candidate", "cand-notes.v1.NoteService.DeleteNote", "--repo", root, "--output", join(work, "d.json"));
    expect(r.status).toBe(4);
    expect(r.err).toContain("CANDIDATE_NOT_READ_ONLY");
    expect(existsSync(join(work, "d.json"))).toBe(false);
    const moved = repository("e".repeat(40));
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", moved, "--output", join(work, "e.json")).err).toContain("REPOSITORY_REVISION_MISMATCH");
    const tampered = JSON.parse(readFileSync(assessmentFile, "utf8"));
    tampered.candidates[0].name = "x";
    writeFileSync(join(work, "tampered.json"), JSON.stringify(tampered));
    const t = run("extract", join(work, "tampered.json"), "--candidate", CANDIDATE, "--repo", root, "--output", join(work, "t.json"));
    expect([t.status, t.err.includes("ASSESSMENT_INVALID")]).toEqual([4, true]);
  });

  it("never overwrites without --force, never writes inside the repository, and exits 2 on bad arguments", () => {
    const output = join(work, "keep.json");
    writeFileSync(output, "keep");
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--output", output).status).toBe(2);
    expect(readFileSync(output, "utf8")).toBe("keep");
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--output", output, "--force").status).toBe(0);
    const before = treeHash(root);
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--output", join(root, "x.json")).status).toBe(2);
    expect(treeHash(root)).toBe(before);
    expect(run("extract", assessmentFile, "--repo", root, "--output", join(work, "n.json")).status).toBe(2);
    expect(run("extract", "--candidate", CANDIDATE, "--repo", root, "--output", join(work, "n.json")).status).toBe(2);
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", join(work, "missing"), "--output", join(work, "n.json")).status).toBe(2);
    expect(run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--output", join(work, "n.json"), "--deploy").status).toBe(2);
    expect(run("publish").status).toBe(2);
    expect(run("extract", join(work, "missing.json"), "--candidate", CANDIDATE, "--repo", root, "--output", join(work, "n.json")).status).toBe(1);
    expect(run("--version").out).toBe(`@appport/extraction ${TOOL_VERSION}`);
  });

  it("verify-extraction exits 1 for a modified artifact", () => {
    const output = join(work, "v.json");
    run("extract", assessmentFile, "--candidate", CANDIDATE, "--repo", root, "--plan", join(dir, "extraction-plan.json"), "--output", output);
    const x = JSON.parse(readFileSync(output, "utf8"));
    x.authorization.restrictions = [];
    writeFileSync(output, JSON.stringify(x));
    const r = run("verify-extraction", output);
    expect(r.status).toBe(1);
    expect(r.err).toContain("DIGEST_MISMATCH");
  });
});
