/**
 * The workspace's FeltDB application model, read from the packaged `feltdb.flow`, which is authoritative. Collections,
 * fields, indexes, the workflow's steps and stages, and the approval actions all come from it; nothing here restates
 * them. A flow that does not parse, does not validate with FeltDB's own `validateFlowSpec`, or is not self-consistent
 * (a stage enum that differs from the workflow's stages, a step reaching an undeclared stage) stops the workspace.
 */
import { readFileSync } from "node:fs";
import { parseFlowSpec, validateFlowSpec, type FlowSpec } from "@feltdb/core";

export const FLOW_PATH = new URL("../feltdb.flow", import.meta.url);
export const WORKFLOW = "transformation";

export interface StepModel {
  name: string;
  from: string[];
  rerun: string[];
  to: string;
  evidence?: string;
  approval?: string;
}

export interface WorkflowModel {
  spec: FlowSpec;
  source: string;
  stages: string[];
  steps: Record<string, StepModel>;
  approvalActions: string[];
  collections: Record<string, Record<string, { type: string; optional: boolean }>>;
  indexes: Array<{ collection: string; name: string; type: string; field: string }>;
}

export class FlowError extends Error {
  constructor(message: string) {
    super(`feltdb.flow: ${message}`);
    this.name = "FlowError";
  }
}

export function loadFlow(source: string = readFileSync(FLOW_PATH, "utf8")): WorkflowModel {
  let spec: FlowSpec;
  try {
    spec = parseFlowSpec(source);
  } catch (error) {
    throw new FlowError((error as Error).message);
  }
  const errors = validateFlowSpec(spec).filter((d) => d.severity === "error");
  if (errors.length) throw new FlowError(errors.map((e) => `${e.path ? `${e.path}: ` : ""}${e.message}`).join("; "));
  const workflow = spec.workflows.find((w) => w.name === WORKFLOW);
  if (!workflow) throw new FlowError(`no workflow ${WORKFLOW}`);
  const steps: Record<string, StepModel> = {};
  const stages: string[] = [];
  for (const step of workflow.steps) {
    const words = (keyword: string) => step.statements.filter((s) => s.startsWith(`${keyword} `)).flatMap((s) => s.slice(keyword.length + 1).trim().split(/\s+/));
    const to = words("to");
    if (to.length !== 1) throw new FlowError(`step ${step.name} must reach exactly one stage`);
    const unknown = step.statements.filter((s) => !/^(from|rerun|to|evidence|approval) /.test(s));
    if (unknown.length) throw new FlowError(`step ${step.name}: unknown statement ${unknown[0]}`);
    const evidence = words("evidence");
    const approval = words("approval");
    steps[step.name] = { name: step.name, from: words("from"), rerun: words("rerun"), to: to[0]!, ...(evidence[0] ? { evidence: evidence[0] } : {}), ...(approval[0] ? { approval: approval[0] } : {}) };
    if (!stages.includes(to[0]!)) stages.push(to[0]!);
  }
  for (const step of Object.values(steps))
    for (const stage of [...step.from, ...step.rerun]) if (!stages.includes(stage)) throw new FlowError(`step ${step.name} names undeclared stage ${stage}`);
  const policy = spec.policies.find((p) => p.name === "approvals");
  const approvalActions = (policy?.statements ?? []).filter((s) => s.startsWith("action ")).map((s) => s.slice(7).trim());
  for (const step of Object.values(steps)) if (step.approval && !approvalActions.includes(step.approval)) throw new FlowError(`step ${step.name} requires undeclared approval ${step.approval}`);
  const collections: WorkflowModel["collections"] = {};
  const indexes: WorkflowModel["indexes"] = [];
  for (const c of spec.collections) {
    collections[c.name] = Object.fromEntries(c.fields.map((f) => [f.name, { type: f.type, optional: f.optional }]));
    for (const i of c.indexes) {
      const m = /^(hash|sorted)\((\w+)\)$/.exec(`${i.kind}${i.expression}`.replace(/\s+/g, ""));
      if (m) indexes.push({ collection: c.name, name: i.name, type: m[1]!, field: m[2]! });
    }
  }
  const enumOf = (collection: string, field: string) => {
    const type = collections[collection]?.[field]?.type ?? "";
    return type.startsWith("enum(") ? type.slice(5, -1).split(",") : undefined;
  };
  if (JSON.stringify(enumOf("Project", "stage")) !== JSON.stringify(stages)) throw new FlowError("Project.stage must enumerate exactly the workflow's stages, in order");
  if (JSON.stringify(enumOf("Approval", "action")) !== JSON.stringify(approvalActions)) throw new FlowError("Approval.action must enumerate exactly the approval policy's actions");
  return { spec, source, stages, steps, approvalActions, collections, indexes };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function typeProblem(type: string, value: unknown): string | undefined {
  if (type.startsWith("enum(")) return type.slice(5, -1).split(",").includes(value as string) ? undefined : `is not one of ${type}`;
  const array = /^array<(.+)>$/.exec(type);
  if (array) return Array.isArray(value) ? value.map((v) => typeProblem(array[1]!, v)).find(Boolean) : "is not an array";
  switch (type) {
    case "text":
      return typeof value === "string" ? undefined : "is not text";
    case "integer":
      return Number.isInteger(value) ? undefined : "is not an integer";
    case "boolean":
      return typeof value === "boolean" ? undefined : "is not a boolean";
    case "datetime":
      return typeof value === "string" && ISO.test(value) ? undefined : "is not an ISO datetime";
    case "json":
      return value !== undefined && typeof value !== "function" ? undefined : "is not JSON";
    default:
      return undefined;
  }
}

/** Every problem of a record against its collection's declaration: unknown collection or field, missing or mistyped field. */
export function recordProblems(model: WorkflowModel, collection: string, value: Record<string, unknown>): string[] {
  const fields = model.collections[collection];
  if (!fields) return [`${collection} is not a collection of feltdb.flow`];
  const out: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    const v = value[name];
    if (v === undefined || v === null) {
      if (!field.optional) out.push(`${collection}.${name} is required`);
      continue;
    }
    const p = typeProblem(field.type, v);
    if (p) out.push(`${collection}.${name} ${p}`);
  }
  for (const name of Object.keys(value)) if (!(name in fields) && name !== "__version") out.push(`${collection}.${name} is not declared in feltdb.flow`);
  return out;
}
