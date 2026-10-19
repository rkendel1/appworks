// Records which behaviors (BEHAVIORS of @appport/extraction, format /2) a test run established, and against what, for
// exactly one subject: the source revision tested, the contract's capability digest, the adapter's digest, the
// fulfillment declaration's digest and the runtime's digest, computed here from what was actually loaded. A Memos
// binary supplied from outside (MEMOS_BIN) is not the declared build, so it yields another runtime digest, and
// `appworks extract` refuses those results. The results are written only if APPWORKS_VERIFICATION_OUT names a file.

import { test } from "node:test";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityDigest } from "@appport/protocol";
import { gitIdentity } from "@appport/assessment";
import { BEHAVIORS, VERIFICATION_RESULTS_FORMAT, adapterIdentity, declarationDigest, readPlan, runtimeDigest } from "@appport/extraction";

export const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REFERENCE = "extractions/memos-reactions/test/behavior.test.mjs";
/** rkendel1/memos appport/bridge-manifest-attributes: c0eeec7 plus the bridge kit's manifest attribute pass-through. */
export const PINNED_REVISION = "e0ce8569589b2eccafd13e262ea3e320251858f2";
/** What Memos' internal/version derives for PINNED_REVISION (committed 2026-10-19T17:26:01Z): YY.MM.D-dev.<sha7>. */
export const MEMOS_BUILD = { Version: "26.10.19-dev.e0ce856", Commit: PINNED_REVISION };
export const plan = JSON.parse(readFileSync(join(HERE, "extraction-plan.json"), "utf8"));
/** Set by the suite when it built Memos itself as the plan's runtime declares. */
export const BUILT = { declared: false };
export const contract = JSON.parse(readFileSync(join(HERE, "contract.json"), "utf8"));

export function subjectOf(repo) {
  const read = readPlan(join(HERE, "extraction-plan.json"), repo);
  const { adapter } = adapterIdentity(read.plan.adapter, read.adapterFiles, read.boundaryFiles);
  const declaration = { provider: read.plan.fulfillment.provider, extensions: read.declaration.extensions, attributes: read.declaration.attributes };
  const runtime = BUILT.declared ? read.plan.runtime : { ...read.plan.runtime, application: { ...read.plan.runtime.application, build: "external MEMOS_BIN (not the declared build)" } };
  return {
    sourceRevision: gitIdentity(repo).revision ?? "",
    capabilityDigest: capabilityDigest(contract, "memos.reactions.list", 1),
    adapterDigest: adapter.digest,
    declarationDigest: declarationDigest(declaration),
    runtimeDigest: runtimeDigest({ packages: sortKeys(runtime.packages), application: sortKeys(runtime.application), node: runtime.node })
  };
}
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Whether `hostDir` holds exactly the verified host: the same bytes as runtime/host.mjs, adapter.mjs, declaration.mjs
 * and fulfillment.json, and its parent the same contract.json. Only then do its results describe this extraction's
 * subject (the subject is computed from these files here); a modified copy, such as a mutant, is never recorded.
 */
export function isVerifiedHostCopy(hostDir) {
  const same = (a, b) => {
    try {
      return readFileSync(a).equals(readFileSync(b));
    } catch {
      return false;
    }
  };
  return ["host.mjs", "adapter.mjs", "declaration.mjs", "fulfillment.json"].every((f) => same(join(hostDir, f), join(HERE, "runtime", f))) && same(join(hostDir, "..", "contract.json"), join(HERE, "contract.json"));
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
const note = (id, kind, against, name, ok, limitations = []) => {
  if (!(id in BEHAVIORS)) throw new Error(`unknown behavior ${id}`);
  const o = outcomes.get(id) ?? { kinds: new Set(), against: new Set(), results: [], failed: false, limitations: new Set() };
  o.kinds.add(kind);
  o.against.add(against);
  o.results.push(`${ok ? "passed" : "failed"} [${against}]: ${name}`);
  if (!ok) o.failed = true;
  for (const l of limitations) o.limitations.add(l);
  outcomes.set(id, o);
};

/**
 * A test that establishes `ids` when it passes and refutes them when it fails. `against` is what it exercises:
 * "real-application" (the real Memos and bridge), "stub-application" (a stub standing in for Memos) or "none".
 */
export function behavior(ids, kind, against, name, fn) {
  test(name, async (t) => {
    try {
      await fn(t);
    } catch (error) {
      for (const id of ids) note(id, kind, against, name, false);
      throw error;
    }
    for (const id of ids) note(id, kind, against, name, true);
  });
}

const PRECEDENCE = ["integration-test", "protocol-check", "static-check", "unit-test"];
/**
 * What a behavior was verified against: "real-application" if any of its tests ran against the real Memos and bridge,
 * "stub-application" if only a stub stood in for Memos, "none" for static and protocol checks only. Each result names
 * its own target, so evidence that rests on a stub stays visible inside a behavior the real application also exercised.
 */
const TARGET = (set) => (set.has("real-application") ? "real-application" : set.has("stub-application") ? "stub-application" : "none");
export function writeResults(subject, run) {
  const behaviors = {};
  for (const [id, o] of outcomes) {
    const kind = PRECEDENCE.find((k) => o.kinds.has(k));
    behaviors[id] = { status: o.failed ? "failed" : "passed", against: TARGET(o.against), procedure: { kind, reference: REFERENCE }, results: o.results, limitations: [...o.limitations] };
  }
  const results = { format: VERIFICATION_RESULTS_FORMAT, subject, run, behaviors };
  if (process.env.APPWORKS_VERIFICATION_OUT) writeFileSync(process.env.APPWORKS_VERIFICATION_OUT, `${JSON.stringify(results, null, 2)}\n`);
  return results;
}
