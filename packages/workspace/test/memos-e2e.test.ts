// The acceptance test: the Memos fork at e0ce856, carried through the whole workflow by the workspace's own domain API
// (the one the web workspace and the CLI call), with the real extraction runner and the real behavioral suite.
//
//   APPWORKS_MEMOS_E2E=1 APPWORKS_MEMOS_REPO=<checkout of rkendel1/memos at e0ce856> pnpm vitest run packages/workspace/test/memos-e2e.test.ts
//
// Acquisition goes through @appport/github and fetches the pinned commit from GitHub (public; no credential), unless
// APPWORKS_MEMOS_ACQUIRE=mirror, which fetches it from a bare mirror of APPWORKS_MEMOS_REPO under the same identity.
// Discovery needs a running application: the test builds Memos from APPWORKS_MEMOS_REPO with the declared build,
// starts it with the bridge's own harness and synthetic data, and starts the UNMODIFIED bridge with public discovery.
// That deployment is the test's environment, not the workspace's: the workspace only discovers it by its origin.
// Needs Go, Node >= 22.13 and the built packages (pnpm build). Takes several minutes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { environmentCredentials, githubProvider, gitProvider, localAuthority, projectView, treeHash, Workspace, type Principal } from "../src/index.js";

const SOURCE = process.env.APPWORKS_MEMOS_REPO ? resolve(process.env.APPWORKS_MEMOS_REPO) : undefined;
const ENABLED = process.env.APPWORKS_MEMOS_E2E === "1" && SOURCE !== undefined;
const PINNED = "e0ce8569589b2eccafd13e262ea3e320251858f2";
const ASSESSMENT = "sha256:903ff71d3605c003636e258d3f416746daa2d92f1e063350aa10358569669267";
const REVISION_1 = "sha256:81011ddc62b9f3dddf1b8ac54b5d499be2c58bbb8aae0bd65968afd58f550e41";
const REVISION_2 = "sha256:20b091270391b48ebfd6c44d65dbe243d9a725a914a5253384ced12f21fdee0e";
const CANDIDATE = "cand-memos.api.MemoService.ListMemoReactions";
const APPWORKS = resolve(import.meta.dirname, "..", "..", "..");
const EXTRACTIONS = join(APPWORKS, "extractions");
const OPERATOR: Principal = { id: "local:memos-e2e", kind: "user" };

