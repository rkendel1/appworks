/**
 * Installing AppPort into a repository that has no AppPort integration: an AppPort application of its own, in its own
 * directory, that publishes discovery and, at first, no capability. Extracted capabilities are added to it later
 * through contract adoption and promotion. The installation is generic: it names the repository, never what kind of
 * application it is, and it modifies no existing file.
 *
 * `proposeInstallation` is a pure function of the repository's identity and pinned files: the same inputs give the same
 * files and digest, which is what the `modify-integration` approval covers. Applying it happens in an isolated worktree
 * of the pinned revision (`workflow.ts`), never in the pinned checkout.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "@appport/protocol";
import { endpointCandidates } from "./endpoints.js";
import type { ProposedCapability } from "./surface.js";

export const INSTALLATION_FORMAT = "appworks.appport-installation/1";
/** The AppPort SDK the installed application pins: the version this workspace's own tests run discovery against. */
export const APPPORT_SDK_VERSION = "1.2.2";
/** The AppPort command line, installed beside the SDK so `npx appport` works in the integration directory. */
export const APPPORT_CLI_VERSION = "1.1.20";
/** The installed application's server, shipped with the workspace (`templates/appport/server.mjs`). */
const SERVER_TEMPLATE = readFileSync(new URL("../templates/appport/server.mjs", import.meta.url), "utf8");

export interface InstallationFile {
  path: string;
  role: "manifest" | "application" | "configuration" | "documentation" | "ignore";
  sha256: string;
  mode: "100644";
  content: string;
}

export interface AppPortInstallation {
  format: typeof INSTALLATION_FORMAT;
  target: { repository: string; revision: string };
  /** The new directory, relative to the repository root. It did not exist at the pinned revision. */
  directory: string;
  application: { id: string; name: string; version: string };
  packages: Record<string, string>;
  /** The port it listens on by default (`APPPORT_PORT` overrides it); one the pinned source does not already name. */
  port: number;
  files: InstallationFile[];
  /** What the integration publishes: each capability proxies one HTTP route of the running application. */
  capabilities: ProposedCapability[];
  /** Where the application listens, which the generated capabilities call (`APPPORT_UPSTREAM` overrides it). */
  upstream: string;
  run: string;
  note: string;
  digest: string;
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const segment = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";

const CAPABILITIES_TEMPLATE = readFileSync(new URL("../templates/appport/capabilities.mjs", import.meta.url), "utf8");

/** `capabilities.mjs`: one AppPort capability per proposal, each a bounded call to the application's own route. */
export function capabilitiesModule(upstream: string, capabilities: ProposedCapability[]): string {
  const entries = capabilities.map((c) => {
    const read = c.method === "GET";
    return `  capability(${JSON.stringify({ name: c.name, description: c.description, method: c.method, path: c.path, effect: read ? "observation" : "consequential", scope: `${c.name.split(".")[0]}.${read ? "read" : "write"}` })})`;
  });
  return CAPABILITIES_TEMPLATE.replace("{{UPSTREAM}}", () => JSON.stringify(upstream)).replace("{{CAPABILITIES}}", () => entries.join(",\n"));
}

export function proposeInstallation(input: { owner: string; name: string; url: string; revision: string; checkout: string; capabilities?: ProposedCapability[] }): AppPortInstallation {
  const directory = ["appport", "appport-integration", "appworks-appport"].find((d) => !existsSync(join(input.checkout, d))) ?? `appport-${input.revision.slice(0, 8)}`;
  const named = new Set(endpointCandidates(input.checkout).map((c) => Number(new URL(c.origin).port)));
  let port = 4319;
  while (named.has(port)) port++;
  const host = /^https:\/\/github\.com\//.test(input.url) ? "github" : "git";
  const application = { id: `com.${host}.${segment(input.owner)}.${segment(input.name)}`, name: input.name, version: "0.0.0" };
  const packages = { "@appport/sdk": APPPORT_SDK_VERSION };
  const capabilities = input.capabilities ?? [];
  const upstream = [...endpointCandidates(input.checkout)].map((c) => c.origin).find((o) => Number(new URL(o).port) !== port) ?? "http://127.0.0.1:8080";
  const contents: Array<Omit<InstallationFile, "sha256" | "mode">> = [
    {
      path: `${directory}/package.json`,
      role: "manifest",
      content: `${JSON.stringify({ name: `${segment(input.name)}-appport`, private: true, type: "module", description: `The AppPort integration of ${input.owner}/${input.name}.`, scripts: { start: "node server.mjs" }, dependencies: packages, devDependencies: { appport: APPPORT_CLI_VERSION } }, null, 2)}\n`
    },
    {
      path: `${directory}/server.mjs`,
      role: "application",
      content: SERVER_TEMPLATE.replaceAll("{{REPOSITORY}}", `${input.owner}/${input.name}`).replaceAll("{{APPLICATION}}", JSON.stringify(application)).replaceAll("{{APPLICATION_ID}}", application.id).replaceAll("{{PORT}}", String(port))
    },
    { path: `${directory}/capabilities.mjs`, role: "application", content: capabilitiesModule(upstream, capabilities) },
    { path: `${directory}/.env.example`, role: "configuration", content: `APPPORT_PORT=${port}\nAPPPORT_UPSTREAM=${upstream}\n` },
    { path: `${directory}/.gitignore`, role: "ignore", content: "node_modules/\n" },
    {
      path: `${directory}/README.md`,
      role: "documentation",
      content: `# AppPort integration\n\nAdded by AppWorks to ${input.owner}/${input.name} at ${input.revision.slice(0, 12)}. It is an AppPort application of its own that\npublishes discovery for this repository's capabilities. It changes no existing file. Its capabilities (capabilities.mjs) each call one route of the running application.\n\n\`\`\`sh\ncd ${directory} && npm install && npm start      # http://127.0.0.1:${port}/.well-known/appport\n\`\`\`\n`
    }
  ];
  const files = contents.map((f) => ({ ...f, sha256: sha(f.content), mode: "100644" as const }));
  const body: Omit<AppPortInstallation, "digest"> = {
    format: INSTALLATION_FORMAT,
    target: { repository: input.url, revision: input.revision },
    directory,
    application,
    packages,
    port,
    files,
    capabilities,
    upstream,
    run: `cd ${directory} && npm install && npm start`,
    note: "Adds an AppPort application in a new directory: no existing file changes. Its packages are installed with lifecycle scripts disabled. It publishes the capabilities proposed from cited evidence in the source (each a bounded call to one route of the running application), and any more that are promoted into it later."
  };
  return { ...body, digest: digestOf({ ...body, files: files.map(({ content: _c, ...f }) => f) }) };
}
