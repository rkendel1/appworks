import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { createWorkspaceServer, renderPage, verifyVendoredStackUi, WorkspaceError } from "../src/index.js";
import { notesRepository, openWorkspace, OPERATOR, VIEWER } from "./helpers.js";

const raw = (origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const u = new URL(path, origin);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(options.body);
  });

describe("the web workspace", () => {
  it("serves the vendored stack-ui release unmodified, inlined, under a hash-pinned content security policy", async () => {
    const { version, files } = verifyVendoredStackUi();
    expect(version).toBe("0.5.0");
    expect(Object.keys(files).sort()).toEqual(["core.css", "stack-ui-core-stateless.js", "stack-ui-core.js", "tokens.css"]);
    const ws = await openWorkspace({});
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    try {
      const page = await raw(origin, "/");
      expect(page.status).toBe(200);
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toMatch(/default-src 'none'/);
      expect(csp).toMatch(/connect-src 'self'/);
      const stateless = readFileSync(new URL("../vendor/stack-ui/stack-ui-core-stateless.js", import.meta.url), "utf8");
      expect(page.body).toContain(stateless);
      expect(csp).toContain(`'sha256-${createHash("sha256").update(stateless).digest("base64")}'`);
      // nothing else is loaded: no external script, stylesheet or font
      expect(page.body).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
      expect(renderPage({ page: "project", project: "prj_x", principal: "p" })).toContain('"project":"prj_x"');
    } finally {
      await server.close();
      await ws.close();
    }
  });

  it("answers only its own host names, and refuses mutations without its request header or from another origin", async () => {
    const { mirror } = notesRepository();
    const ws = await openWorkspace({});
    const server = createWorkspaceServer({ workspace: ws, principal: OPERATOR, port: 0 });
    const origin = await server.listen();
    const port = new URL(origin).port;
    const body = JSON.stringify({ provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" });
    try {
      expect((await raw(origin, "/api/projects", { headers: { host: `evil.example:${port}` } })).status).toBe(421);
      expect((await raw(origin, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(403);
      expect((await raw(origin, "/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1", origin: "http://evil.example" }, body })).status).toBe(403);
      expect((await raw(origin, "/api/projects", { method: "POST", headers: { "content-type": "text/plain", "x-appworks-request": "1" }, body })).status).toBe(400);
      const created = await raw(origin, "/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1", origin }, body });
      expect(created.status).toBe(201);
      const id = JSON.parse(created.body).id;
      const started = await raw(origin, `/api/projects/${id}/actions/acquire`, { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1" }, body: "{}" });
      expect(started.status).toBe(202);
      expect(JSON.parse(started.body).run).toMatch(/\.acquire\.1$/);
      const wrong = await raw(origin, `/api/projects/${id}/actions/assess`, { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1" }, body: "{}" });
      expect(wrong.status === 409 || wrong.status === 422).toBe(true);
      expect(JSON.parse(wrong.body).error.code).toMatch(/STEP_IN_PROGRESS|INVALID_TRANSITION/);
      expect((await raw(origin, `/api/projects/nope`)).status).toBe(404);
    } finally {
      await server.close();
      await ws.close();
    }
  });

  it("acts with the authority of the principal it serves, and listens on loopback only", async () => {
    const ws = await openWorkspace({});
    expect(() => createWorkspaceServer({ workspace: ws, principal: OPERATOR, host: "0.0.0.0" })).toThrow(WorkspaceError);
    const server = createWorkspaceServer({ workspace: ws, principal: VIEWER, port: 0 });
    const origin = await server.listen();
    try {
      const created = await raw(origin, "/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-appworks-request": "1" }, body: JSON.stringify({ provider: "git", owner: "a", name: "b", ref: "main", fetchFrom: "/x" }) });
      expect(created.status).toBe(403);
      expect(JSON.parse(created.body).error.code).toBe("UNAUTHORIZED");
    } finally {
      await server.close();
      await ws.close();
    }
  });
});
