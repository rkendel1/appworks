import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPromotion, patchDigest, promotionProblems, SimulatedCrash, treeHash, WorkspaceError, type ApprovalRecord, type ContractAdoption, type Project, type Promotion, type PromotionRecord, type Run } from "../src/index.js";
import { advanceTo, extractionsRoot, notesRepository, openWorkspace, OPERATOR, ADVANCER, step, tempDir } from "./helpers.js";
import { listExtractions } from "../src/index.js";

const refusal = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error, `expected ${code}`).toBeInstanceOf(WorkspaceError);
  expect((error as WorkspaceError).code).toBe(code);
  return error as WorkspaceError;
};

const promotionOf = async (ws: Awaited<ReturnType<typeof openWorkspace>>, id: string) => {
  const p = await ws.project(OPERATOR, id);
  const artifact = await ws.artifact<Promotion>(OPERATOR, p.current.promotionArtifact);
  const records = await ws.records<PromotionRecord>(OPERATOR, "Promotion", id);
  return { p, promotion: artifact!.body, record: records.find((r) => r.digest === artifact!.body.digest)! };
};

describe("contract adoption and promotion, end to end on the notes service (stub runners)", () => {
  it("adopts the contract, applies exactly the approved files to an isolated worktree, verifies them and commits locally", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "prepare-review");
      const { p, promotion, record } = await promotionOf(ws, id);
      expect(p.stage).toBe("ready-for-review");
      expect(record.state).toBe("ready-for-review");
      // The adoption proposal: every difference with its support; nothing blocking.
      const adoption = (await ws.artifact<ContractAdoption>(OPERATOR, p.current.adoption))!.body;
      expect(adoption.blocking).toEqual([]);
      expect(adoption.scope).toEqual({ grantsAuthority: false, registers: false, establishesEquivalence: false, adoptsInto: "target-integration" });
      expect(adoption.differences.find((d) => d.id === "authority:requirement")!.support).toBe("verified");
      // The artifact: deterministic, every promoted file a copy of a verified one, existing files untouched.
      expect(promotion.target.files.map((f) => [f.path, f.role])).toEqual([
        ["bridge/appworks/notes-get/README.md", "documentation"],
        ["bridge/appworks/notes-get/adapter.mjs", "adapter"],
        ["bridge/appworks/notes-get/contract.json", "contract"],
        ["bridge/appworks/notes-get/fulfillment.json", "declaration"]
      ]);
      expect(promotion.scope).toEqual({ grantsAuthority: false, modifiesExistingFiles: false, commits: false, pushes: false, deploys: false });
      const x = (await ws.artifact<{ verification: { records: Array<{ subject: unknown }> } }>(OPERATOR, p.current.extraction))!.body;
      expect(promotion.verification.subject).toEqual(x.verification.records[0]!.subject);
      // The worktree: only the approved files, on the pinned base; the pinned checkout unchanged.
      const worktree = ws.store.resolve(record.worktree);
      expect(worktree).not.toBe(ws.store.resolve(p.revision!.checkout));
      for (const f of promotion.target.files) expect(readFileSync(join(worktree, f.path)).equals(readFileSync(join(ex.dir, f.source)))).toBe(true);
      expect(treeHash(ws.store.resolve(p.revision!.checkout))).toBe(p.revision!.treeDigest);
      expect(record.patchDigest).toBe(patchDigest(promotion.target.base, promotion.target.files));
      const patch = (await ws.artifact<{ diff: string; files: unknown[] }>(OPERATOR, record.patch))!.body;
      expect(patch.diff.match(/^diff --git /gm)).toHaveLength(4);
      expect(patch.diff).not.toMatch(/^--- a\//m); // additions only
      // Approvals: adopt-contract and modify-integration each consumed once.
      const approvals = await ws.records<ApprovalRecord>(OPERATOR, "Approval", id);
      expect(approvals.map((a) => [a.action, a.status]).sort()).toEqual([["adopt-contract", "consumed"], ["generate-files", "consumed"], ["modify-integration", "consumed"]]);

      // Commit: its own approval, of exactly this patch; a local commit; a repeated commit is adopted, not duplicated.
      await refusal(ws.commitPromotion(OPERATOR, id), "APPROVAL_REQUIRED");
      const { subject } = await ws.approvalSubject(OPERATOR, id, "commit");
      await ws.approve(OPERATOR, id, { action: "commit", subject });
      await (await ws.commitPromotion(OPERATOR, id)).done;
      const committed = (await promotionOf(ws, id)).record;
      expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(committed.branch).toMatch(/^appworks\/promotion\/note.get-/);
      await refusal(ws.commitPromotion(OPERATOR, id), "APPROVAL_CONSUMED");
      // Push and submission are enforced, then refused: no contract exists for them.
      await refusal(ws.dispatch(OPERATOR, id, "push", {}), "APPROVAL_REQUIRED");
      await refusal(ws.submitReview(OPERATOR, id), "APPROVAL_REQUIRED");
      const pr = await ws.approvalSubject(OPERATOR, id, "pull-request");
      await ws.approve(OPERATOR, id, { action: "pull-request", subject: pr.subject });
      const unsupported = await refusal(ws.submitReview(OPERATOR, id), "UNSUPPORTED");
      expect(unsupported.message).toMatch(/no push, commit or compare contract/);
      expect((await ws.project(OPERATOR, id)).stage).toBe("ready-for-review");
    } finally {
      await ws.close();
    }
  });

  it("builds the same promotion artifact from the same inputs, and refuses a changed one with reason codes", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "propose-promotion");
      const { p, promotion } = await promotionOf(ws, id);
      const x = (await ws.artifact(OPERATOR, p.current.extraction))!.body as never;
      const entry = listExtractions(ex.root)[0]!;
      const again = buildPromotion({ project: id, checkout: ws.store.resolve(p.revision!.checkout), repository: { url: p.repository.url, owner: p.repository.owner, name: p.repository.name }, revision: p.revision!.sha, entry, extraction: x, adoptionDigest: promotion.adoption.digest });
      expect(again).toEqual(promotion);
      expect(promotionProblems(promotion, { revision: p.revision!.sha, extractionDigest: promotion.extraction.digest, adoptionDigest: promotion.adoption.digest, extractionDirectory: ex.dir })).toEqual([]);
      const tampered = { ...promotion, target: { ...promotion.target, files: [...promotion.target.files, { ...promotion.target.files[0]!, path: "bridge/kit.mjs" }] } };
      expect(promotionProblems(tampered, {}).map((r) => r.code)).toEqual(["PROMOTION_DIGEST_MISMATCH"]);
      expect(promotionProblems(promotion, { revision: "b".repeat(40) }).map((r) => r.code)).toEqual(["PROMOTION_REVISION_STALE"]);
      expect(promotionProblems(promotion, { extractionDigest: "sha256:x" }).map((r) => r.code)).toEqual(["PROMOTION_EXTRACTION_MISMATCH"]);
      expect(promotionProblems(promotion, { adoptionDigest: "sha256:x" }).map((r) => r.code)).toEqual(["PROMOTION_ADOPTION_MISMATCH"]);
      expect(promotionProblems({ ...promotion, format: "x" }, {}).map((r) => r.code)).toEqual(["PROMOTION_FORMAT"]);
    } finally {
      await ws.close();
    }
  });
});

