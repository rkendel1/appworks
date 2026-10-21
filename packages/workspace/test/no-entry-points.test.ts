import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectView, noEntryPoints } from "../src/index.js";
import { tempDir, writeTree } from "../../assessment/test/helpers.js";
import { OPERATOR, advanceTo, notesRepository, openWorkspace, step } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

/** A Go reverse proxy: one catch-all `/` handler, no Protocol Buffers: nothing the assessor treats as an entry point. */
function proxyRepository(): string {
  const work = writeTree(tempDir("ws-proxy-"), {
    "go.mod": "module example.com/router\n\ngo 1.22\n",
    "cmd/main.go": 'package main\n\nimport "net/http"\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { /* forward upstream */ })\n\t_ = http.ListenAndServe(":12000", nil)\n}\n',
    "README.md": "# router\n\nA reverse proxy.\n"
  });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "router");
  const mirror = join(tempDir("ws-mirror-"), "router.git");
  git(work, "clone", "-q", "--bare", "--no-local", work, mirror);
  return mirror;
}

describe("a revision with nothing to extract", () => {
  it("is shown as such, with the reason from the records, and is not offered a reconcile that could only join two empty sets", async () => {
    const mirror = proxyRepository();
    const ws = await openWorkspace();
    try {
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "router", url: "https://github.com/example/router", fetchFrom: mirror, ref: "main" });
      for (const name of ["acquire", "pin", "inspect", "discover", "assess"]) await step(ws, OPERATOR, p.id, name);
      const view = await projectView(ws, OPERATOR, p.id);

      expect(view.project.stage).toBe("assessment-completed"); // the workflow did not fail: it is at the stage it reached
      expect(view.project.condition.state).toBe("active");
      expect(view.assessment).toMatchObject({ candidates: 0 });
      expect(view.assessment!.findings.map((f) => f.code)).toContain("NO_ENTRY_POINTS");
      expect(noEntryPoints(view)!.reasons.join(" ")).toMatch(/no supported entry points/);

      expect(view.status).toMatchObject({ tone: "attention", label: "No extractable entry points" });
      expect(view.next.summary).toMatch(/Nothing to extract/);
      expect(view.next.summary).toMatch(/nothing went wrong/);
      expect(view.next.actions.map((a) => a.action)).toEqual(["cancel"]); // the record can be kept, or the project cancelled
    } finally {
      await ws.close();
    }
  });

  it("changes nothing for a revision that has entry points", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace();
    try {
      const id = await advanceTo(ws, mirror, "assess");
      const view = await projectView(ws, OPERATOR, id);
      expect(view.assessment!.candidates).toBeGreaterThan(0);
      expect(noEntryPoints(view)).toBeUndefined();
      expect(view.status.label).not.toBe("No extractable entry points");
      expect(view.next.actions.map((a) => a.action)).toContain("reconcile");
    } finally {
      await ws.close();
    }
  });
});
