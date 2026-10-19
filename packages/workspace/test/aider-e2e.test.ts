/**
 * The agent on a real repository with no AppPort integration: Aider (Python) at a pinned commit, fetched from GitHub
 * with git. Gated: APPWORKS_AIDER_E2E=1 (network: GitHub, and the npm registry for the installed integration). The
 * agent installs AppPort (after its approval), discovers the installed integration, continues, and stops at the
 * blocker the evidence shows; it never claims progress it did not make.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime, deterministicAgent, installPackages, projectView, type AgentRunRecord } from "../src/index.js";
import { openWorkspace, OPERATOR } from "./helpers.js";

const SHA = "5dc9490bb35f9729ef2c95d00a19ccd30c26339c";

describe.skipIf(process.env.APPWORKS_AIDER_E2E !== "1")("the agent on Aider-AI/aider", () => {
  it("installs AppPort, discovers it, continues through reconciliation and finishes blocked on what the evidence shows", async () => {
    const ws = await openWorkspace({ leaseMs: 60_000, installPackages: (directory, signal) => installPackages(directory, { signal }) });
    try {
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "Aider-AI", name: "aider", url: "https://github.com/Aider-AI/aider", fetchFrom: "https://github.com/Aider-AI/aider.git", ref: SHA });
      const runtime = new AgentRuntime(ws);
      const agent = deterministicAgent();
      let run: AgentRunRecord = await (await runtime.start(OPERATOR, p.id, { agent })).done;
      expect(run).toMatchObject({ status: "paused", pause: { approval: "modify-integration" } });
      const { subject } = await ws.approvalSubject(OPERATOR, p.id, "modify-integration");
      await ws.approve(OPERATOR, p.id, { action: "modify-integration", subject });
      run = await (await runtime.resume(OPERATOR, run.id, { agent })).done;
      const view = await projectView(ws, OPERATOR, p.id);
      expect(view.project.revision!.sha).toBe(SHA);
      expect(view.installation).toMatchObject({ state: "installed", application: { id: "com.github.aider-ai.aider" }, install: { verified: true } });
      expect(view.discovery).toMatchObject({ outcome: "discovered", application: { id: "com.github.aider-ai.aider" } });
      expect(view.project.stage).toBe("inventory-reconciled");
      expect(run.status).toBe("blocked");
      expect(run.outcome!.blockers!.join("\n")).toMatch(/NO_CANDIDATE[\s\S]*ASSESSMENT_PARTIAL: .*unsupported-languages/);
    } finally {
      await ws.close();
    }
  }, 900_000);
});