/** A real AppPort application that already declares note.get, with another interface (discovery's existing declaration). */
async function existingNoteGet(input: "name" | "id", optionalOutput = false) {
  const { createApplication, createServer, defineCapability, permissionAuthorizer, s } = await import("@appport/sdk");
  const { serve } = await import("@appport/sdk/node");
  const get = defineCapability({ name: "note.get", version: 1, description: "Read a note.", input: s.object({ [input]: s.string() }), output: optionalOutput ? s.object({ name: s.optional(s.string()), body: s.optional(s.string()) }) : s.object({ name: s.string(), body: s.string() }), effect: "observation", authorization: ["notes.read"], handler: async () => ({ name: "", body: "" }) } as never);
  const app = createApplication({ application: { id: "com.example.notes", name: "Notes", version: "1.0.0" }, capabilities: [get], authorizer: permissionAuthorizer() } as never);
  const server = createServer({ application: app, publication: { public: true, applicationDescription: true, capabilities: [{ name: "note.get", version: 1 }] } } as never);
  const running = (await serve({ server, host: "127.0.0.1", port: 0, websocket: false } as never)) as { url: string; close(): Promise<void> };
  return { url: running.url.replace(/\/$/, ""), close: () => running.close() };
}

describe("contract adoption refuses what it cannot establish", () => {
  it("blocks adoption on an existing declaration whose interface is incompatible", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const app = await existingNoteGet("id");
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "propose-contract", { endpoint: app.url });
      const p = await ws.project(OPERATOR, id);
      const adoption = (await ws.artifact<ContractAdoption>(OPERATOR, p.current.adoption))!.body;
      expect(adoption.existingDeclarations).toEqual([expect.objectContaining({ name: "note.get", relation: "reconciled with the candidate", comparable: true })]);
      expect(adoption.blocking.find((b) => b.code === "CONTRACT_INCOMPATIBLE")!.message).toMatch(/input.id: input.field-removed/);
      expect(adoption.blocking.map((b) => b.code)).toContain("CONTRACT_INCOMPATIBLE");
      expect(p.condition.reasons.map((r) => r.code)).toContain("ADOPTION_BLOCKED");
      const { subject } = await ws.approvalSubject(OPERATOR, id, "adopt-contract");
      await refusal(ws.approve(OPERATOR, id, { action: "adopt-contract", subject }), "ADOPTION_BLOCKED");
      await refusal(ws.adoptContract(OPERATOR, id), "ADOPTION_BLOCKED");
    } finally {
      await ws.close();
      await app.close();
    }
  });

  it("does not block on a compatible existing declaration, and records it as a declaration, not as equivalence", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const app = await existingNoteGet("name", true);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "propose-contract", { endpoint: app.url });
      const adoption = (await ws.artifact<ContractAdoption>(OPERATOR, (await ws.project(OPERATOR, id)).current.adoption))!.body;
      expect(adoption.existingDeclarations.map((d) => d.name)).toEqual(["note.get"]);
      expect(adoption.blocking.filter((b) => b.code === "CONTRACT_INCOMPATIBLE")).toEqual([]);
    } finally {
      await ws.close();
      await app.close();
    }
  });

  it("blocks adoption on an open security question, and refuses a proposal whose inputs changed after approval", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work, { promotion: { adoption: { questions: { "q-x": { impact: "security", disposition: "open", reason: "who may read deleted notes is not established" } } } } });
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "propose-contract");
      const adoption = (await ws.artifact<ContractAdoption>(OPERATOR, (await ws.project(OPERATOR, id)).current.adoption))!.body;
      expect(adoption.blocking).toEqual([expect.objectContaining({ code: "QUESTION_OPEN", subject: "q-x" })]);
      // The reviewer resolves it: the proposal must be made again, and approved again.
      const planPath = join(ex.dir, "promotion", "promotion-plan.json");
      const plan = JSON.parse(readFileSync(planPath, "utf8"));
      plan.adoption.questions["q-x"] = { impact: "security", disposition: "accepted", reason: "deleted notes are not readable through Memos itself" };
      writeFileSync(planPath, JSON.stringify(plan));
      await refusal(ws.adoptContract(OPERATOR, id), "ADOPTION_BLOCKED"); // the stored proposal is still the blocked one
      await step(ws, OPERATOR, id, "propose-contract");
      const { subject } = await ws.approvalSubject(OPERATOR, id, "adopt-contract");
      await ws.approve(OPERATOR, id, { action: "adopt-contract", subject });
      // ...and a change after approval makes the approved proposal stale.
      plan.adoption.questions["q-x"].reason = "changed after approval";
      writeFileSync(planPath, JSON.stringify(plan));
      await refusal(ws.adoptContract(OPERATOR, id), "ADOPTION_STALE");
      expect((await ws.project(OPERATOR, id)).stage).toBe("contract-proposed");
      // The advancer may act but not approve; authority is not approval.
      await step(ws, OPERATOR, id, "propose-contract");
      const fresh = await ws.approvalSubject(OPERATOR, id, "adopt-contract");
      await refusal(ws.approve(ADVANCER, id, { action: "adopt-contract", subject: fresh.subject }), "UNAUTHORIZED");
    } finally {
      await ws.close();
    }
  });

  it("refuses to propose a contract whose verification is stale (a changed fulfillment declaration)", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "ready");
      writeFileSync(join(ex.dir, "fulfillment.json"), "{ not json");
      await refusal((await ws.proposeContract(OPERATOR, id)).done, "VERIFICATION_STALE");
    } finally {
      await ws.close();
    }
  });
});

