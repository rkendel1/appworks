import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { TOOL_VERSION } from "../src/index.js";
import { syntheticApp, tempDir, treeHash, writeTree } from "./helpers.js";

const run = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { status, out: out.join("\n"), err: err.join("\n") };
};

describe("appworks CLI", () => {
  it("writes an assessment and a summary, and leaves the target unchanged", () => {
    const repo = writeTree(tempDir(), syntheticApp());
    const output = join(tempDir(), "assessment.json");
    const before = treeHash(repo);
    const r = run("assess", repo, "--output", output);
    expect(r.status).toBe(0);
    expect(treeHash(repo)).toBe(before);
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact.format).toBe("appport.application-assessment/1");
    expect(r.out).toContain(artifact.digest);
    expect(run("verify", output).status).toBe(0);
    expect(run("verify", output, "--repo", repo).status).toBe(0);
  });

  it("never overwrites without --force, and never writes inside the repository", () => {
    const repo = writeTree(tempDir(), syntheticApp());
    const output = join(tempDir(), "assessment.json");
    writeFileSync(output, "keep");
    expect(run("assess", repo, "--output", output).status).toBe(2);
    expect(readFileSync(output, "utf8")).toBe("keep");
    expect(run("assess", repo, "--output", output, "--force").status).toBe(0);
    const before = treeHash(repo);
    expect(run("assess", repo, "--output", join(repo, "assessment.json")).status).toBe(2);
    expect(run("assess", repo, "--output", join(repo, "server", "service.go"), "--force").status).toBe(2);
    expect(treeHash(repo)).toBe(before);
  });

  it("distinguishes partial assessments, and fails them only with --strict", () => {
    const repo = writeTree(tempDir(), syntheticApp({ "web/app.ts": "export const x = 1;\n" }));
    const loose = run("assess", repo, "--output", join(tempDir(), "a.json"));
    expect(loose.status).toBe(0);
    expect(loose.out).toMatch(/^Partial assessment/);
    expect(run("assess", repo, "--output", join(tempDir(), "b.json"), "--strict").status).toBe(3);
    const complete = writeTree(tempDir(), syntheticApp());
    expect(run("assess", complete, "--output", join(tempDir(), "c.json"), "--strict").status).toBe(0);
  });

  it("exits 2 for invalid arguments and 1 for invalid artifacts", () => {
    const repo = writeTree(tempDir(), syntheticApp());
    expect(run().status).toBe(2);
    expect(run("extract", repo).status).toBe(2);
    expect(run("assess", repo).status).toBe(2);
    expect(run("assess", "--output", join(tempDir(), "x.json")).status).toBe(2);
    expect(run("assess", repo, "--output").status).toBe(2);
    expect(run("assess", repo, "--output", join(tempDir(), "x.json"), "--execute").status).toBe(2);
    expect(run("assess", join(tempDir(), "missing"), "--output", join(tempDir(), "x.json")).status).toBe(2);
    const missingDir = join(tempDir(), "no", "such", "x.json");
    expect(run("assess", repo, "--output", missingDir).status).toBe(2);
    expect(existsSync(missingDir)).toBe(false);
    const output = join(tempDir(), "a.json");
    run("assess", repo, "--output", output);
    const tampered = JSON.parse(readFileSync(output, "utf8"));
    tampered.candidates[0].readiness.class = "verified";
    writeFileSync(output, JSON.stringify(tampered));
    const r = run("verify", output);
    expect(r.status).toBe(1);
    expect(r.err).toContain("READINESS_CLASS");
    expect(run("verify", join(tempDir(), "missing.json")).status).toBe(1);
    expect(run("--version").out).toBe(`@appport/assessment ${TOOL_VERSION}`);
  });
});
