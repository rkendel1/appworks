import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JSONSchema } from "@appport/protocol";
import { fromJSONSchema } from "@appport/schema";
import { assessRepository, verifyAssessment, type ApplicationAssessment } from "../src/index.js";
import { MEMOS_FIXTURE, clone, syntheticApp, tempDir, writeTree } from "./helpers.js";

const schema2 = fromJSONSchema(JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/application-assessment-2.schema.json", import.meta.url)), "utf8")) as JSONSchema);

/** The shape of a real Express application: an app mounting routers under prefixes, behind middleware, through an alias. */
const express = (): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "shop-api", dependencies: { express: "^4" } }),
  "jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@/*": ["./*"] } } }),
  "src/app.js": [
    "const express = require('express');",
    "const authRouter = require('./routes/auth');",
    "const apiRouter = require('./routes/api');",
    "const guard = require('@/middleware/guard');",
    "const app = express();",
    "app.use(express.json());",
    "app.use('/auth', authRouter);",
    "app.use('/api', guard.check, apiRouter);",
    "app.get('/health', (req, res) => res.json({ ok: true }));",
    "module.exports = app;"
  ].join("\n"),
  "src/routes/auth.js": ["const router = require('express').Router();", "const ctl = require('@/controllers/auth');", "router.route('/login').post(ctl.login);", "module.exports = router;"].join("\n"),
  "src/routes/api.js": [
    "const express = require('express');",
    "const router = express.Router();",
    "const orders = require('../controllers/orders');",
    "router.get('/orders/:id', orders.read);",
    "router",
    "  .route('/orders')",
    "  .get(orders.list)",
    "  .post(validate, orders.create);",
    "const kinds = ['a'];",
    "kinds.forEach((kind) => router.get(`/${kind}/summary`, (req, res) => res.json(req.query.range)));",
    "module.exports = router;"
  ].join("\n"),
  "src/controllers/auth.js": "module.exports = makeAuth('user');\n",
  "src/controllers/orders.js": ["exports.read = async (req, res) => {};", "exports.list = async (req, res) => {};", "exports.create = async (req, res) => {};"].join("\n"),
  "src/middleware/guard.js": "exports.check = (req, res, next) => next();\n",
  "src/components/Banner.jsx": "export const Banner = () => <p>don't parse me</p>;\n",
  "test/app.test.js": "const app = require('express')();\napp.get('/in-a-test', h);\n"
});

const names = (a: ApplicationAssessment) => a.candidates.map((c) => c.name);