describe.skipIf(!ENABLED)("Memos e0ce856, end to end through the workspace", () => {
  it("acquires, inspects, discovers, assesses, reconciles, extracts ListMemoReactions, verifies it and records all of it", async () => {
    const source = SOURCE!;
    const sourceBefore = treeHash(source);
    const committed = { 1: readFileSync(join(EXTRACTIONS, "memos-reactions/revisions/1/extraction.json"), "utf8"), 2: readFileSync(join(EXTRACTIONS, "memos-reactions/revisions/2/extraction.json"), "utf8") };

    // The running application the workspace discovers: Memos with synthetic data and its unmodified AppPort bridge.
    const load = (path: string) => import(pathToFileURL(join(source, "appport-bridge", path)).href);
    const { MEMOS_BUILD } = await import(pathToFileURL(join(EXTRACTIONS, "memos-reactions/test/support/verification.mjs")).href);
    const bin = join(mkdtempSync(join(tmpdir(), "e2e-memos-")), "memos");
    const flags = Object.entries(MEMOS_BUILD as Record<string, string>).map(([k, v]) => `-X github.com/usememos/memos/internal/version.${k}=${v}`).join(" ");
    execFileSync("go", ["build", "-buildvcs=false", "-ldflags", flags, "-o", bin, "./cmd/memos"], { cwd: source, stdio: "inherit" });
    process.env.MEMOS_BIN = bin;
    const { startMemos } = await load("test/support/memos-app.mjs");
    const { startProcess, freePort, removeDir } = await load("lib/harness.mjs");
    const memos = await startMemos();
    const bridge = await startProcess(process.execPath, ["--import", join(EXTRACTIONS, "memos-reactions/runtime/register.mjs"), join(source, "appport-bridge/bridge.mjs")], {
      env: { MEMOS_REPO: source, APPPORT_BRIDGE_UPSTREAM: memos.base, APPPORT_BRIDGE_PORT: String(await freePort()), APPPORT_BRIDGE_PUBLIC: "1" },
      readyLine: true,
      name: "memos bridge",
      timeoutMs: 30_000
    });

    const home = mkdtempSync(join(tmpdir(), "e2e-workspace-"));
    const ws = await Workspace.open({ home, authority: localAuthority({ [OPERATOR.id]: ["*"] }), credentials: environmentCredentials(process.env), providers: { github: githubProvider(), git: gitProvider() }, extractionsRoot: EXTRACTIONS, runnerTimeoutMs: 30 * 60_000 });
    const run = async (name: string, input: Record<string, unknown> = {}) => (await ws.dispatch(OPERATOR, id, name, input)).done;
    let id = "";
    try {
      // 1. select the revision (a commit on a branch of the fork, not on main)
      const mirrored = process.env.APPWORKS_MEMOS_ACQUIRE === "mirror";
      let fetchFrom: string | undefined;
      if (mirrored) {
        fetchFrom = join(mkdtempSync(join(tmpdir(), "e2e-mirror-")), "memos.git");
        execFileSync("git", ["clone", "-q", "--mirror", "--no-local", source, fetchFrom]);
      }
      // A read credential by reference when one is configured (CI): public reads are rate-limited per address.
      const read = process.env.GITHUB_TOKEN && !mirrored ? { readCredential: "env:GITHUB_TOKEN" } : {};
      const created = await ws.createProject(OPERATOR, { provider: mirrored ? "git" : "github", owner: "rkendel1", name: "memos", url: "https://github.com/rkendel1/memos", ref: PINNED, ...(fetchFrom ? { fetchFrom } : {}), ...read });
      id = created.id;
      // 2. an isolated copy of exactly that commit
      await run("acquire");
      let p = await run("pin");
      expect(p.revision!.sha).toBe(PINNED);
      // Whether the bridge change is on the fork's default branch is recorded as established (rkendel1/memos merged it
      // into main in #2, after this extraction was made), and anything short of "yes" stays a visible condition.
      if (p.revision!.onDefaultBranch !== "yes") expect(p.condition.reasons.map((r) => r.code)).toContain("REVISION_NOT_ON_DEFAULT_BRANCH");
      else expect(p.revision!.defaultBranchSha).toMatch(/^[0-9a-f]{40}$/);
      const checkout = ws.store.resolve(p.revision!.checkout);
      // 3. the bridge, found statically
      p = await run("inspect");
      const integration = await ws.artifact<{ status: string; integrations: Array<{ root: string; packages: Record<string, string> }> }>(OPERATOR, p.current.integration);
      expect(integration!.body.status).toBe("present");
      expect(integration!.body.integrations.find((i) => i.root === "appport-bridge")!.packages).toEqual({ "@appport/sdk": "1.2.2" });
      // 4. discovery through AppPort's client: the bridge's own capabilities, nothing invoked
      p = await run("discover", { endpoint: bridge.ready.url.replace(/\/$/, "") });
      const discovery = await ws.artifact<{ outcome: string; capabilities: Array<{ name: string; status: string }>; established: Record<string, boolean> }>(OPERATOR, p.current.discovery);
      expect(discovery!.body.outcome).toBe("discovered");
      expect(discovery!.body.capabilities.map((c) => `${c.name}:${c.status}`).sort()).toEqual(["memos.get:verified", "memos.search:verified"]);
      expect(Object.values(discovery!.body.established).every((v) => v === false)).toBe(true);
      // 5. assessment of the same revision: the digest the extraction records
      p = await run("assess");
      const assessment = await ws.artifact<{ digest: string; candidates: unknown[]; coverage: { partial: boolean } }>(OPERATOR, p.current.assessment);
      expect(assessment!.body.digest).toBe(ASSESSMENT);
      expect(assessment!.body.coverage.partial).toBe(true);
      expect(p.condition.reasons.map((r) => r.code)).toContain("ASSESSMENT_PARTIAL");
      // 6. reconciliation: every candidate kept; no match by name
      p = await run("reconcile");
      const inventory = await ws.artifact<{ capabilities: Array<{ name: string; status: string; candidates: Array<{ id: string }> }>; candidates: unknown[] }>(OPERATOR, p.current.inventory);
      expect(inventory!.body.candidates).toHaveLength(assessment!.body.candidates.length);
      expect(inventory!.body.capabilities.map((c) => c.name).sort()).toEqual(["memos.get", "memos.search"]);
      expect(inventory!.body.capabilities.every((c) => c.status !== "confirmed")).toBe(true);
      // 7. select ListMemoReactions; 8. validate the reviewed plan and its fulfillment declaration
      await run("select", { candidate: CANDIDATE, rationale: "clearest evidence, least sensitive data" });
      p = await run("plan");
      await run("request-approval");
      await expect(ws.execute(OPERATOR, id)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      const { subject } = await ws.approvalSubject(OPERATOR, id, "generate-files");
      await ws.approve(OPERATOR, id, { action: "generate-files", subject });
      // 9. execute: the reviewed runner builds Memos, runs the bridge with the host and the behavioral suite
      p = await run("execute");
      const extraction = await ws.artifact<{ digest: string; identity: { revision: number; previous: string }; verification: { summary: { passed: number }; records: unknown[] } }>(OPERATOR, p.current.extraction);
      // 10. the claim, the behaviors against real Memos, and the checkout
      p = await run("verify");
      const view = await projectView(ws, OPERATOR, id);
      expect(view.verification!.status).toBe("verified");
      expect(view.verification!.behaviors).toMatchObject({ required: 21, passed: 21, failed: 0, notRun: 0 });
      expect(view.verification!.records.find((r) => r.behavior === "integration.fulfillment-claim")).toEqual({ behavior: "integration.fulfillment-claim", status: "passed", against: "real-application" });
      expect(view.verification!.checkoutUnchanged).toBe(true);
      // the run reproduces the committed revision 2, which still names revision 1
      expect(extraction!.body.digest).toBe(REVISION_2);
      expect(extraction!.body.identity).toMatchObject({ revision: 2, previous: REVISION_1 });
      // the extraction's match is now confirmed; the bridge's own capabilities are unchanged in status
      expect(view.inventory!.capabilities.find((c) => c.name === "memos.reactions.list")).toMatchObject({ status: "confirmed", sources: ["extraction"] });
      // the extraction's open questions, the merge of the bridge change among them, stay visible with the result
      expect(view.extraction!.questions.map((q) => q.id)).toEqual(expect.arrayContaining(["q-merge-bridge", "q-adopt-contract"]));
      p = await run("ready");
      expect(p.stage).toBe("ready-for-promotion");
      // 11. persisted, and inspectable through the domain API the web workspace and the CLI use
      const reopened = await Workspace.open({ home, authority: localAuthority({ [OPERATOR.id]: ["project.read"] }), credentials: environmentCredentials({}), providers: {}, extractionsRoot: EXTRACTIONS });
      try {
        const persisted = await projectView(reopened, OPERATOR, id);
        expect(persisted.project.stage).toBe("ready-for-promotion");
        expect(persisted.extraction!.digest).toBe(REVISION_2);
        expect(persisted.promotion).toMatchObject({ status: "ready", deployed: false });
        expect(persisted.approvals.map((a) => [a.action, a.status])).toEqual([["generate-files", "consumed"]]);
        expect(persisted.history.map((h) => h.to).at(-1)).toBe("ready-for-promotion");
      } finally {
        await reopened.close();
      }
      // 12. nothing changed: the isolated checkout since pinning, the source checkout, and the committed history
      expect(treeHash(checkout)).toBe(p.revision!.treeDigest);
      expect(treeHash(source)).toBe(sourceBefore);
      expect(readFileSync(join(EXTRACTIONS, "memos-reactions/revisions/1/extraction.json"), "utf8")).toBe(committed[1]);
      expect(readFileSync(join(EXTRACTIONS, "memos-reactions/revisions/2/extraction.json"), "utf8")).toBe(committed[2]);
    } finally {
      await ws.close();
      await bridge.stop();
      await memos.stop();
      removeDir(memos.work);
    }
  }, 30 * 60_000);
});
