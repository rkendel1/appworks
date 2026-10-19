#!/usr/bin/env node
/**
 * `appworks assess <repo> --output <file> [--force] [--strict]`
 * `appworks verify <file> [--repo <repo>]`
 *
 * Exit status (spec/assessment-1.md §10):
 *   0  assess: an assessment was written (complete or partial; the summary says which). verify: the artifact is valid.
 *   1  a fatal error: the repository cannot be read, the output cannot be written, or (verify) the artifact is invalid.
 *   2  invalid arguments, or an output path that would overwrite a file without --force or lies inside the repository.
 *   3  assess --strict: an assessment was written, but it is partial.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessRepository } from "./analyze.js";
import { TOOL_NAME, TOOL_VERSION, verifyAssessment, type ApplicationAssessment } from "./artifact.js";
import { RepositoryError, isInside, repositoryRoot } from "./files.js";

const USAGE = `usage:
  appworks assess <repo> --output <file> [--force] [--strict]
  appworks verify <file> [--repo <repo>]
  appworks --version`;

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

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

function summary(a: ApplicationAssessment, output: string): string {
  const by = (cls: string) => a.candidates.filter((c) => c.readiness.class === cls).length;
  const rec = a.recommendation ? a.candidates.find((c) => c.id === a.recommendation!.candidate) : undefined;
  return [
    `${a.coverage.partial ? "Partial assessment" : "Assessment"} of ${a.target.name}${a.target.revision ? ` at ${a.target.revision.slice(0, 12)}` : ""}`,
    `  files: ${a.coverage.filesAnalyzed} analyzed of ${a.coverage.filesSeen}; ${a.coverage.skipped.length} skipped; ${a.coverage.malformed.length} malformed`,
    ...(a.coverage.partial ? [`  partial: ${a.coverage.partialReasons.join(", ")}`] : []),
    `  candidates: ${a.candidates.length} (${by("exposure-candidate")} exposure candidates, ${by("investigate")} to investigate, ${by("insufficient-evidence")} with insufficient evidence)`,
    rec
      ? `  recommended: ${rec.name}${rec.exposure.capability ? ` as proposed ${rec.exposure.capability.name}@1 (${rec.exposure.effectBasis.effect})` : ""}; ${a.recommendation!.beforeExposure.length} items to resolve before exposure`
      : "  recommended: none",
    `  evidence: ${a.evidence.length} records; ${a.findings.length} findings; ${a.questions.length} questions`,
    `  nothing was verified, executed or granted; the target was not modified`,
    `  digest: ${a.digest}`,
    `  written: ${output}`
  ].join("\n");
}

/** Runs the CLI. Returns the exit status; never calls `process.exit`. */
export function main(argv: string[], io: CliIO = { out: (t) => process.stdout.write(`${t}\n`), err: (t) => process.stderr.write(`${t}\n`) }): number {
  const [command, ...rest] = argv;
  try {
    if (command === "--version") {
      io.out(`${TOOL_NAME} ${TOOL_VERSION}`);
      return 0;
    }
    if (command === "assess") {
      const { positional, options } = parse(rest, ["force", "strict"], ["output"]);
      if (positional.length !== 1) throw new UsageError("assess takes exactly one repository path");
      if (typeof options.output !== "string") throw new UsageError("assess requires --output <file>");
      let root: string;
      try {
        root = repositoryRoot(positional[0]!);
      } catch (error) {
        throw error instanceof RepositoryError ? new UsageError(error.message) : error;
      }
      const output = resolve(options.output);
      let parent: string;
      try {
        parent = realpathSync(dirname(output));
      } catch {
        throw new UsageError(`the output directory ${dirname(output)} does not exist`);
      }
      if (isInside(root, resolve(parent, basename(output)))) throw new UsageError("the output must not be written inside the assessed repository");
      let exists = false;
      try {
        const stat = lstatSync(output);
        exists = true;
        if (!stat.isFile()) throw new UsageError(`${output} exists and is not a regular file`);
      } catch (error) {
        if (error instanceof UsageError) throw error;
      }
      if (exists && !options.force) throw new UsageError(`${output} exists; pass --force to replace it`);
      const artifact = assessRepository(root);
      writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: options.force ? "w" : "wx" });
      io.out(summary(artifact, output));
      return options.strict && artifact.coverage.partial ? 3 : 0;
    }
    if (command === "verify") {
      const { positional, options } = parse(rest, [], ["repo"]);
      if (positional.length !== 1) throw new UsageError("verify takes exactly one artifact path");
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(positional[0]!, "utf8"));
      } catch (error) {
        io.err(`cannot read ${positional[0]}: ${(error as Error).message}`);
        return 1;
      }
      const result = verifyAssessment(value, typeof options.repo === "string" ? { repository: options.repo } : {});
      if (result.ok) {
        io.out(`valid ${(value as ApplicationAssessment).format} ${(value as ApplicationAssessment).digest}`);
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
    if (error instanceof RepositoryError) {
      io.err(error.message);
      return 1;
    }
    io.err(`assessment failed: ${(error as Error).message}`);
    return 1;
  }
}

const invoked = process.argv[1] ? (() => {
  try {
    return realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})() : false;
if (invoked) process.exitCode = main(process.argv.slice(2));
