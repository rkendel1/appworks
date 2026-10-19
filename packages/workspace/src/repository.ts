/**
 * Repository selection and acquisition.
 *
 * Resolving a ref to an immutable commit goes through a provider: `@appport/github` for GitHub (the stack's GitHub
 * integration; AppWorks adds no connector of its own), or plain git against a remote or local mirror (offline tests).
 * @appport/github resolves refs, reads repositories, branches and commits, and creates pull requests; it has no clone,
 * fetch or push contract, so the commit it resolved is fetched with git, by SHA, into an isolated directory that
 * belongs to the workspace. That is the one place git runs against a target.
 *
 * Isolation: a fresh repository per project and revision; hooks, fsmonitor and submodules off; no LFS smudge; no
 * interactive prompt. A read credential is passed to git in its environment as an HTTP header, never in a command
 * line, a URL, a record or a log; any message that might echo it is redacted. Nothing from the repository is executed.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { gitIdentity } from "@appport/assessment";
import { createGitHubIntegration, GitHubCapabilityError, type GitHubConnection } from "@appport/github";
import type { Authority, CredentialResolver } from "./authority.js";
import { WorkspaceError, type CredentialReference, type Principal, type RepositoryIdentity } from "./model.js";

const run = promisify(execFile);

export interface ResolvedRevision {
  sha: string;
  /** A credential-free URL git fetches the commit from. */
  fetchUrl: string;
  defaultBranch?: string;
  defaultBranchSha?: string;
  /** The branch a `HEAD` ref (the default branch) resolved through. */
  ref?: string;
  onDefaultBranch: "yes" | "no" | "unknown";
  note?: string;
}

export interface ProviderContext {
  principal: Principal;
  project: string;
  authority: Authority;
  credentials: CredentialResolver;
}

/** The repository operations the workflow uses. Read and write are separate methods with separate credentials. */
export interface RepositoryProvider {
  readonly kind: RepositoryIdentity["provider"];
  resolve(repository: RepositoryIdentity, ref: string, context: ProviderContext): Promise<ResolvedRevision>;
  /** Write: open a pull request. Only reached from the approved `pull-request` action boundary. */
  createPullRequest?(repository: RepositoryIdentity, input: { head: string; base: string; title: string; body: string }, context: ProviderContext): Promise<{ number: number; url?: string; existing: boolean }>;
}

const SHA = /^[0-9a-f]{40}$/;
/** GitHub capabilities a resolve may use, and the only ones a pull request may use: read and write never mix. */
const READ_CAPABILITIES = ["github.repository.read", "github.branch.read", "github.commit.read"];
const WRITE_CAPABILITIES = ["github.pull_request.read", "github.pull_request.create"];

/**
 * The GitHub provider, over `@appport/github`. Its own FeltDB is kept in memory and its connections are re-declared
 * for every call from the project's record: it is never a second authority for project state.
 */
