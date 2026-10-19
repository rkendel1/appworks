/**
 * The repository walker: which files an assessment reads, and which it does not and why.
 *
 * Safety properties (docs in spec/assessment-1.md §4):
 * - Only paths inside the supplied root are read. Symbolic links are never followed, whether they point inside or outside
 *   the root; each is reported as skipped.
 * - Nothing is written, executed or fetched. Git identity is read from `.git` files, never by running `git`.
 * - Every file is either scanned or reported as skipped with a reason; nothing is dropped silently.
 * - Paths in results are repository-relative with `/` separators, and all lists are sorted, so results never depend on
 *   filesystem traversal order.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Directories never descended into: dependencies, vendored code, build output and VCS metadata. */
export const DEFAULT_EXCLUDED_DIRECTORIES = [".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "out", "target", ".next", ".turbo", "coverage", "__pycache__", ".venv"] as const;
/** Files larger than this are not read. */
export const DEFAULT_MAX_FILE_BYTES = 1_048_576;

export type SkipReason = "symlink" | "excluded-directory" | "ignored" | "generated" | "too-large" | "unreadable" | "binary" | "special-file";

export interface RepositoryFile {
  /** Repository-relative, `/`-separated. */
  path: string;
  size: number;
}

export interface Walk {
  files: RepositoryFile[];
  /** Directories and files not read, with the reason. Excluded directories are listed once, not file by file. */
  skipped: Array<{ path: string; reason: SkipReason }>;
  /** Root `.gitignore` patterns this walker could not interpret; they were not applied. */
  unsupportedIgnorePatterns: string[];
}

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Resolves and checks the repository root. */
export function repositoryRoot(path: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(path));
  } catch {
    throw new RepositoryError(`repository path does not exist: ${path}`);
  }
  if (!lstatSync(root).isDirectory()) throw new RepositoryError(`repository path is not a directory: ${path}`);
  return root;
}

/** True when `absolute` lies inside `root` (or is it). */
export function isInside(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/**
 * A minimal `.gitignore` interpreter for the root file: blank lines and comments, `dir/` patterns, `*`/`?` globs, and
 * leading-`/` anchoring. Negation (`!`), `**` and character classes are not interpreted; such patterns are returned as
 * unsupported and not applied, so a file they would exclude is scanned and the limitation is reported.
 */
export function parseIgnore(text: string): { matchers: Array<(path: string, isDirectory: boolean) => boolean>; unsupported: string[] } {
  const matchers: Array<(path: string, isDirectory: boolean) => boolean> = [];
  const unsupported: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!") || line.includes("**") || /\[.*\]/.test(line) || line.includes("\\")) {
      unsupported.push(line);
      continue;
    }
    const directoryOnly = line.endsWith("/");
    let pattern = directoryOnly ? line.slice(0, -1) : line;
    const anchored = pattern.startsWith("/") || pattern.includes("/");
    pattern = pattern.replace(/^\//, "");
    const source = pattern.split("").map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : c.replace(/[.+^${}()|]/g, "\\$&"))).join("");
    const regex = new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`);
    matchers.push((path, isDirectory) => (!directoryOnly || isDirectory) && regex.test(path));
  }
  return { matchers, unsupported };
}

/** Whether a file's leading bytes contain a NUL, the conventional binary test. */
function isBinary(absolute: string): boolean {
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(8000);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).includes(0);
  } finally {
    closeSync(fd);
  }
}

/** Walks the repository deterministically. */
export function walkRepository(root: string, options: { maxFileBytes?: number; excludedDirectories?: readonly string[] } = {}): Walk {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const excluded = new Set(options.excludedDirectories ?? DEFAULT_EXCLUDED_DIRECTORIES);
  const files: RepositoryFile[] = [];
  const skipped: Walk["skipped"] = [];
  let ignore: ReturnType<typeof parseIgnore> = { matchers: [], unsupported: [] };
  try {
    const gitignore = join(root, ".gitignore");
    if (lstatSync(gitignore).isFile()) ignore = parseIgnore(readFileSync(gitignore, "utf8"));
  } catch {
    /* no root .gitignore */
  }
  const ignored = (path: string, isDirectory: boolean) => ignore.matchers.some((m) => m(path, isDirectory));

  const visit = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      skipped.push({ path: toPosix(relative(root, directory)) || ".", reason: "unreadable" });
      return;
    }
    for (const name of entries) {
      const absolute = join(directory, name);
      const path = toPosix(relative(root, absolute));
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        skipped.push({ path, reason: "unreadable" });
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped.push({ path, reason: "symlink" });
        continue;
      }
      if (stat.isDirectory()) {
        if (excluded.has(name)) skipped.push({ path, reason: "excluded-directory" });
        else if (ignored(path, true)) skipped.push({ path, reason: "ignored" });
        else visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        skipped.push({ path, reason: "special-file" });
        continue;
      }
      if (ignored(path, false)) {
        skipped.push({ path, reason: "ignored" });
        continue;
      }
      if (stat.size > maxBytes) {
        skipped.push({ path, reason: "too-large" });
        continue;
      }
      try {
        if (isBinary(absolute)) {
          skipped.push({ path, reason: "binary" });
          continue;
        }
      } catch {
        skipped.push({ path, reason: "unreadable" });
        continue;
      }
      files.push({ path, size: stat.size });
    }
  };
  visit(root);
  const order = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.sort(order), skipped: skipped.sort(order), unsupportedIgnorePatterns: [...ignore.unsupported].sort() };
}

/**
 * Reads a repository file as UTF-8, refusing anything that is not a regular file inside the root at the moment it is
 * opened (the descriptor is checked, so a file replaced by a link after the walk is not followed).
 */
export function readRepositoryFile(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!isInside(root, absolute)) throw new RepositoryError(`path escapes the repository root: ${path}`);
  if (lstatSync(absolute).isSymbolicLink()) throw new RepositoryError(`refusing to follow a symbolic link: ${path}`);
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new RepositoryError(`not a regular file: ${path}`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** The repository's identity from `.git` files, if present. Never runs git; credentials in remote URLs are removed. */
export function gitIdentity(root: string): { repository?: string; revision?: string; ref?: string } {
  const git = join(root, ".git");
  try {
    if (!lstatSync(git).isDirectory()) return {};
  } catch {
    return {};
  }
  const read = (p: string) => {
    try {
      const absolute = join(git, p);
      if (lstatSync(absolute).isSymbolicLink()) return undefined;
      return readFileSync(absolute, "utf8");
    } catch {
      return undefined;
    }
  };
  const out: { repository?: string; revision?: string; ref?: string } = {};
  const head = read("HEAD")?.trim();
  if (head?.startsWith("ref: ")) {
    out.ref = head.slice(5);
    const direct = read(out.ref)?.trim();
    const packed = read("packed-refs")?.split("\n").find((l) => l.endsWith(` ${out.ref}`))?.split(" ")[0];
    const revision = direct ?? packed;
    if (revision && /^[0-9a-f]{40,64}$/.test(revision)) out.revision = revision;
  } else if (head && /^[0-9a-f]{40,64}$/.test(head)) {
    out.revision = head;
  }
  const config = read("config");
  const origin = config?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
  if (origin) out.repository = origin.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  return out;
}

