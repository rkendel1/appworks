/**
 * The agent on a real repository it cannot extract from: Aider (Python) at a pinned commit, fetched from GitHub with
 * git. Gated: APPWORKS_AIDER_E2E=1 (network). It must stop at an evidence-backed blocker, never claim progress.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime, deterministicAgent, type DiscoveryRecord } from "../src/index.js";
import { openWorkspace, OPERATOR } from "./helpers.js";

const SHA = "5dc9490bb35f9729ef2c95d00a19ccd30c26339c";

describe.skipIf(process.env.APPWORKS_AIDER_E2E !== "1")("the agent on Aider-AI/aider", () => {
  it("runs inspection through reconciliation and finishes blocked on what the evidence shows", async () => {
    const ws = await openWorkspace({ leaseMs: 60_000 });
    try {
      const p = await ws.createProject(OPERATOR, { provider: "git", owner: "Aider-AI", name: "aider", url: "https://github.com/Aider-AI/aider", fetchFrom: "https://github.com/Aider-AI/aider.git", ref: SHA });
      const run = await (await new AgentRuntime(ws).start(OPERATOR, p.id, { agent: deterministicAgent() })).done;
      const project = await ws.project(OPERATOR, p.id);
      expect(project.revision!.sha).toBe(SHA);
      expect(project.stage).toBe("inventory-reconciled");
      expect((await ws.artifact<DiscoveryRecord>(OPERATOR, project.current.discovery))!.body.outcome).toBe("no-integration");
      expect(run.status).toBe("blocked");
      expect(run.outcome!.blockers!.join("\n")).toMatch(/NO_CANDIDATE[\s\S]*ASSESSMENT_PARTIAL: .*unsupported-languages/);
    } finally {
      await ws.close();
    }
  }, 600_000);
});