export function githubProvider(options: { applicationId?: string } = {}): RepositoryProvider {
  const applicationId = options.applicationId ?? "appworks";
  const integration = async (repository: RepositoryIdentity, context: ProviderContext, use: "read" | "write") => {
    const permitted = use === "read" ? READ_CAPABILITIES : WRITE_CAPABILITIES;
    const reference = repository.credentials[use];
    const github = createGitHubIntegration({
      felt: { memory: true, namespace: `appworks-github-${use}` },
      authority: {
        // The session is the workspace principal; every capability is decided by the workspace authority, and only
        // the capabilities of this use (read or write) can be granted at all.
        async session() {
          return { authenticated: true, principal: { id: context.principal.id }, tenant: { id: "local" }, capabilities: permitted } as never;
        },
        async authorize(capability: string) {
          if (!permitted.includes(capability)) return false;
          return (await context.authority.decide(context.principal, `github:${capability}`, { project: context.project })).allowed;
        }
      },
      configuration: {
        async resolveGitHubToken(_connection: GitHubConnection, invocation: { capability: string }) {
          if (!reference) return "";
          return context.credentials.resolve(reference, { capability: invocation.capability, project: context.project });
        }
      }
    });
    const now = new Date().toISOString();
    const connectionId = `${repository.owner}/${repository.name}#${use}`;
    await github.upsertConnection({
      id: connectionId,
      tenantId: "local",
      applicationId,
      environment: "local",
      provider: "github",
      authMechanism: reference ? "personal_access_token" : "public",
      ...(reference ? { credentialReference: { secretId: reference.secretId, tenantId: "local", provider: reference.provider } as never } : {}),
      status: "configured",
      createdAt: now,
      updatedAt: now
    } as GitHubConnection);
    return { github, connectionId, invocation: { applicationId } };
  };
  return {
    kind: "github",
    async resolve(repository, ref, context) {
      const { github, connectionId, invocation } = await integration(repository, context, "read");
      const target = { connectionId, owner: repository.owner, repository: repository.name };
      try {
        const repo = await github.repositories.get(target, invocation);
        const wanted = ref === "HEAD" && repo.defaultBranch ? repo.defaultBranch : ref;
        const source = await github.repositories.source({ ...target, ref: wanted }, invocation);
        if (!SHA.test(source.commit)) throw new WorkspaceError("REF_NOT_FOUND", `GitHub resolved ${ref} to ${source.commit}, which is not a commit SHA`);
        const defaultBranch = repo.defaultBranch;
        let defaultBranchSha: string | undefined;
        let onDefaultBranch: ResolvedRevision["onDefaultBranch"] = "unknown";
        let note: string | undefined;
        if (defaultBranch) {
          defaultBranchSha = (await github.branches.get({ ...target, branch: defaultBranch }, invocation)).sha;
          if (defaultBranchSha === source.commit) onDefaultBranch = "yes";
          else {
            // @appport/github has no compare contract and lists one page: absence there establishes nothing.
            const recent = await github.commits.list({ ...target, branch: defaultBranch }, invocation);
            if (recent.some((c) => c.sha === source.commit)) onDefaultBranch = "yes";
            else note = `${source.commit.slice(0, 12)} is not among the latest ${recent.length} commits of ${defaultBranch}; that it is merged into ${defaultBranch} is not established`;
          }
        }
        return { sha: source.commit, fetchUrl: `https://github.com/${repository.owner}/${repository.name}.git`, ...(wanted !== ref ? { ref: wanted } : {}), ...(defaultBranch ? { defaultBranch } : {}), ...(defaultBranchSha ? { defaultBranchSha } : {}), onDefaultBranch, ...(note ? { note } : {}) };
      } catch (error) {
        throw providerError(error, ref);
      }
    },
    async createPullRequest(repository, input, context) {
      const { github, connectionId, invocation } = await integration(repository, context, "write");
      const target = { connectionId, owner: repository.owner, repository: repository.name };
      try {
        // Idempotent: @appport/github's pull requests carry no head branch, so the workflow gives each one a unique
        // title; an open pull request with that title is adopted, never duplicated.
        const open = await github.pullRequests.list({ ...target, state: "open" }, invocation);
        const existing = open.find((p) => p.title === input.title);
        if (existing) return { number: existing.number, ...(existing.url ? { url: existing.url } : {}), existing: true };
        const created = await github.pullRequests.create({ ...target, ...input }, invocation);
        return { number: created.number, ...(created.url ? { url: created.url } : {}), existing: false };
      } catch (error) {
        throw providerError(error, input.head);
      }
    }
  };
}

function providerError(error: unknown, ref: string): Error {
  if (error instanceof WorkspaceError) return error;
  if (error instanceof GitHubCapabilityError) {
    const code = error.code === "AUTHENTICATION_UNAVAILABLE" ? "CREDENTIAL_UNAVAILABLE" : error.code;
    return new WorkspaceError(code, `GitHub: ${error.code} for ${error.context.owner ?? ""}/${error.context.repository ?? ""}${error.code === "REF_NOT_FOUND" ? ` ref ${ref}` : ""}`);
  }
  const name = (error as Error)?.constructor?.name;
  if (name === "AuthorizationRequiredError" || name === "AuthenticationRequiredError") return new WorkspaceError("UNAUTHORIZED", (error as Error).message);
  return new WorkspaceError("PROVIDER_FAILURE", `GitHub: ${(error as Error)?.message ?? String(error)}`);
}