describe("promotion refuses stale, changed and unapproved inputs", () => {
  it("requires an approval of exactly the current artifact, and makes a changed artifact need a new one", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "propose-promotion");
      await refusal(ws.applyPromotion(OPERATOR, id), "APPROVAL_REQUIRED");
      const { subject } = await ws.approvalSubject(OPERATOR, id, "modify-integration");
      await ws.approve(OPERATOR, id, { action: "modify-integration", subject });
      expect((await promotionOf(ws, id)).record.state).toBe("approved");
      // The documentation file changes: a new artifact, which the old approval does not cover.
      appendFileSync(join(ex.dir, "promotion", "README.md"), "changed\n");
      await refusal(ws.applyPromotion(OPERATOR, id), "PROMOTION_SOURCE_CHANGED");
      await step(ws, OPERATOR, id, "propose-promotion");
      await refusal(ws.applyPromotion(OPERATOR, id), "APPROVAL_REQUIRED");
      expect(await ws.records<Run>(OPERATOR, "Run", id).then((r) => r.filter((x) => x.step === "apply-promotion"))).toEqual([]);
    } finally {
      await ws.close();
    }
  });

  it("refuses a verified file that changed in the extraction, a declaration left out, and a stale source revision", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "approve-promotion");
      // A file the extraction verified is modified: neither the old artifact nor a new one accepts it.
      const adapter = readFileSync(join(ex.dir, "adapter.mjs"), "utf8");
      writeFileSync(join(ex.dir, "adapter.mjs"), `${adapter}// modified after verification\n`);
      await refusal(ws.applyPromotion(OPERATOR, id), "PROMOTION_SOURCE_CHANGED");
      writeFileSync(join(ex.dir, "adapter.mjs"), adapter);
      // The pinned checkout changes: the revision is no longer the approved one.
      const p = await ws.project(OPERATOR, id);
      appendFileSync(join(ws.store.resolve(p.revision!.checkout), "go.mod"), "\n");
      await refusal((await ws.applyPromotion(OPERATOR, id)).done, "REVISION_CHANGED");
    } finally {
      await ws.close();
    }
    const other = extractionsRoot(notesRepository().work, { promotion: { target: { directory: "bridge/appworks/notes-get", files: [{ source: "contract.json", path: "contract.json", role: "contract" }, { source: "adapter.mjs", path: "adapter.mjs", role: "adapter" }], excluded: [{ source: "fulfillment.json", reason: "left out" }] } } });
    const { mirror: m2 } = notesRepository();
    const ws2 = await openWorkspace({ extractionsRoot: other.root });
    try {
      const id = await advanceTo(ws2, m2, "adopt-contract");
      await refusal((await ws2.proposePromotion(OPERATOR, id)).done, "PROMOTION_DECLARATION_MISSING");
    } finally {
      await ws2.close();
    }
  });

  it("refuses a destination with unexpected changes, and a patch with a file outside the approved set, keeping the evidence", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    let intrude = true;
    const ws = await openWorkspace({
      extractionsRoot: ex.root,
      faultPoint: (name, ctx) => {
        if (name === "after-patch-written" && intrude) writeFileSync(join(ctx.worktree!, "bridge", "kit.mjs"), "export const kit = 2;\n");
      }
    });
    try {
      const id = await advanceTo(ws, mirror, "approve-promotion");
      const e = await refusal((await ws.applyPromotion(OPERATOR, id)).done, "PATCH_OUTSIDE_APPROVED_SET");
      expect(e.message).toMatch(/bridge\/kit.mjs/);
      const { p, record } = await promotionOf(ws, id);
      expect(p.condition.state).toBe("failed");
      expect(record.state).toBe("approved");
      expect(record.patch).toBeDefined(); // the patch as found is kept for inspection
      const patch = (await ws.artifact<{ diff: string }>(OPERATOR, record.patch))!.body;
      expect(patch.diff).toMatch(/bridge\/kit.mjs/);
      expect(record.reasons!.map((r) => r.code)).toContain("PATCH_OUTSIDE_APPROVED_SET");
      expect(existsSync(join(ws.store.resolve(record.worktree), "bridge", "appworks", "notes-get", "adapter.mjs"))).toBe(true);
      // Resuming does not paper over it: the destination is not what the approval covers.
      intrude = false;
      await refusal(ws.resume(OPERATOR, id).then((s) => s.done), "DESTINATION_DIRTY");
      expect((await ws.records<ApprovalRecord>(OPERATOR, "Approval", id)).find((a) => a.action === "modify-integration")!.status).toBe("granted");
    } finally {
      await ws.close();
    }
  });
});

