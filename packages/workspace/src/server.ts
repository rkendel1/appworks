/**
 * The web workspace: server-delivered pages rendered with the shared Stack design system (vendored stack-ui), and a JSON
 * API over the same `perform` table and `projectView` read the CLI uses.
 *
 * It listens on loopback only and acts as the local operator who started it, so it has no network identity boundary
 * and therefore no API keys (see docs/workspace.md, Services). Requests are accepted only for its own host name; a
 * mutation must come from its own origin, as JSON, with the `x-appworks-request` header a cross-site form cannot set.
 * Long steps run in the background under their run lease; the page reads progress back from FeltDB.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { perform } from "./actions.js";
import { statusOf, WorkspaceError, type Principal, type Project } from "./model.js";
import { pageSecurityHeaders, renderPage } from "./ui.js";
import { projectView } from "./view.js";
import type { Workspace } from "./workflow.js";

export interface ServerOptions {
  workspace: Workspace;
  principal: Principal;
  host?: string;
  port?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY = 64 * 1024;

export function projectSummary(p: Project) {
  return { id: p.id, repository: `${p.repository.owner}/${p.repository.name}`, provider: p.repository.provider, ref: p.ref, sha: p.revision?.sha ?? null, stage: p.stage, condition: p.condition.state, activeRun: p.activeRun ?? null, createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function failure(res: ServerResponse, error: unknown) {
  const e = error instanceof WorkspaceError ? error : new WorkspaceError("INTERNAL_ERROR", "the workspace could not complete the request");
  send(res, statusOf(e.code) === 422 && e.code === "INTERNAL_ERROR" ? 500 : statusOf(e.code), { error: { code: e.code, message: e.message, ...(e.details.reasons ? { reasons: e.details.reasons } : {}) } });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new WorkspaceError("INVALID_INPUT", "requests send JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new WorkspaceError("INVALID_INPUT", "the request is too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new WorkspaceError("INVALID_INPUT", "the request body is not a JSON object");
  }
}

export function createWorkspaceServer(options: ServerOptions): { server: Server; listen(): Promise<string>; close(): Promise<void> } {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new WorkspaceError("INVALID_INPUT", `the workspace listens on loopback only (${[...LOOPBACK].join(", ")}); it has no network authentication boundary`);
  const ws = options.workspace;
  const principal = options.principal;
  let origin = "";
  const allowedHosts = new Set<string>();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://placeholder");
      // DNS rebinding: only our own host names.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 421, { error: { code: "MISDIRECTED", message: "unknown host" } });
      const path = url.pathname;
      if (req.method === "GET" && path === "/favicon.ico") {
        res.writeHead(204, { "cache-control": "max-age=86400" });
        return res.end();
      }
      if (req.method === "GET" && (path === "/" || /^\/projects\/[A-Za-z0-9_]+$/.test(path))) {
        const page = path === "/" ? { page: "projects" as const } : { page: "project" as const, project: path.split("/")[2]! };
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...pageSecurityHeaders() });
        return res.end(renderPage({ ...page, principal: principal.id }));
      }
      if (!path.startsWith("/api/")) return send(res, 404, { error: { code: "NOT_FOUND", message: "no such page" } });
      try {
        if (req.method !== "GET") {
          // Cross-site requests cannot set this header without a preflight this server never grants.
          if (req.headers["x-appworks-request"] !== "1") throw new WorkspaceError("UNAUTHORIZED", "mutations need the x-appworks-request header");
          if (req.headers.origin && !(req.headers.origin.startsWith("http://") && allowedHosts.has(req.headers.origin.slice(7)))) throw new WorkspaceError("UNAUTHORIZED", "cross-origin request refused");
        }
        if (req.method === "GET" && path === "/api/projects") return send(res, 200, (await ws.listProjects(principal)).map(projectSummary));
        if (req.method === "POST" && path === "/api/projects") {
          const body = await readJson(req);
          const s = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : undefined);
          const created = await ws.createProject(principal, { provider: (s("provider") ?? "github") as "github" | "git", owner: s("owner") ?? "", name: s("name") ?? "", ref: s("ref") ?? "", ...(s("url") ? { url: s("url")! } : {}), ...(s("fetchFrom") ? { fetchFrom: s("fetchFrom")! } : {}), ...(s("readCredential") ? { readCredential: s("readCredential")! } : {}), ...(s("writeCredential") ? { writeCredential: s("writeCredential")! } : {}) });
          return send(res, 201, projectSummary(created));
        }
        let m = /^\/api\/projects\/([A-Za-z0-9_]+)$/.exec(path);
        if (req.method === "GET" && m) return send(res, 200, await projectView(ws, principal, m[1]!));
        m = /^\/api\/projects\/([A-Za-z0-9_]+)\/artifacts\/([A-Za-z0-9_:.-]+)$/.exec(path);
        if (req.method === "GET" && m) {
          const found = await ws.artifact(principal, decodeURIComponent(m[2]!));
          if (!found || found.record.projectId !== m[1]) throw new WorkspaceError("NOT_FOUND", "no such artifact");
          return send(res, 200, { record: found.record, body: found.body });
        }
        m = /^\/api\/projects\/([A-Za-z0-9_]+)\/actions\/([a-z-]+)$/.exec(path);
        if (req.method === "POST" && m) {
          const performed = await perform(ws, principal, m[1]!, m[2]!, await readJson(req));
          if (performed.kind === "started") {
            performed.done.catch(() => {}); // recorded on the project; the page reads it back
            return send(res, 202, { run: performed.run });
          }
          return send(res, 200, performed.result);
        }
        throw new WorkspaceError("NOT_FOUND", "no such route");
      } catch (error) {
        return failure(res, error);
      }
    })().catch((error) => failure(res, error));
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 4300, host, () => {
          const port = (server.address() as AddressInfo).port;
          const name = host === "::1" ? "[::1]" : host;
          origin = `http://${name}:${port}`;
          for (const h of [`${name}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]) allowedHosts.add(h);
          resolve(origin);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
