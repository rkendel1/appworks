/**
 * The one action table. The web API and the CLI both call `perform`; neither has its own path to the workflow.
 */
import { WorkspaceError, type Principal } from "./model.js";
import type { Workspace } from "./workflow.js";

/** Actions that start a step or a gated action (a run), and actions that complete at once. */
export const RUN_ACTIONS = ["acquire", "pin", "inspect", "propose-integration", "install-integration", "discover", "assess", "reconcile", "select", "plan", "request-approval", "execute", "verify", "ready", "propose-contract", "adopt-contract", "propose-promotion", "apply-promotion", "verify-promotion", "prepare-review", "submit-review", "commit", "pull-request", "push", "promote", "resume"] as const;
export const IMMEDIATE_ACTIONS = ["approve", "cancel", "assert-match", "approval-subject", "delete"] as const;
export const ACTIONS: readonly string[] = [...RUN_ACTIONS, ...IMMEDIATE_ACTIONS];

export type Performed = { kind: "started"; run: string; done: Promise<unknown> } | { kind: "done"; result: unknown };

export async function perform(ws: Workspace, principal: Principal, id: string, action: string, input: Record<string, unknown> = {}): Promise<Performed> {
  const text = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (action) {
    case "approve":
      return { kind: "done", result: await ws.approve(principal, id, { action: text("action"), subject: text("subject"), ...(text("head") ? { head: text("head") } : {}), ...(text("base") ? { base: text("base") } : {}) }) };
    case "approval-subject":
      return { kind: "done", result: await ws.approvalSubject(principal, id, text("action"), { ...(text("head") ? { head: text("head") } : {}), ...(text("base") ? { base: text("base") } : {}) }) };
    case "delete":
      return { kind: "done", result: await ws.deleteProject(principal, id) };
    case "cancel":
      return { kind: "done", result: await ws.cancel(principal, id, text("reason")) };
    case "assert-match":
      return { kind: "done", result: await ws.assertMatch(principal, id, { capability: text("capability"), candidate: text("candidate"), rationale: text("rationale") }) };
    case "resume": {
      const started = await ws.resume(principal, id);
      return { kind: "started", run: started.run, done: started.done };
    }
    default: {
      if (!(RUN_ACTIONS as readonly string[]).includes(action)) throw new WorkspaceError("INVALID_INPUT", `unknown action ${action}; actions are ${ACTIONS.join(", ")}`);
      const started = await ws.dispatch(principal, id, action, input);
      return { kind: "started", run: started.run, done: started.done };
    }
  }
}