describe("promotion verification", () => {
  it("records failed behaviors, a surviving mutant, a runner that writes to the worktree and missing results as not verified", async () => {
    for (const [mode, code] of [["fail", "BEHAVIOR_NOT_PASSED"], ["survive", "MUTANT_SURVIVED"], ["write-worktree", "WORKTREE_CHANGED"], ["no-results", "RESULTS_MISSING"]] as const) {
      const { mirror, work } = notesRepository();
      const ex = extractionsRoot(work, { promotionMode: mode });
      const ws = await openWorkspace({ extractionsRoot: ex.root });
      try {
        const id = await advanceTo(ws, mirror, "verify-promotion");
        const { p, record } = await promotionOf(ws, id);
        expect(record.state, mode).toBe("verification-failed");
        expect(record.reasons!.map((r) => r.code), mode).toContain(code);
        expect(p.condition.reasons.map((r) => r.code)).toContain("PROMOTION_NOT_VERIFIED");
        await refusal((await ws.prepareReview(OPERATOR, id)).done, mode === "write-worktree" ? "NOT_VERIFIED" : "NOT_VERIFIED");
        // The patch is kept.
        expect(existsSync(join(ws.store.resolve(record.worktree), "bridge", "appworks", "notes-get", "contract.json"))).toBe(true);
      } finally {
        await ws.close();
      }
    }
  });

  it("refuses to verify a worktree that no longer holds exactly the patch", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const ws = await openWorkspace({ extractionsRoot: ex.root });
    try {
      const id = await advanceTo(ws, mirror, "apply-promotion");
      const { record } = await promotionOf(ws, id);
      appendFileSync(join(ws.store.resolve(record.worktree), "bridge", "appworks", "notes-get", "adapter.mjs"), "// edited\n");
      const e = await refusal((await ws.verifyPromotion(OPERATOR, id)).done, "WORKTREE_CHANGED");
      expect(e.message).toMatch(/differs from the approved file/);
    } finally {
      await ws.close();
    }
  });
});

