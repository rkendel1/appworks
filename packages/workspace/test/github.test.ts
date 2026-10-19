import { afterEach, describe, expect, it } from "vitest";
import { githubProvider, localAuthority, WorkspaceError, type Authority, type RepositoryIdentity } from "../src/index.js";
import { OPERATOR } from "./helpers.js";

// @appport/github builds its own Octokit with no transport seam; Octokit uses the global fetch, which these tests
// replace with a fake GitHub API that records every request.
const SHA = "e0ce8569589b2eccafd13e262ea3e320251858f2";
const MAIN = "4fd4626bf98faa55d5eeb34b5ca3a5769b72bbdd";
const READ = "read-token-value-123";
const WRITE = "write-token-value-456";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function fakeGitHub(options: { missingRef?: boolean; openPulls?: Array<{ number: number; title: string }> } = {}) {
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname + url.search, authorization: request.headers.get("authorization") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const p = url.pathname;
    if (p === "/repos/rkendel1/memos") return json(200, { id: 1, node_id: "R", owner: { login: "rkendel1" }, name: "memos", full_name: "rkendel1/memos", private: false, archived: false, default_branch: "main", html_url: "https://github.com/rkendel1/memos" });
    if (p.startsWith("/repos/rkendel1/memos/commits/")) return options.missingRef ? json(422, { message: "No commit found for SHA" }) : json(200, { sha: SHA, commit: { message: "bridge", author: { name: "a", date: "2026-10-19T00:00:00Z" } } });
    if (p === "/repos/rkendel1/memos/branches/main") return json(200, { name: "main", commit: { sha: MAIN }, protected: false });
    if (p === "/repos/rkendel1/memos/commits") return json(200, [{ sha: MAIN, commit: { message: "main", author: { name: "a", date: "2026-10-19T00:00:00Z" } } }]);
    if (p === "/repos/rkendel1/memos/pulls" && request.method === "GET") return json(200, (options.openPulls ?? []).map((x) => ({ ...x, state: "open", html_url: `https://github.com/rkendel1/memos/pull/${x.number}` })));
    if (p === "/repos/rkendel1/memos/pulls" && request.method === "POST") return json(201, { number: 12, title: JSON.parse(await request.text()).title, state: "open", html_url: "https://github.com/rkendel1/memos/pull/12" });
    return json(404, { message: `fake GitHub has no ${request.method} ${p}` });
  }) as typeof fetch;
  return requests;
}

const repository: RepositoryIdentity = { provider: "github", owner: "rkendel1", name: "memos", url: "https://github.com/rkendel1/memos", credentials: { read: { provider: "env", secretId: "READ" }, write: { provider: "env", secretId: "WRITE" } } };
const credentials = { resolve: async (r: { secretId: string }) => (r.secretId === "READ" ? READ : WRITE) };
function recordingAuthority(base: Authority, asked: string[]): Authority {
  return { decide: async (principal, action, resource) => (asked.push(action), base.decide(principal, action, resource)) };
}

describe("the GitHub provider, over @appport/github", () => {
  it("resolves a ref to a commit with read capabilities and the read credential only, and sees the default branch", async () => {
    const requests = fakeGitHub();
    const asked: string[] = [];
    const authority = recordingAuthority(localAuthority({ [OPERATOR.id]: ["*"] }), asked);
    const resolved = await githubProvider().resolve(repository, SHA, { principal: OPERATOR, project: "prj_1", authority, credentials });
    expect(resolved).toMatchObject({ sha: SHA, fetchUrl: "https://github.com/rkendel1/memos.git", defaultBranch: "main", defaultBranchSha: MAIN, onDefaultBranch: "unknown" });
    expect(resolved.note).toMatch(/not among the latest 1 commits of main; that it is merged into main is not established/);
    expect([...new Set(asked)].sort()).toEqual(["github:github.branch.read", "github:github.commit.read", "github:github.repository.read"]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests.every((r) => r.authorization === `token ${READ}`)).toBe(true);
  });

  it("opens a pull request with the write capability and the write credential, and adopts an open one instead of duplicating it", async () => {
    let requests = fakeGitHub();
    const asked: string[] = [];
    const authority = recordingAuthority(localAuthority({ [OPERATOR.id]: ["*"] }), asked);
    const provider = githubProvider();
    const input = { head: "appport/bridge-manifest-attributes", base: "main", title: "AppWorks: bridge [appworks:prj_1]", body: "b" };
    const opened = await provider.createPullRequest!(repository, input, { principal: OPERATOR, project: "prj_1", authority, credentials });
    expect(opened).toEqual({ number: 12, url: "https://github.com/rkendel1/memos/pull/12", existing: false });
    expect([...new Set(asked)].sort()).toEqual(["github:github.pull_request.create", "github:github.pull_request.read"]);
    expect(requests.every((r) => r.authorization === `token ${WRITE}`)).toBe(true);
    requests = fakeGitHub({ openPulls: [{ number: 12, title: input.title }] });
    const adopted = await provider.createPullRequest!(repository, input, { principal: OPERATOR, project: "prj_1", authority, credentials });
    expect(adopted).toMatchObject({ number: 12, existing: true });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("refuses a capability the workspace authority does not grant, before calling GitHub", async () => {
    const requests = fakeGitHub();
    const readOnly = localAuthority({ [OPERATOR.id]: ["github:github.repository.read", "github:github.commit.read", "github:github.branch.read", "github:github.pull_request.read"] });
    const error = await githubProvider()
      .createPullRequest!(repository, { head: "x", base: "main", title: "t", body: "b" }, { principal: OPERATOR, project: "prj_1", authority: readOnly, credentials })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).code).toBe("UNAUTHORIZED");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("maps a ref GitHub cannot resolve, and keeps the token out of the error", async () => {
    fakeGitHub({ missingRef: true });
    const error = await githubProvider()
      .resolve(repository, "nope", { principal: OPERATOR, project: "prj_1", authority: localAuthority({ [OPERATOR.id]: ["*"] }), credentials })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(["REF_NOT_FOUND", "PROVIDER_FAILURE"]).toContain((error as WorkspaceError).code);
    expect(String((error as Error).message)).not.toContain(READ);
  });
});