/** Plain git against a remote or a local mirror. Used offline and in tests; reads only. */
export function gitProvider(): RepositoryProvider {
  return {
    kind: "git",
    async resolve(repository, ref) {
      const from = repository.fetchFrom ?? repository.url;
      const head = await git(["ls-remote", "--symref", from, "HEAD"], {}).catch((e: Error) => {
        throw new WorkspaceError("REPOSITORY_NOT_FOUND", `cannot read ${redactUrl(from)}: ${firstLine(e.message)}`);
      });
      const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1];
      const defaultBranchSha = /^([0-9a-f]{40})\tHEAD$/m.exec(head)?.[1];
      let sha: string | undefined;
      if (SHA.test(ref)) sha = ref;
      else if (ref === "HEAD") sha = defaultBranchSha;
      else {
        const listed = await git(["ls-remote", from, `refs/heads/${ref}`, `refs/tags/${ref}`], {});
        sha = /^([0-9a-f]{40})\t/m.exec(listed)?.[1];
      }
      if (!sha) throw new WorkspaceError("REF_NOT_FOUND", `${ref} is not a branch, tag or commit of ${repository.owner}/${repository.name}`);
      let onDefaultBranch: ResolvedRevision["onDefaultBranch"] = defaultBranchSha === sha ? "yes" : "unknown";
      let note: string | undefined;
      if (onDefaultBranch !== "yes" && defaultBranchSha && !/^[a-z]+:\/\//.test(from)) {
        const ancestor = await git(["-C", from, "merge-base", "--is-ancestor", sha, defaultBranchSha], {}).then(
          () => true,
          () => false
        );
        onDefaultBranch = ancestor ? "yes" : "no";
        if (!ancestor) note = `${sha.slice(0, 12)} is not in the history of ${defaultBranch ?? "the default branch"} (${defaultBranchSha.slice(0, 12)})`;
      } else if (onDefaultBranch !== "yes") note = `whether ${sha.slice(0, 12)} is merged into ${defaultBranch ?? "the default branch"} is not established`;
      return { sha, fetchUrl: from, ...(ref === "HEAD" && defaultBranch ? { ref: defaultBranch } : {}), ...(defaultBranch ? { defaultBranch } : {}), ...(defaultBranchSha ? { defaultBranchSha } : {}), onDefaultBranch, ...(note ? { note } : {}) };
    }
  };
}

const firstLine = (text: string) => text.split("\n").find((l) => l.trim() && !l.startsWith("Command failed")) ?? text.split("\n")[0] ?? "";
const redactUrl = (url: string) => url.replace(/^(https?:\/\/)[^@/]+@/, "$1");

