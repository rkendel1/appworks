import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nameFor, routeProposals, verifyProposals, type DiscoveryRecord } from "../src/index.js";
import { linkPackages, notesRepository, openWorkspace, OPERATOR, step, tempDir } from "./helpers.js";

const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

describe("the capabilities a repository could publish", () => {
  it("finds routes in Go, Express, Flask and FastAPI, skips tests, and does not propose a catch-all", () => {
    const root = write(tempDir("surface-"), {
      "cmd/main.go": 'http.HandleFunc("GET /v1/models/{id}", h)\nhttp.HandleFunc("/", proxy)\nr.POST("/v1/chat/completions", h)\n',
      "cmd/main_test.go": 'http.HandleFunc("/only-in-tests", h)\n',
      "web/server.js": "app.get('/users/:id', h);\nrouter.delete('/users/:id', h);\n",
      "api/app.py": '@app.route("/health")\ndef h(): pass\n@router.post("/items")\ndef i(): pass\n'
    });
    const { proposals, catchAll } = routeProposals(root);
    expect(proposals.map((p) => `${p.method} ${p.path}`).sort()).toEqual(["DELETE /users/{id}", "GET /health", "GET /users/{id}", "GET /v1/models/{id}", "POST /items", "POST /v1/chat/completions"]);
    expect(catchAll).toHaveLength(1);
    expect(nameFor("GET", "/v1/models/{id}")).toBe("models.getbyid");
    expect(proposals.every((p) => p.source === "route-scan" && p.evidence[0]!.line >= 1)).toBe(true);
  });

  it("accepts a proposal only with a citation that matches the pinned file, and refuses the rest whole", () => {
    const root = write(tempDir("surface-"), { "README.md": "# Router\n\nPOST /v1/chat/completions forwards a chat request.\n" });
    const good = { name: "chat.completions.create", method: "POST", path: "/v1/chat/completions", description: "Send a chat request.", evidence: [{ path: "README.md", line: 3, quote: "POST /v1/chat/completions" }] };
    expect(verifyProposals(root, [good])).toEqual([{ ...good, source: "agent" }]);
    const refused = (change: Record<string, unknown>) => expect(() => verifyProposals(root, [{ ...good, ...change }])).toThrow(/capability 1/);
    refused({ evidence: [{ path: "README.md", line: 3, quote: "DELETE /everything" }] }); // the line does not say that
    refused({ evidence: [{ path: "README.md", line: 99, quote: "x" }] });
    refused({ evidence: [{ path: "../outside.md", line: 1, quote: "x" }] });
    refused({ evidence: [{ path: "missing.md", line: 1, quote: "x" }] });
    refused({ path: "http://evil.example/steal" });
    refused({ path: "/a/../b" });
    refused({ name: "Not A Name" });
    refused({ method: "TRACE" });
    expect(() => verifyProposals(root, [good, good])).toThrow(/twice/);
  });
});

describe("installing AppPort publishes the capabilities found, proposed and approved before anything is written", () => {
  it("scans routes and takes an agent's cited proposals into the approved proposal, and discovery then lists them", async () => {
    const { mirror } = notesRepository({
      "server/main.go": 'http.HandleFunc("GET /notes/{id}", getNote)\nhttp.HandleFunc("/", proxy)\n',
      "README.md": "# Notes\n\nPOST /v1/notes/search finds notes.\n"
    });
    const ws = await openWorkspace({ installPackages: async (directory) => linkPackages(directory) });
    try {
      const id = (await ws.createProject(OPERATOR, { provider: "git", owner: "example", name: "notes", url: "https://github.com/example/notes", fetchFrom: mirror, ref: "main" })).id;
      for (const s of ["acquire", "pin", "inspect"]) await step(ws, OPERATOR, id, s);
      const cited = { name: "notes.search", method: "POST", path: "/v1/notes/search", description: "Find notes.", evidence: [{ path: "README.md", line: 3, quote: "POST /v1/notes/search" }] };
      await step(ws, OPERATOR, id, "propose-integration", { capabilities: [cited] });
      const p = await ws.project(OPERATOR, id);
      const proposal = (await ws.artifact<{ capabilities: Array<{ name: string; source: string }>; digest: string; files: Array<{ path: string; content: string }> }>(OPERATOR, p.current.integrationProposal))!.body;
      expect(proposal.capabilities.map((c) => [c.name, c.source])).toEqual([["notes.getbyid", "route-scan"], ["notes.search", "agent"]]);
      expect(proposal.files.find((f) => f.path.endsWith("capabilities.mjs"))!.content).toContain('"path":"/v1/notes/search"');
      // The digest a person approves covers the capabilities.
      const { subject } = await ws.approvalSubject(OPERATOR, id, "modify-integration");
      expect(subject).toBe(proposal.digest);
      await ws.approve(OPERATOR, id, { action: "modify-integration", subject });
      expect((await step(ws, OPERATOR, id, "install-integration")).stage).toBe("integration-installed");
      await step(ws, OPERATOR, id, "discover");
      const discovered = (await ws.artifact<DiscoveryRecord>(OPERATOR, (await ws.project(OPERATOR, id)).current.discovery))!.body;
      expect(discovered.capabilities.map((c) => c.name).sort()).toEqual(["notes.getbyid", "notes.search"]);
    } finally {
      await ws.close();
    }
  }, 90_000);
});