describe("scanner 2: HTTP routes in JavaScript", () => {
  const root = writeTree(tempDir(), express());
  const a = assessRepository(root, { scanner: 2 });
  const by = (name: string) => a.candidates.find((c) => c.name === name)!;

  it("finds each route with the prefixes of the mounts that lead to it, across files and through the alias", () => {
    expect([...names(a)].sort()).toEqual(["GET /api/orders", "GET /api/orders/:id", "GET /api/{kind}/summary", "GET /health", "POST /api/orders", "POST /auth/login"].sort());
    expect(by("GET /health").operation).toMatchObject({ kind: "http", method: "GET", path: "/health", framework: "express", placeholders: [] });
    expect(by("GET /api/{kind}/summary").operation).toMatchObject({ placeholders: ["kind"] });
  });

  it("does not read tests, markup or code that mentions no routing framework", () => {
    expect(names(a).some((n) => n.includes("in-a-test"))).toBe(false);
    expect(a.findings.map((f) => f.code)).toContain("JAVASCRIPT_NOT_ANALYZED");
    expect(a.coverage.partialReasons).toContain("javascript-files-not-routing-code");
  });

  it("names the middleware in front of a route, from the route and from its mounts, and does not say what it enforces", () => {
    const post = by("POST /api/orders");
    const kinds = post.evidence.map((id) => a.evidence.find((e) => e.id === id)!).filter((e) => e.kind === "js.middleware").map((e) => e.subject);
    expect(kinds.sort()).toEqual(["guard.check", "validate"]);
    const unknown = post.unknowns.map((id) => a.evidence.find((e) => e.id === id)!).find((e) => e.kind === "unknown.authorization")!;
    expect(unknown.observation).toMatch(/what they enforce is not established/);
  });

  it("links a handler reference to its definition one import away, and says when it cannot", () => {
    expect(by("GET /api/orders/:id").implementation).toMatchObject({ link: "route-handler-reference", location: { path: "src/controllers/orders.js", startLine: 1 } });
    expect(by("POST /auth/login")).toMatchObject({ confidence: "unlinked", readiness: { class: "insufficient-evidence" } }); // a factory builds `login`: not followed
    expect(by("GET /api/{kind}/summary").implementation).toMatchObject({ link: "route-inline" });
  });

  it("takes what the route text states as the request shape: path parameters and an inline handler's reads", () => {
    expect(by("GET /api/orders/:id").inputs!.fields).toMatchObject([{ name: "id", label: "required", behaviors: ["path-parameter"] }]);
    expect(by("GET /api/{kind}/summary").inputs!.fields.map((f) => f.name)).toEqual(["range"]);
  });

  it("proposes an effect from the method, marked inferred, and never calls a route an exposure candidate", () => {
    expect(by("GET /api/orders").exposure.effectBasis.effect).toBe("observation");
    expect(by("POST /api/orders").exposure.effectBasis).toMatchObject({ effect: "consequential", reasons: ["http-method-unsafe-by-convention", "handler-not-read"] });
    expect(by("POST /api/orders").readiness.concerns.map((c) => c.concern)).toEqual(["writes-state"]);
    expect(a.candidates.every((c) => c.readiness.class !== "exposure-candidate")).toBe(true);
    expect(a.recommendation).toBeNull();
    const effect = a.evidence.find((e) => e.id === by("GET /health").exposure.effectBasis.evidence[0])!;
    expect(effect).toMatchObject({ class: "inferred", kind: "http.effect" });
  });

  it("is a valid /2 assessment: the verifier re-reads every cited line, and the schema accepts it", () => {
    expect(a.format).toBe("appport.application-assessment/2");
    expect(a.configuration.scanner).toBe("appport.assessment-scanner/2");
    expect(verifyAssessment(a, { repository: root })).toEqual({ ok: true, findings: [] });
    expect(schema2.validate(a).ok).toBe(true);
    expect(a.limitations.map((l) => l.code)).toEqual(expect.arrayContaining(["http-routes", "http-handlers", "http-effect"]));
  });

  it("is deterministic, and the same tree written in another order assesses identically", () => {
    const again = assessRepository(writeTree(tempDir(), express(), "reversed"), { scanner: 2, now: () => new Date(0), id: () => "x" });
    expect(again.digest).toBe(a.digest);
    expect(assessRepository(root, { scanner: 2 }).digest).toBe(a.digest);
  });

  it("the verifier holds /2 to what /2 allows: an http operation or method is refused in a /1 document, and a mismatched scanner is refused", () => {
    const as1 = clone(a) as unknown as Record<string, any>;
    as1.format = "appport.application-assessment/1";
    const codes = verifyAssessment(as1).findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["ASSESSMENT_SCANNER", "CANDIDATE_OPERATION", "EVIDENCE_METHOD"]));
    const mismatched = clone(a) as unknown as Record<string, any>;
    mismatched.configuration.scanner = "appport.assessment-scanner/1";
    expect(verifyAssessment(mismatched).findings.map((f) => f.code)).toContain("ASSESSMENT_SCANNER");
    const wrongKind = clone(a) as unknown as Record<string, any>;
    wrongKind.candidates[0].operation = { kind: "graphql" };
    expect(verifyAssessment(wrongKind).findings.map((f) => f.code)).toContain("CANDIDATE_OPERATION");
  });

  it("reports what it could not read: unmounted routers, unreadable paths", () => {
    const loose = writeTree(tempDir(), {
      "server.js": "const express = require('express');\nconst r = express.Router();\nconst name = process.env.P;\nr.get(prefix(name), h);\nr.get('/solo', h);\n"
    });
    const x = assessRepository(loose, { scanner: 2 });
    expect(names(x)).toEqual(["GET /solo"]);
    expect(x.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["ROUTE_PATH_UNREADABLE", "ROUTER_NOT_MOUNTED"]));
    expect(verifyAssessment(x, { repository: loose }).ok).toBe(true);
  });
});

describe("scanner 1 is unchanged", () => {
  it("assesses the same tree as before: /1, no HTTP candidates, no JavaScript read", () => {
    const root = writeTree(tempDir(), express());
    const one = assessRepository(root);
    expect(one).toMatchObject({ format: "appport.application-assessment/1", configuration: { scanner: "appport.assessment-scanner/1" } });
    expect(one.candidates).toEqual([]);
    expect(one.findings.map((f) => f.code)).toContain("NO_ENTRY_POINTS");
    expect(assessRepository(root, { scanner: 1 }).digest).toBe(one.digest);
  });

  it("scanner 2 keeps every Go and Protocol Buffers candidate scanner 1 found, unchanged", () => {
    for (const root of [MEMOS_FIXTURE, writeTree(tempDir(), syntheticApp())]) {
      const one = assessRepository(root);
      const two = assessRepository(root, { scanner: 2 });
      expect(one.candidates.length).toBeGreaterThan(0);
      const rpc = two.candidates.filter((c) => c.operation.kind === "rpc");
      expect(rpc).toEqual(one.candidates);
      expect(verifyAssessment(two, { repository: root }).ok).toBe(true);
    }
  });
});
