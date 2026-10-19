/**
 * Durable state. FeltDB 0.12.0 is the only authority for project identity, revision, runs, inventory, decisions, stage
 * history, artifact and verification references, approvals and promotion status. Every change that touches more than
 * one record is one FeltDB transaction, and every change to an existing record is fenced on the version that was read,
 * so two writers can never both win. Artifact bodies (assessments run to megabytes) are content-addressed files under
 * the workspace home: FeltDB holds their references and digests, and a file is only ever read through a reference whose
 * digest it must match.
 *
 * `feltdb.flow` is authoritative for the schema: it is deployed into FeltDB when the store opens (`deployFlowSpec`,
 * which refuses a destructive migration), its indexes are created, and every write is checked against the collection
 * and fields it declares before it is committed. A record the flow does not describe is never written.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConditionalConflictError, createFeltDB, type FlowSpec } from "@feltdb/core";
import { recordProblems } from "./flow.js";
import { MODEL, WorkspaceError, type ArtifactRecord } from "./model.js";

/** The collections of `feltdb.flow`. */
export type Collection = "Project" | "StageEvent" | "Run" | "Artifact" | "Approval" | "Decision" | "Verification" | "Promotion" | "AgentRun" | "AgentTurn";

/** One write in a transaction: create (`requireAbsent`) or replace the version that was read (`ifVersion`). */
export type Write = { collection: Collection; id: string; value: Record<string, unknown> } & ({ create: true } | { ifVersion: number });

type FeltDB = ReturnType<typeof createFeltDB>;