describe("promotion recovery and concurrency", () => {
  it("recovers a crash after the patch was written: the resumed run inspects the worktree and writes nothing twice", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-home-");
    const crashing = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-a", leaseMs: 1_000, faultPoint: (name) => { if (name === "after-patch-written") throw new SimulatedCrash(name); } });
    let id = "";
    try {
      id = await advanceTo(crashing, mirror, "approve-promotion");
      await expect((await crashing.applyPromotion(OPERATOR, id)).done).rejects.toBeInstanceOf(SimulatedCrash);
    } finally {
      await crashing.close();
    }
    const recovering = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-b", leaseMs: 1_000 });
    try {
      const held = await recovering.project(OPERATOR, id);
      expect(held.activeRun).toMatch(/\.apply-promotion\.1$/);
      await refusal(recovering.resume(OPERATOR, id), "STEP_IN_PROGRESS");
      await new Promise((r) => setTimeout(r, 1_200));
      const p = await (await recovering.resume(OPERATOR, id)).done;
      expect(p.stage).toBe("promotion-applied");
      const runs = (await recovering.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "apply-promotion").sort((a, b) => a.attempt - b.attempt);
      expect(runs.map((r) => r.status)).toEqual(["abandoned", "succeeded"]);
      const { record } = await promotionOf(recovering, id);
      const patch = (await recovering.artifact<{ files: unknown[] }>(OPERATOR, record.patch))!.record;
      expect(patch.summary).toMatchObject({ written: 0, alreadyPresent: 4 });
      expect((await recovering.records<ApprovalRecord>(OPERATOR, "Approval", id)).filter((a) => a.action === "modify-integration").map((a) => [a.status, a.consumedBy])).toEqual([["consumed", runs[1]!.id]]);
      // A repeated operation after recovery is refused, not repeated.
      await refusal(recovering.resume(OPERATOR, id), "NOTHING_TO_RESUME");
      await refusal(recovering.applyPromotion(OPERATOR, id), "INVALID_TRANSITION");
    } finally {
      await recovering.close();
    }
  }, 20_000);

  it("adopts a commit made before a crash instead of committing again", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-home-");
    const crashing = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-a", leaseMs: 1_000, faultPoint: (name) => { if (name === "after-commit") throw new SimulatedCrash(name); } });
    let id = "";
    let commit = "";
    try {
      id = await advanceTo(crashing, mirror, "prepare-review");
      const { subject } = await crashing.approvalSubject(OPERATOR, id, "commit");
      await crashing.approve(OPERATOR, id, { action: "commit", subject });
      await expect((await crashing.commitPromotion(OPERATOR, id)).done).rejects.toBeInstanceOf(SimulatedCrash);
      const { record } = await promotionOf(crashing, id);
      expect(record.commit).toBeUndefined(); // the commit exists in git, not yet in FeltDB
      const { execFileSync } = await import("node:child_process");
      commit = execFileSync("git", ["-C", crashing.store.resolve(record.worktree), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } finally {
      await crashing.close();
    }
    const recovering = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-b", leaseMs: 1_000 });
    try {
      await new Promise((r) => setTimeout(r, 1_200));
      await (await recovering.resume(OPERATOR, id)).done;
      const { record } = await promotionOf(recovering, id);
      expect(record.commit).toBe(commit);
      const { execFileSync } = await import("node:child_process");
      expect(execFileSync("git", ["-C", recovering.store.resolve(record.worktree), "rev-list", "--count", `${record.base}..HEAD`], { encoding: "utf8" }).trim()).toBe("1");
      const run = (await recovering.records<Run>(OPERATOR, "Run", id)).find((r) => r.step === "commit" && r.status === "succeeded")!;
      expect(run.effect).toMatchObject({ commit, adopted: true });
    } finally {
      await recovering.close();
    }
  }, 20_000);

  it("lets exactly one of two concurrent promotion attempts apply", async () => {
    const { mirror, work } = notesRepository();
    const ex = extractionsRoot(work);
    const home = tempDir("ws-home-");
    const a = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-a" });
    const b = await openWorkspace({ home, extractionsRoot: ex.root, worker: "worker-b" });
    try {
      const id = await advanceTo(a, mirror, "approve-promotion");
      const results = await Promise.allSettled([a.applyPromotion(OPERATOR, id), b.applyPromotion(OPERATOR, id)]);
      const won = results.filter((r) => r.status === "fulfilled") as Array<PromiseFulfilledResult<{ done: Promise<Project> }>>;
      expect(won).toHaveLength(1);
      expect(["CONFLICT", "STEP_IN_PROGRESS"]).toContain(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as WorkspaceError).code);
      await won[0]!.value.done;
      expect((await a.project(OPERATOR, id)).stage).toBe("promotion-applied");
      expect((await a.records<Run>(OPERATOR, "Run", id)).filter((r) => r.step === "apply-promotion")).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
