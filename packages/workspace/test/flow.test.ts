import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFeltDB } from "@feltdb/core";
import { FLOW_PATH, loadFlow, MODEL, recordProblems, Store, STAGES, STEPS, WorkspaceError } from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("feltdb.flow is the authority for the workspace's model", () => {
  it("declares the collections, the workflow's stages and steps, and the approval actions the code runs on", () => {
    expect(Object.keys(MODEL.collections)).toEqual(["Project", "StageEvent", "Run", "Artifact", "Approval", "Decision", "Verification", "Promotion", "AgentRun", "AgentTurn"]);
    expect(STAGES).toEqual(["project-selected", "repository-acquired", "revision-pinned", "integration-inspected", "integration-proposed", "integration-installed", "capabilities-discovered", "assessment-completed", "inventory-reconciled", "candidate-selected", "extraction-planned", "awaiting-approval", "extraction-executed", "verification-completed", "ready-for-promotion", "contract-proposed", "contract-adopted", "promotion-proposed", "promotion-applied", "promotion-verified", "ready-for-review", "submitted-for-review"]);
    expect(STEPS["apply-promotion"]).toEqual({ name: "apply-promotion", from: ["promotion-proposed"], rerun: [], to: "promotion-applied", evidence: "patch", approval: "modify-integration" });
    expect(STEPS.execute).toEqual({ name: "execute", from: ["awaiting-approval"], rerun: [], to: "extraction-executed", evidence: "extraction", approval: "generate-files" });
    expect(MODEL.approvalActions).toEqual(["generate-files", "adopt-contract", "modify-integration", "commit", "push", "pull-request", "promote"]);
  });

  it("refuses a flow that is not self-consistent", () => {
    const source = readFileSync(FLOW_PATH, "utf8");
    expect(() => loadFlow(source.replace("    to ready-for-promotion\n", "    to deployed\n"))).toThrow(/step verify names undeclared stage ready-for-promotion/);
    expect(() => loadFlow(source.replace("ready-for-review, submitted-for-review)", "ready-for-review, submitted-for-review, deployed)"))).toThrow(/Project.stage must enumerate exactly the workflow's stages/);
    expect(() => loadFlow(source.replace("approval generate-files", "approval deploy"))).toThrow(/undeclared approval deploy/);
    expect(() => loadFlow(source.replace("from awaiting-approval", "from nowhere"))).toThrow(/undeclared stage nowhere/);
    expect(() => loadFlow(source.replace("evidence integration", "run integration"))).toThrow(/unknown statement/);
    expect(() => loadFlow(source.replace("id: text\n    createdAt", "id: textt\n    createdAt"))).toThrow(/Unsupported field type/);
  });

  it("checks every record against its collection's declared fields", () => {
    const at = "2026-10-19T00:00:00.000Z";
    const run = { id: "r", projectId: "p", step: "acquire", attempt: 1, status: "running", owner: "w", actor: "a", startedAt: at, leaseExpiresAt: at };
    expect(recordProblems(MODEL, "Run", run)).toEqual([]);
    expect(recordProblems(MODEL, "Run", { ...run, status: "done" })).toEqual(["Run.status is not one of enum(running,succeeded,failed,abandoned,not-applied)"]);
    expect(recordProblems(MODEL, "Run", { ...run, token: "x" })).toEqual(["Run.token is not declared in feltdb.flow"]);
    expect(recordProblems(MODEL, "Run", { ...run, attempt: "1", startedAt: "yesterday" })).toEqual(["Run.attempt is not an integer", "Run.startedAt is not an ISO datetime"]);
    const { owner: _owner, ...missing } = run;
    expect(recordProblems(MODEL, "Run", missing)).toEqual(["Run.owner is required"]);
    expect(recordProblems(MODEL, "Jobs", run)).toEqual(["Jobs is not a collection of feltdb.flow"]);
  });

  it("deploys the flow into FeltDB once, and refuses writes the flow does not describe", async () => {
    const home = tempDir("ws-flow-");
    const store = await Store.open(home);
    try {
      expect(await store.flowVersion()).toBe(1);
      const deployed = await store.db.collection("_flow_apps").get("appworks_workspace");
      expect((deployed as { status: string }).status).toBe("active");
      const models = await store.db.collection("_flow_collection_models").find({ app: "appworks_workspace" });
      expect(models.map((m) => (m as { name: string }).name).sort()).toEqual(["AgentRun", "AgentTurn", "Approval", "Artifact", "Decision", "Project", "Promotion", "Run", "StageEvent", "Verification"]);
      const workflows = await store.db.collection("_flow_workflows").find({ app: "appworks_workspace" });
      expect((workflows[0] as { steps: Array<{ name: string }> }).steps.map((s) => s.name)).toContain("execute");
      const error = await store.commit([{ collection: "Run", id: "r1", value: { id: "r1", projectId: "p", secret: "x" }, create: true }]).catch((e) => e);
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe("RECORD_INVALID");
      expect(await store.get("Run", "r1")).toBeUndefined();
    } finally {
      await store.close();
    }
    const again = await Store.open(home);
    try {
      expect(await again.flowVersion()).toBe(1); // unchanged flow: not redeployed
    } finally {
      await again.close();
    }
  });

  it("refuses to open over a deployed flow that the packaged one would destroy", async () => {
    const home = tempDir("ws-flow-");
    const db = createFeltDB({ namespace: "appworks-workspace", mode: "local", path: `${home}/state` });
    const extra = { ...MODEL.spec, collections: [...MODEL.spec.collections, { name: "Legacy", fields: [{ name: "id", type: "text", optional: false }], indexes: [] }] };
    await db.deployFlowSpec(extra);
    await db.close();
    const error = await Store.open(home).catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("FLOW_NOT_DEPLOYED");
    expect((error as WorkspaceError).message).toMatch(/Destructive migration/);
  });
});
