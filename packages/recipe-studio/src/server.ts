/**
 * The Studio's web server: a JSON API over the same functions the CLI calls, and a static page. It listens on loopback only and
 * acts as the local operator who started it, like the workspace server: requests are accepted only for its own host name, and
 * a mutation must come from its own origin, as JSON, with a header a cross-site form cannot set.
 *
 * What it can do is the whole of what it offers: create, open, edit, import and save recipes; read the catalog; assess readiness
 * against an environment; preview; and make a package. There is no route that grants, revokes, signs, trusts, publishes,
 * installs or runs, because the Studio has nothing to do those with; those are `appworks package ...` and `appworks recipe run`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { validateRecipe, type RecipeSource } from "@appport/recipe";
import { describeCatalog, type CatalogEntry } from "./catalog.js";
import { recipeCard } from "./card.js";
import { applyEdits, newRecipe, type RecipeEdit } from "./edit.js";
import type { StudioEnvironment } from "./environment.js";
import { inspectStep } from "./inspect.js";
import { checkPackageFile, packageProject } from "./package.js";
import { StudioError, recipeDigestOf, type StudioProject, type StudioStore } from "./project.js";
import { assess } from "./readiness.js";

export interface StudioServerOptions {
  store: StudioStore;
  /** The environments an author can check a recipe against; the first is the default. */
  environments: StudioEnvironment[];
  /** Who the Studio acts as when it asks whether a recipe may be started. */
  principal: string;
  host?: string;
  port?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY = 1024 * 1024;
const UI = new URL("../ui/", import.meta.url);
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ui/studio.js": { file: "studio.js", type: "text/javascript; charset=utf-8" },
  "/ui/studio.css": { file: "studio.css", type: "text/css; charset=utf-8" }
};
const PAGE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

const STATUS: Record<StudioError["code"], number> = { NOT_FOUND: 404, EXISTS: 409, CONFLICT: 409, INVALID: 422 };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new StudioError("INVALID", "requests send JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new StudioError("INVALID", "the request is too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, any>;
  } catch {
    throw new StudioError("INVALID", "the request body is not a JSON object");
  }
}

export function projectView(p: StudioProject) {
  const last = p.meta.lastPackage;
  return {
    slug: p.slug,
    revision: p.meta.revision,
    savedAt: p.meta.savedAt,
    release: p.meta.release,
    recipe: p.recipe,
    lastPackage: last ? { digest: last.digest, packagedAt: last.packagedAt, stale: last.recipeDigest !== recipeDigestOf(p.recipe) } : null
  };
}

