/**
 * Durable state. FeltDB 0.12.0 is the only authority (spec/runtime-1.md §2). `feltdb.flow` is authoritative for the
 * schema: it is deployed when the store opens (a destructive change is refused), and every write is checked against the
 * collection and fields it declares. A change to more than one record is one transaction; a change to an existing
 * record is fenced on the version that was read, a new record on `requireAbsent`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConditionalConflictError, createFeltDB, parseFlowSpec, validateFlowSpec, type FlowSpec } from "@feltdb/core";
import { RuntimeError } from "./model.js";

export type Collection = "RecipeRun" | "StepAttempt" | "Invocation" | "Verification" | "HumanTask" | "RunEvent";

export type Write = { collection: Collection; id: string; value: object } & ({ create: true } | { ifVersion: number });

type FeltDB = ReturnType<typeof createFeltDB>;
type Fields = Record<string, { type: string; optional: boolean }>;

const FLOW = new URL("../feltdb.flow", import.meta.url);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const strip = (value: object) => {
  const { __version: _v, ...rest } = value as Record<string, unknown>;
  return rest;
};

function typeProblem(type: string, value: unknown): string | undefined {
  if (type.startsWith("enum(")) return type.slice(5, -1).split(",").includes(value as string) ? undefined : `is not one of ${type}`;
  switch (type) {
    case "text": return typeof value === "string" ? undefined : "is not text";
    case "integer": return Number.isInteger(value) ? undefined : "is not an integer";
    case "boolean": return typeof value === "boolean" ? undefined : "is not a boolean";
    case "datetime": return typeof value === "string" && ISO.test(value) ? undefined : "is not an ISO datetime";
    default: return undefined;
  }
}

export class Store {
  private constructor(
    readonly db: FeltDB,
    readonly home: string,
    private readonly spec: FlowSpec,
    private readonly collections: Record<string, Fields>
  ) {}

  /** Opens (creating if needed) a runtime home: FeltDB state in `state/`. */
  static async open(home: string): Promise<Store> {
    mkdirSync(join(home, "state"), { recursive: true });
    const spec = parseFlowSpec(readFileSync(FLOW, "utf8"));
    const errors = validateFlowSpec(spec).filter((d) => d.severity === "error");
    if (errors.length) throw new RuntimeError("FLOW_NOT_DEPLOYED", `feltdb.flow: ${errors.map((e) => e.message).join("; ")}`);
    const collections: Record<string, Fields> = {};
    for (const c of spec.collections) collections[c.name] = Object.fromEntries(c.fields.map((f) => [f.name, { type: f.type, optional: f.optional }]));
    // Everything is passed explicitly, so no FELTDB_* variable or feltdb.config.json can redirect the authority.
    const db = createFeltDB({ namespace: "appworks-recipe-runtime", mode: "local", path: join(home, "state") });
    const store = new Store(db, home, spec, collections);
    try {
      const deployed = (await db.collection("_flow_apps").get(spec.app)) as { version: number; spec?: FlowSpec; status?: string } | null;
      if (!deployed || deployed.status !== "active" || JSON.stringify(deployed.spec) !== JSON.stringify(spec)) {
        try {
          await db.deployFlowSpec(spec, deployed?.version ?? 0);
        } catch (error) {
          throw new RuntimeError("FLOW_NOT_DEPLOYED", `feltdb.flow could not be deployed to ${home}: ${(error as Error).message}`);
        }
      }
      for (const c of spec.collections) {
        for (const i of c.indexes) {
          const m = /^(hash|sorted)\((\w+)\)$/.exec(`${i.kind}${i.expression}`.replace(/\s+/g, ""));
          if (!m) continue;
          try {
            db.collection(c.name).createIndex({ name: i.name, type: m[1] as "hash", field: m[2]! });
          } catch {
            /* already present in this handle */
          }
        }
      }
    } catch (error) {
      await db.close();
      throw error;
    }
    return store;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  private check(collection: Collection, value: Record<string, unknown>): void {
    const fields = this.collections[collection];
    if (!fields) throw new RuntimeError("RECORD_INVALID", `${collection} is not a collection of feltdb.flow`);
    const problems: string[] = [];
    for (const [name, field] of Object.entries(fields)) {
      const v = value[name];
      if (v === undefined || v === null) {
        if (!field.optional) problems.push(`${collection}.${name} is required`);
        continue;
      }
      const p = typeProblem(field.type, v);
      if (p) problems.push(`${collection}.${name} ${p}`);
    }
    for (const name of Object.keys(value)) if (!(name in fields) && name !== "__version") problems.push(`${collection}.${name} is not declared in feltdb.flow`);
    if (problems.length) throw new RuntimeError("RECORD_INVALID", `refused by feltdb.flow: ${problems.join("; ")}`, { problems });
  }

  async get<T>(collection: Collection, id: string): Promise<(T & { __version: number }) | undefined> {
    return ((await this.db.collection(collection).get(id)) ?? undefined) as (T & { __version: number }) | undefined;
  }

  async list<T>(collection: Collection, where: Record<string, unknown> = {}): Promise<Array<T & { __version: number }>> {
    return (await this.db.collection(collection).find(where)) as Array<T & { __version: number }>;
  }

  /** Applies every write or none. A version that moved, or a record that exists, is a `CONFLICT`: nothing is written. */
  async commit(writes: Write[], transactionId: string = randomUUID()): Promise<void> {
    const operations = writes.map((w) => {
      const value = JSON.parse(JSON.stringify({ ...strip(w.value), id: w.id })) as Record<string, unknown>;
      this.check(w.collection, value);
      return { ...w, value };
    });
    try {
      await this.db.transaction(
        { operations: operations.map((w) => ({ collection: w.collection, id: w.id, value: w.value, ...("create" in w ? { requireAbsent: true } : { ifVersion: w.ifVersion }) })) },
        { transactionId }
      );
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        const f = (error as ConditionalConflictError & { failure?: { key?: string; predicate?: string } }).failure;
        throw new RuntimeError("CONFLICT", `the record ${f?.key ?? ""} changed meanwhile (${f?.predicate ?? "version"}); re-read and try again`, { key: f?.key });
      }
      throw error;
    }
  }
}
