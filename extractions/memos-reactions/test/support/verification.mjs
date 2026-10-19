// Records which behaviors (BEHAVIORS of @appport/extraction) a test run established, for exactly one subject: the
// source revision tested, the contract's capability digest and the adapter's digest, computed here from what was
// actually loaded. The results are written only if APPWORKS_VERIFICATION_OUT names a file.

import { test } from "node:test";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityDigest } from "@appport/protocol";
import { gitIdentity } from "@appport/assessment";
import { BEHAVIORS, VERIFICATION_RESULTS_FORMAT, adapterIdentity, readPlan } from "@appport/extraction";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REFERENCE = "extractions/memos-reactions/test/behavior.test.mjs";
export const PINNED_REVISION = "c0eeec7a260ee58e2ed1514a61bfff1fa013f42e";
/** What Memos' internal/version derives for PINNED_REVISION (committed 2026-10-14T20:43:05Z): YY.MM.D-dev.<sha7>. */
export const MEMOS_BUILD = { Version: "26.10.14-dev.c0eeec7", Commit: PINNED_REVISION };
export const contract = JSON.parse(readFileSync(join(HERE, "contract.json"), "utf8"));

export function subjectOf(repo) {
  const plan = readPlan(join(HERE, "extraction-plan.json"), repo);
  const { adapter } = adapterIdentity(plan.plan.adapter, plan.adapterFiles, plan.boundaryFiles);
  return { sourceRevision: gitIdentity(repo).revision ?? "", capabilityDigest: capabilityDigest(contract, "memos.reactions.list", 1), adapterDigest: adapter.digest };
}

/** A content hash of a tree: every path, mode, mtime, link target and file content, .git included. */
export function treeHash(root) {
  const hash = createHash("sha256");
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(`${path.slice(root.length)}\0${stat.mode}\0${stat.mtimeMs}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest("hex");
}

const outcomes = new Map();
const note = (id, kind, name, ok, limitations = []) => {
  if (!(id in BEHAVIORS)) throw new Error(`unknown behavior ${id}`);
  const o = outcomes.get(id) ?? { kinds: new Set(), results: [], failed: false, limitations: new Set() };
  o.kinds.add(kind);
  o.results.push(`${ok ? "passed" : "failed"}: ${name}`);
  if (!ok) o.failed = true;
  for (const l of limitations) o.limitations.add(l);
  outcomes.set(id, o);
};

/** A test that establishes `ids` when it passes and refutes them when it fails. */
export function behavior(ids, kind, name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      for (const id of ids) note(id, kind, name, false);
      throw error;
    }
    for (const id of ids) note(id, kind, name, true);
  });
}

/** A behavior whose status is what a passing test established about it (e.g. a known gap: failed). */
const declared = new Map();
export function declare(id, status, kind, name, limitations) {
  declared.set(id, { status, procedure: { kind, reference: REFERENCE }, results: [`${status}: ${name}`], limitations });
}

const PRECEDENCE = ["integration-test", "protocol-check", "static-check", "unit-test"];
export function writeResults(subject, run) {
  const behaviors = {};
  for (const [id, o] of outcomes) {
    const kind = PRECEDENCE.find((k) => o.kinds.has(k));
    behaviors[id] = { status: o.failed ? "failed" : "passed", procedure: { kind, reference: REFERENCE }, results: o.results, limitations: [...o.limitations] };
  }
  for (const [id, d] of declared) behaviors[id] = d;
  const results = { format: VERIFICATION_RESULTS_FORMAT, subject, run, behaviors };
  if (process.env.APPWORKS_VERIFICATION_OUT) writeFileSync(process.env.APPWORKS_VERIFICATION_OUT, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}