const strip = (value: Record<string, unknown>) => {
  const { __version: _v, ...rest } = value;
  return rest;
};

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export class Store {
  readonly db: FeltDB;
  private constructor(
    db: FeltDB,
    readonly home: string
  ) {
    this.db = db;
  }

  /** Opens (creating if needed) the workspace home: FeltDB state in `state/`, artifact bodies in `artifacts/`. */
  static async open(home: string): Promise<Store> {
    mkdirSync(join(home, "artifacts"), { recursive: true });
    // Everything is passed explicitly, so no FELTDB_* variable or feltdb.config.json can redirect the authority.
    const db = createFeltDB({ namespace: "appworks-workspace", mode: "local", path: join(home, "state") });
    const store = new Store(db, home);
    try {
      await store.deploy();
    } catch (error) {
      await db.close();
      throw error;
    }
    return store;
  }

  /** Deploys the packaged flow when FeltDB holds another one; a destructive change is refused, never applied. */
  private async deploy(): Promise<{ app: string; version: number }> {
    const deployed = (await this.db.collection("_flow_apps").get(MODEL.spec.app)) as { version: number; spec?: FlowSpec; status?: string } | null;
    let version = deployed?.version ?? 0;
    if (!deployed || deployed.status !== "active" || JSON.stringify(deployed.spec) !== JSON.stringify(MODEL.spec)) {
      try {
        version = (await this.db.deployFlowSpec(MODEL.spec, deployed?.version ?? 0)).version;
      } catch (error) {
        throw new WorkspaceError("FLOW_NOT_DEPLOYED", `feltdb.flow could not be deployed to ${this.home}: ${(error as Error).message}`);
      }
    }
    for (const index of MODEL.indexes) {
      try {
        this.db.collection(index.collection).createIndex({ name: index.name, type: index.type as "hash", field: index.field });
      } catch {
        /* already present in this handle */
      }
    }
    return { app: MODEL.spec.app, version };
  }

  /** The deployed flow's version, as FeltDB records it. */
  async flowVersion(): Promise<number> {
    return ((await this.db.collection("_flow_apps").get(MODEL.spec.app)) as { version: number } | null)?.version ?? 0;
  }

  private check(collection: Collection, value: Record<string, unknown>): void {
    const problems = recordProblems(MODEL, collection, value);
    if (problems.length) throw new WorkspaceError("RECORD_INVALID", `refused by feltdb.flow: ${problems.join("; ")}`, { problems });
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async get<T>(collection: Collection, id: string): Promise<(T & { __version: number }) | undefined> {
    const value = await this.db.collection(collection).get(id);
    return (value ?? undefined) as (T & { __version: number }) | undefined;
  }

  async list<T>(collection: Collection, where: Record<string, unknown> = {}): Promise<Array<T & { __version: number }>> {
    return (await this.db.collection(collection).find(where)) as Array<T & { __version: number }>;
  }

  /**
   * Applies every write or none. A version that moved since it was read, or a record that already exists, is a
   * `CONFLICT`: nothing is written and the caller re-reads. `transactionId` makes a retried commit a no-op.
   */
  async commit(writes: Write[], transactionId: string = randomUUID()): Promise<void> {
    const operations = writes.map((w) => {
      const value = JSON.parse(JSON.stringify({ ...strip(w.value), id: w.id })) as Record<string, unknown>;
      this.check(w.collection, value);
      return { ...w, value };
    });
    try {
      await this.db.transaction(
        {
          operations: operations.map((w) => ({
            collection: w.collection,
            id: w.id,
            value: w.value,
            ...("create" in w ? { requireAbsent: true } : { ifVersion: w.ifVersion })
          }))
        },
        { transactionId }
      );
    } catch (error) {
      if (error instanceof ConditionalConflictError) {
        const f = (error as ConditionalConflictError & { failure?: { collection?: string; key?: string; predicate?: string } }).failure;
        throw new WorkspaceError("CONFLICT", `the record ${f?.key ?? ""} changed meanwhile (${f?.predicate ?? "version"}); re-read and try again`, { key: f?.key, predicate: f?.predicate });
      }
      throw error;
    }
  }

  /** Merges `patch` into the version that was read, checked against the flow. Returns false if the version moved. */
  async update(collection: Collection, id: string, version: number, patch: Record<string, unknown>): Promise<boolean> {
    const current = await this.get<Record<string, unknown>>(collection, id);
    if (!current || current.__version !== version) return false;
    this.check(collection, JSON.parse(JSON.stringify({ ...strip(current), ...patch })) as Record<string, unknown>);
    const result = await this.db.collection(collection).updateIfVersion(id, version, patch);
    return Boolean(result.updated);
  }

  /** Deletes a record (project deletion only; the flow's records are otherwise append-only or version-fenced). */
  async remove(collection: Collection, id: string): Promise<void> {
    await this.db.collection(collection).delete(id);
  }

  /** Stores an artifact body under its own sha256 (write to a temporary name, then rename: never a torn file). */
  putArtifactBody(text: string): { fileDigest: string; path: string; bytes: number } {
    const hex = sha256(text);
    const path = join("artifacts", hex.slice(0, 2), `${hex}.json`);
    const absolute = join(this.home, path);
    mkdirSync(join(this.home, "artifacts", hex.slice(0, 2)), { recursive: true });
    const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: "wx" });
    renameSync(temporary, absolute);
    return { fileDigest: `sha256:${hex}`, path, bytes: Buffer.byteLength(text) };
  }

  /** Reads an artifact body through its record, refusing a file that is not the one recorded. */
  readArtifact<T = unknown>(record: Pick<ArtifactRecord, "path" | "fileDigest" | "id">): T {
    let text: string;
    try {
      text = readFileSync(join(this.home, record.path), "utf8");
    } catch {
      throw new WorkspaceError("ARTIFACT_MISSING", `the body of artifact ${record.id} is missing from the workspace`);
    }
    if (`sha256:${sha256(text)}` !== record.fileDigest) throw new WorkspaceError("ARTIFACT_CORRUPT", `the body of artifact ${record.id} does not match its recorded digest`);
    return JSON.parse(text) as T;
  }

  /** The absolute path of a file under the workspace home. */
  resolve(path: string): string {
    return join(this.home, path);
  }
}