export function createStudioServer(options: StudioServerOptions): { server: Server; listen(): Promise<string>; close(): Promise<void> } {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new StudioError("INVALID", `the Studio listens on loopback only (${[...LOOPBACK].join(", ")}); it has no network authentication boundary`);
  if (!options.environments.length) throw new StudioError("INVALID", "the Studio needs at least one environment to check recipes against");
  const { store } = options;
  const allowedHosts = new Set<string>();
  let origin = "";

  const environmentOf = (name: string | null): StudioEnvironment => {
    const found = name ? options.environments.find((e) => e.name === name) : options.environments[0];
    if (!found) throw new StudioError("NOT_FOUND", `no environment "${name}"`);
    return found;
  };
  const catalogOf = async (env: StudioEnvironment): Promise<CatalogEntry[]> => (env.gateway.catalog ? env.gateway.catalog() : []);

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    const environment = environmentOf(url.searchParams.get("environment"));

    if (parts[0] !== "api") return send(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
    const [, collection, slug, action, id] = parts;

    if (collection === "environments" && method === "GET") {
      return send(res, 200, options.environments.map((e) => ({ name: e.name, catalog: Boolean(e.gateway.catalog), authority: Boolean(e.authority), access: Boolean(e.gateway.access) })));
    }
    if (collection === "catalog" && method === "GET") {
      return send(res, 200, { environment: environment.name, available: Boolean(environment.gateway.catalog), capabilities: describeCatalog(await catalogOf(environment)) });
    }
    if (collection !== "projects") return send(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });

    if (!slug) {
      if (method === "GET") return send(res, 200, store.list());
      if (method === "POST") {
        const body = await readJson(req);
        const recipe = body["recipe"] !== undefined ? body["recipe"] : newRecipe({ id: String(body["id"] ?? ""), name: String(body["name"] ?? ""), objective: String(body["objective"] ?? ""), ...(body["description"] ? { description: String(body["description"]) } : {}) });
        return send(res, 201, projectView(store.create(String(body["slug"] ?? ""), recipe, body["release"] ?? {})));
      }
    } else if (!action) {
      if (method === "GET") return send(res, 200, projectView(store.open(slug)));
      if (method === "PUT") {
        // Replacing the whole recipe (an import or a hand edit) is a save like any other: it can grant nothing, because a recipe holds no authority.
        const body = await readJson(req);
        return send(res, 200, projectView(store.save(slug, body["recipe"], Number(body["revision"]), { ...(body["release"] ? { release: body["release"] } : {}) })));
      }
    } else if (action === "edit" && method === "POST") {
      const body = await readJson(req);
      const project = store.open(slug);
      const next = applyEdits(project.recipe, (body["edits"] ?? []) as RecipeEdit[], { catalog: await catalogOf(environment) });
      return send(res, 200, projectView(store.save(slug, next, Number(body["revision"]), { ...(body["release"] ? { release: body["release"] } : {}) })));
    } else if (action === "card" && method === "GET") {
      const project = store.open(slug);
      if (!validateRecipe(project.recipe).sourceOk) return send(res, 200, { card: null, reason: "the recipe has source errors; see its readiness" });
      return send(res, 200, { card: recipeCard(project.recipe as RecipeSource) });
    } else if (action === "assessment" && method === "GET") {
      const project = store.open(slug);
      return send(res, 200, await assess(project.recipe, environment, { principal: options.principal, ...(project.meta.lastPackage ? { previous: project.meta.lastPackage } : {}) }));
    } else if (action === "steps" && id && method === "GET") {
      const project = store.open(slug);
      if (!validateRecipe(project.recipe).sourceOk) return send(res, 422, { error: { code: "INVALID", message: "the recipe has source errors" } });
      const inspection = inspectStep(project.recipe as RecipeSource, id, await catalogOf(environment));
      return inspection ? send(res, 200, inspection) : send(res, 404, { error: { code: "NOT_FOUND", message: `no step "${id}"` } });
    } else if (action === "package" && !id && method === "POST") {
      return send(res, 200, await packageProject(store, slug, environment));
    } else if (action === "package" && id === "check" && method === "GET") {
      return send(res, 200, checkPackageFile(store, slug));
    }
    return send(res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) return send(res, 421, { error: { code: "INVALID", message: "unrecognised host" } });
        const url = new URL(req.url ?? "/", origin);
        if (req.method === "GET" && ASSETS[url.pathname]) {
          const asset = ASSETS[url.pathname]!;
          res.writeHead(200, { "content-type": asset.type, ...PAGE_HEADERS });
          return void res.end(readFileSync(fileURLToPath(new URL(asset.file, UI))));
        }
        if (req.method !== "GET") {
          const fromOrigin = req.headers.origin;
          if ((fromOrigin !== undefined && fromOrigin !== origin) || req.headers["x-appworks-request"] !== "studio") return send(res, 403, { error: { code: "INVALID", message: "a change must come from the Studio page" } });
        }
        await route(req, res, url);
      } catch (error) {
        if (error instanceof StudioError) return send(res, STATUS[error.code], { error: { code: error.code, message: error.message } });
        send(res, 500, { error: { code: "INTERNAL_ERROR", message: "the Studio could not complete the request" } });
      }
    })();
  });

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => {
          const { port } = server.address() as AddressInfo;
          origin = `http://${host === "::1" ? "[::1]" : host}:${port}`;
          for (const h of LOOPBACK) allowedHosts.add(`${h === "::1" ? "[::1]" : h}:${port}`.toLowerCase());
          resolve(origin);
        });
      }),
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(() => resolve())))
  };
}
