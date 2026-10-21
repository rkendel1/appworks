import { describe, expect, it } from "vitest";
import { JsSyntaxError, joinPaths, pathParameters, readJs, tokenize } from "../src/js.js";

const read = (text: string) => readJs(tokenize(text));
const routes = (text: string) => read(text).routes.map((r) => `${r.method.toUpperCase()} ${r.path.resolution === "unknown" ? "?" : r.path.value}`);

describe("the tokenizer", () => {
  it("keeps strings, templates, comments and regular expressions from being mistaken for each other", () => {
    const t = tokenize("const a = '/x'; // router.get('/no')\n/* app.get('/no2', h) */ const b = a / 2; const re = /ab+c\\/d/g; const t = `/${id}/y`;");
    expect(t.filter((x) => x.kind === "str").map((x) => x.value)).toEqual(["/x"]);
    expect(t.filter((x) => x.kind === "re").map((x) => x.value)).toEqual(["/ab+c\\/d/g"]); // a regex after `=`; the `/` in `a / 2` is division
    expect(t.find((x) => x.kind === "tpl")).toMatchObject({ value: "/${id}/y", exprs: ["id"], quasis: ["/", "/y"] });
  });

  it("reads nested templates and records the line a token starts and ends on", () => {
    const t = tokenize("x = `a${`b${c}`}d`;\ny = 'z';");
    expect(t.filter((x) => x.kind === "tpl")).toHaveLength(1);
    expect(t.find((x) => x.value === "z")!.line).toBe(2);
  });

  it("refuses text it cannot tokenize, with a line, instead of guessing", () => {
    for (const bad of ["x = 'abc\n", "x = `abc", "/* never closed", "x = /abc\n"]) expect(() => tokenize(bad)).toThrow(JsSyntaxError);
    try {
      tokenize("a;\nb;\nc = 'x\n");
    } catch (e) {
      expect((e as JsSyntaxError).line).toBe(3);
    }
  });
});

describe("routes", () => {
  it("finds routes on receivers declared as apps or routers, and only on those", () => {
    const text = `
      const express = require('express');
      const app = express();
      const router = express.Router();
      const cache = new Map();
      app.get('/health', (req, res) => res.send('ok'));
      router.post('/items', auth, create);
      cache.get('key', fallback);
      other.get('/nope', handler);
      app.get('setting');
    `;
    expect(routes(text)).toEqual(["GET /health", "POST /items"]); // a Map, an unknown name and a settings read are not routes
  });

  it("reads route() chains across lines, with middleware and wrapped handlers", () => {
    const j = read(`
      const router = require('express').Router();
      router.route('/a/:id')
        .get(guard, catchErrors(ctl.read))
        .patch(upload({ field: 'x' }), catchErrors(ctl['update']));
    `);
    expect(j.routes.map((r) => [r.method, r.path.value, r.middleware.map((m) => m.text), r.handler?.reference, r.handler?.wrapper])).toEqual([
      ["get", "/a/:id", ["guard"], "ctl.read", "catchErrors"],
      ["patch", "/a/:id", ["upload(…)"], "ctl.update", "catchErrors"]
    ]);
  });

  it("keeps a name inside a path as a placeholder and never guesses its value", () => {
    const j = read("const router = express.Router();\nconst f = (entity) => { router.route(`/${entity}/list`).get(h); router.get('/' + entity + '/x', h); router.get(prefix() + '/y', h); };");
    expect(j.routes.map((r) => [r.path.value, r.path.resolution, r.path.placeholders])).toEqual([
      ["/{entity}/list", "placeholders", ["entity"]],
      ["/{entity}/x", "placeholders", ["entity"]],
      ["", "unknown", []] // a call's result: no value
    ]);
  });

  it("notes inline handlers and the request properties they read", () => {
    const j = read("const app = express();\napp.post('/p', async (req, res) => { const { a } = req.body; use(req.body.name, req.query.page, req.params.id); });");
    expect(j.routes[0]!.handler).toMatchObject({ kind: "inline", reads: ["body.name", "params.id", "query.page"] });
  });

  it("reads Fastify route objects, Hono apps, Koa routers and NestJS controllers", () => {
    expect(routes("const fastify = require('fastify')();\nfastify.route({ method: 'GET', url: '/f', preHandler: auth, handler: async () => 1 });\nfastify.get('/g', async () => 2);")).toEqual(["GET /f", "GET /g"]);
    expect(routes("const app = new Hono();\napp.get('/h', (c) => c.text('x'));")).toEqual(["GET /h"]);
    expect(routes("const router = new Router();\nrouter.put('/k/:id', h);")).toEqual(["PUT /k/:id"]);
    const nest = read(`
      @Controller('cats')
      export class CatsController {
        @Get() findAll() {}
        @Get(':id') findOne(@Param('id') id: string) {}
        @Post() @HttpCode(201) async create(@Body() dto: Dto) {}
      }`);
    expect(nest.routes.map((r) => `${r.method.toUpperCase()} ${r.path.value} ${r.handler!.reference}`)).toEqual(["GET /cats CatsController.findAll", "GET /cats/:id CatsController.findOne", "POST /cats CatsController.create"]);
  });

  it("reads mounts, imports and exported routers, and leaves out middleware that is not a router", () => {
    const j = read(`
      import { Router } from 'express';
      import users from './routes/users';
      import { api } from '../api';
      const app = express();
      app.use(cors());
      app.use(express.json());
      app.use('/users', auth, users);
      app.use('/api', api);
      export default app;
    `);
    expect(j.mounts.map((m) => [m.prefix.value, m.target, m.middleware.map((x) => x.text)])).toEqual([["/users", "users", ["auth"]], ["/api", "api", []]]);
    expect(j.imports.get("users")).toMatchObject({ specifier: "./routes/users" });
    expect(j.exports).toBe("app");
  });
});

describe("paths", () => {
  it("joins prefixes and finds parameters", () => {
    expect(joinPaths("/api/", "/users", "/:id")).toBe("/api/users/:id");
    expect(joinPaths("", "/x")).toBe("/x");
    expect(pathParameters("/a/:id/b/:key?")).toEqual([{ name: "id", optional: false }, { name: "key", optional: true }]);
  });
});
