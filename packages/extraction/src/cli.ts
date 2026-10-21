#!/usr/bin/env node
/**
 * The `appworks` command.
 *
 *   appworks assess <repo> --output <file> [--scanner 1|2] [--force] [--strict]   (@appport/assessment)
 *   appworks verify <file> [--repo <repo>]                               (@appport/assessment)
 *   appworks extract <assessment> --candidate <id> --repo <repo> --output <file>
 *                    [--plan <plan.json>] [--verification <results.json>] [--previous <extraction.json>] [--force]
 *   appworks verify-extraction <file> [--assessment <file>] [--repo <repo>] [--plan-dir <dir>]
 *   appworks --version
 *
 * Exit status (spec/extraction-1.md §8):
 *   0  written (extract) or valid (verify-extraction)
 *   1  fatal: an input cannot be read, the output cannot be written; verify-extraction: invalid
 *   2  invalid arguments, or an output that would overwrite a file without --force or lies inside the repository
 *   4  extract: refused, with reason codes (invalid or stale assessment, revision mismatch, ineligible candidate,
 *      invalid contract or mapping, results for another subject, an incompatible revision)
 */
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryError, assessmentCli, isInside, repositoryRoot, type ApplicationAssessment, type CliIO } from "@appport/assessment";
import { fulfillmentClaims } from "@appport/protocol";
import { TOOL_NAME, TOOL_VERSION, type CapabilityExtraction } from "./artifact.js";
import { ExtractionRefused, createExtraction, type VerificationResults } from "./extract.js";
import { InputError, observeCheckout, readJson, readPlan, verifyExtractionAt } from "./files.js";

const USAGE = `usage:
  appworks assess <repo> --output <file> [--scanner 1|2] [--force] [--strict]
  appworks verify <file> [--repo <repo>]
  appworks extract <assessment> --candidate <id> --repo <repo> --output <file> [--plan <file>] [--verification <file>] [--previous <file>] [--force]
  appworks verify-extraction <file> [--assessment <file>] [--repo <repo>] [--plan-dir <dir>]
  appworks --version`;

class UsageError extends Error {}

function parse(args: string[], flags: string[], valued: string[]) {
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (flags.includes(name)) options[name] = true;
      else if (valued.includes(name)) {
        const v = args[++k];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
        options[name] = v;
      } else throw new UsageError(`unknown option ${a}`);
    } else positional.push(a);
  }
  return { positional, options };
}

/** The report: every section separately, and never an overall success while a required behavior has not passed. */
export function report(x: CapabilityExtraction): string[] {
  const s = x.verification.summary;
  const records = x.verification.records;
  const status = (behavior: string) => records.find((r) => r.behavior === behavior)?.status ?? "not recorded";
  const group = (label: string, pick: (r: (typeof records)[number]) => boolean) => {
    const ids = records.filter(pick).map((r) => r.behavior);
    return ids.length ? [`    ${label}: ${ids.join(", ")}`] : [];
  };
  const claim = x.fulfillment ? fulfillmentClaims({ attributes: x.fulfillment.attributes }, x.fulfillment.provider.capability, x.fulfillment.provider.version)[0] : undefined;
  const notPassed = records.length - s.passed;
  return [
    `${x.stage === "implemented" ? "Extraction" : "Proposed extraction"} ${x.identity.name} revision ${x.identity.revision} (${x.format})${x.identity.previous ? `, replacing ${x.identity.previous}` : ""}`,
    `  source: ${x.source.name} ${x.source.operation.fullMethod} at ${x.source.revision}`,
    `  assessment: ${x.assessment.digest} (candidate ${x.assessment.candidate.id})`,
    `  contract: ${x.contract.capability.contract} ${x.contract.capability.name}@${x.contract.capability.version} ${x.contract.capabilityDigest}`,
    `  adapter: ${x.adapter ? `${x.adapter.name} ${x.adapter.version} ${x.adapter.digest}` : "none"}`,
    `  fulfillment declaration: ${x.fulfillment && claim ? `${x.fulfillment.provider.application} ${x.fulfillment.provider.capability}@${x.fulfillment.provider.version} claims ${claim.contract} ${claim.capability}@${claim.version} ${claim.digest} (declaration ${x.fulfillment.digest})` : "none"}`,
    ...(x.runtime ? [`  runtime: ${Object.entries({ ...x.runtime.packages, ...x.runtime.application }).map(([k, v]) => `${k}=${v}`).join(", ")}; node ${x.runtime.node}`] : []),
    `  declaration published and discovered: ${status("integration.fulfillment-claim")}; fails closed: ${status("integration.declaration-fails-closed")}`,
    `  authorization: ${records.filter((r) => r.category === "authorization").map((r) => `${r.behavior.replace(/^authorization\./, "")} ${r.status}`).join(", ")}`,
    `  checkout unchanged and at the source revision: ${status("integration.source-revision")}`,
    `  behaviors: ${s.passed} passed, ${s.failed} failed, ${s.inconclusive} inconclusive, ${s["not-run"]} not run, of ${records.length} required`,
    ...group("passed against the real application", (r) => r.status === "passed" && r.against === "real-application"),
    ...group("passed against a stub application only", (r) => r.status === "passed" && r.against === "stub-application"),
    ...group("passed by static or protocol checks", (r) => r.status === "passed" && (r.against === "none" || r.against === undefined)),
    ...group("FAILED", (r) => r.status === "failed"),
    ...group("INCONCLUSIVE", (r) => r.status === "inconclusive"),
    ...group("NOT RUN (unsupported or not yet verified)", (r) => r.status === "not-run"),
    ...x.findings.map((f) => `  ${f.code}: ${f.message}`),
    notPassed
      ? `  overall: NOT VERIFIED: ${notPassed} of ${records.length} required behaviors did not pass`
      : `  overall: every required behavior passed for exactly this source revision, contract, adapter, declaration and runtime (not equivalence beyond them)`,
    `  ${x.questions.length} open questions; this artifact grants nothing, deploys nothing and modified nothing`,
    `  digest: ${x.digest}`
  ];
}