/** git with the operator's environment minus anything that could prompt, run hooks or smudge, plus `extra`. */
async function git(args: string[], extra: Record<string, string>, secret?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_LFS_SKIP_SMUDGE: "1", ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const safety = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never", "-c", "advice.detachedHead=false"];
  try {
    const { stdout } = await run("git", [...safety, ...args], { env, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const message = String((error as Error).message ?? error);
    throw new Error(secret ? message.split(secret).join("[redacted]") : message);
  }
}

/**
 * Fetches exactly `sha` into a new, empty repository at `destination` and checks it out, detached. The origin is the
 * canonical credential-free URL, which is the identity the assessment records. Returns when HEAD is `sha`.
 */
export async function acquireCheckout(input: { destination: string; fetchUrl: string; canonicalUrl: string; sha: string; credential?: { reference: CredentialReference; resolver: CredentialResolver; project: string } }): Promise<void> {
  if (!SHA.test(input.sha)) throw new WorkspaceError("INVALID_INPUT", `${input.sha} is not a commit SHA`);
  rmSync(input.destination, { recursive: true, force: true });
  mkdirSync(input.destination, { recursive: true });
  const extra: Record<string, string> = {};
  let secret: string | undefined;
  if (input.credential && /^https:\/\//.test(input.fetchUrl)) {
    secret = await input.credential.resolver.resolve(input.credential.reference, { capability: "git.fetch", project: input.credential.project });
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;
    Object.assign(extra, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header });
  }
  const local = !/^[a-z]+:\/\//.test(input.fetchUrl);
  try {
    await git(["init", "--quiet", "--initial-branch=workspace", input.destination], {});
    await git(["-C", input.destination, "remote", "add", "origin", input.canonicalUrl.replace(/\.git$/, "")], {});
    await git(["-C", input.destination, ...(local ? ["-c", "protocol.file.allow=always"] : []), "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", input.fetchUrl, `${input.sha}:refs/workspace/pinned`], extra, secret);
    await git(["-C", input.destination, "checkout", "--quiet", "--detach", "refs/workspace/pinned"], {});
  } catch (error) {
    const message = firstLine((error as Error).message);
    throw new WorkspaceError(/not our ref|couldn't find remote ref|unadvertised object|no such remote ref/i.test(message) ? "REF_NOT_FOUND" : /Authentication|401|403/.test(message) ? "CREDENTIAL_UNAVAILABLE" : "ACQUISITION_FAILED", `fetching ${input.sha.slice(0, 12)} from ${redactUrl(input.fetchUrl)} failed: ${message}`);
  }
  const head = gitIdentity(input.destination).revision;
  if (head !== input.sha) throw new WorkspaceError("REVISION_MISMATCH", `the isolated checkout is at ${head ?? "no revision"}, not ${input.sha}`);
}

/**
 * A fresh, isolated promotion worktree at `sha`, fetched from the pinned checkout (a read: the pinned checkout is never
 * written). Its origin is the canonical URL, so it is the same repository at the same revision.
 */
export async function createPromotionWorktree(input: { destination: string; pinnedCheckout: string; canonicalUrl: string; sha: string }): Promise<void> {
  await acquireCheckout({ destination: input.destination, fetchUrl: input.pinnedCheckout, canonicalUrl: input.canonicalUrl, sha: input.sha });
}

export interface WorktreeState {
  head?: string;
  /** Every changed or untracked path, `git status --porcelain` style: `??` untracked, `A ` added, ` M` modified, ... */
  entries: Array<{ status: string; path: string }>;
}

/** HEAD and every change in a worktree the workspace owns (never the pinned checkout: this refreshes the index). */
export async function worktreeState(worktree: string): Promise<WorktreeState> {
  const out = await git(["-C", worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no"], {});
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
  const head = gitIdentity(worktree).revision;
  return { ...(head ? { head } : {}), entries };
}

/** The complete diff of the worktree against `base`, every change staged first: what a reviewer reads. */
export async function worktreePatch(worktree: string, base: string): Promise<string> {
  await git(["-C", worktree, "add", "--all"], {});
  return git(["-C", worktree, "diff", "--cached", "--binary", "--full-index", "--no-color", "--no-ext-diff", base], {});
}

/** The paths a commit changed relative to its parent, and its parent. */
export async function commitInfo(worktree: string, commit: string): Promise<{ parent?: string; paths: string[] }> {
  const parent = (await git(["-C", worktree, "rev-parse", `${commit}^`], {}).catch(() => "")).trim();
  const paths = (await git(["-C", worktree, "diff", "--name-only", "-z", `${commit}^`, commit], {}).catch(() => "")).split("\0").filter(Boolean);
  return { ...(parent ? { parent } : {}), paths };
}

/**
 * Commits the staged worktree on `branch`, with a fixed identity and date, unsigned: a local commit in the workspace's
 * own worktree. Nothing is pushed.
 */
export async function commitWorktree(worktree: string, input: { branch: string; message: string; date: string }): Promise<string> {
  const identity = { GIT_AUTHOR_NAME: "AppWorks", GIT_AUTHOR_EMAIL: "appworks@localhost", GIT_COMMITTER_NAME: "AppWorks", GIT_COMMITTER_EMAIL: "appworks@localhost", GIT_AUTHOR_DATE: input.date, GIT_COMMITTER_DATE: input.date };
  await git(["-C", worktree, "checkout", "--quiet", "-B", input.branch], {});
  await git(["-C", worktree, "-c", "commit.gpgsign=false", "-c", "user.useConfigOnly=false", "commit", "--quiet", "--no-verify", "-m", input.message], identity);
  return (await git(["-C", worktree, "rev-parse", "HEAD"], {})).trim();
}