function summary(x: CapabilityExtraction, output: string): string {
  return [...report(x), `  written: ${output}`].join("\n");
}

function outputPath(path: string, root: string, force: boolean): string {
  const output = resolve(path);
  let parent: string;
  try {
    parent = realpathSync(dirname(output));
  } catch {
    throw new UsageError(`the output directory ${dirname(output)} does not exist`);
  }
  if (isInside(root, resolve(parent, basename(output)))) throw new UsageError("the output must not be written inside the application repository");
  try {
    if (!lstatSync(output).isFile()) throw new UsageError(`${output} exists and is not a regular file`);
    if (!force) throw new UsageError(`${output} exists; pass --force to replace it`);
  } catch (error) {
    if (error instanceof UsageError) throw error;
  }
  return output;
}

/** Runs the CLI. Returns the exit status; never calls `process.exit`. */
export function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }): number {
  const [command, ...rest] = argv;
  try {
    if (command === "--version") {
      io.out(`${TOOL_NAME} ${TOOL_VERSION}`);
      return 0;
    }
    if (command === "assess" || command === "verify") return assessmentCli(argv, io);
    if (command === "extract") {
      const { positional, options } = parse(rest, ["force"], ["candidate", "repo", "output", "plan", "verification", "previous"]);
      if (positional.length !== 1) throw new UsageError("extract takes exactly one assessment file");
      for (const required of ["candidate", "repo", "output"]) if (typeof options[required] !== "string") throw new UsageError(`extract requires --${required}`);
      let root: string;
      try {
        root = repositoryRoot(options.repo as string);
      } catch (error) {
        throw error instanceof RepositoryError ? new UsageError(error.message) : error;
      }
      const output = outputPath(options.output as string, root, options.force === true);
      const assessment = readJson(positional[0]!, "assessment") as ApplicationAssessment;
      const extraction = createExtraction({
        assessment,
        candidate: options.candidate as string,
        checkout: observeCheckout(assessment, root),
        ...(typeof options.plan === "string" ? { plan: readPlan(options.plan, root) } : {}),
        ...(typeof options.verification === "string" ? { verification: readJson(options.verification, "verification results") as VerificationResults } : {}),
        ...(typeof options.previous === "string" ? { previous: readJson(options.previous, "previous extraction") as CapabilityExtraction } : {})
      });
      writeFileSync(output, `${JSON.stringify(extraction, null, 2)}\n`, { flag: options.force ? "w" : "wx" });
      io.out(summary(extraction, output));
      return 0;
    }
    if (command === "verify-extraction") {
      const { positional, options } = parse(rest, [], ["assessment", "repo", "plan-dir"]);
      if (positional.length !== 1) throw new UsageError("verify-extraction takes exactly one extraction file");
      const extraction = readJson(positional[0]!, "extraction");
      const result = verifyExtractionAt(extraction, {
        ...(typeof options.assessment === "string" ? { assessment: readJson(options.assessment, "assessment") as ApplicationAssessment } : {}),
        ...(typeof options.repo === "string" ? { repository: options.repo } : {}),
        ...(typeof options["plan-dir"] === "string" ? { planDirectory: options["plan-dir"] } : {})
      });
      if (result.ok) {
        const x = extraction as CapabilityExtraction;
        io.out(`valid ${x.format} ${x.identity.name} revision ${x.identity.revision} ${x.digest}`);
        if (x.format !== "appport.capability-extraction/1") for (const line of report(x).slice(1)) io.out(line);
        return 0;
      }
      for (const f of result.findings) io.err(`${f.code} ${f.path}: ${f.message}`);
      return 1;
    }
    throw new UsageError(command ? `unknown command ${command}` : "no command");
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof ExtractionRefused) {
      io.err("extraction refused:");
      for (const r of error.reasons) io.err(`  ${r.code}: ${r.message}`);
      return 4;
    }
    if (error instanceof InputError || error instanceof RepositoryError) {
      io.err(error.message);
      return 1;
    }
    io.err(`extraction failed: ${(error as Error).message}`);
    return 1;
  }
}

const invoked = process.argv[1]
  ? (() => {
      try {
        return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
      } catch {
        return false;
      }
    })()
  : false;
if (invoked) process.exitCode = main(process.argv.slice(2));
