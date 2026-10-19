#!/usr/bin/env node
// Enforces AppWorks' dependency rules (docs/architecture.md §3). Fails on the first category of violation it finds,
// listing every instance.
//
// 1. @appport/recipe depends only on the published AppPort protocol, schema and integration packages: never on
//    Distribution Protocol, a registry, or the AppPort runtime (@appport/core), which may be a devDependency for tests
//    against real resolution and binding, and is never imported by shipped source.
// 2. Only @appport/recipe-distribution depends on @distribution-protocol/*.
// 3. AppPort packages are consumed as published, exact versions: no workspace:, link:, file: or git dependency on them,
//    and no import, path alias or project reference into a sibling AppPort checkout.
// 4. No source imports outside its own package except through a declared package name.
// 5. The recipe model contains no code-execution primitive: recipes are data.
// 6. @appport/assessment depends only on @appport/protocol at run time and never on @appport/core or Distribution
//    Protocol. Its source contains no code-execution or network primitive, and only its CLI writes a file (the
//    assessment output): it reads the repository it assesses and nothing else.
// 7. @appport/extraction depends only on @appport/protocol, @appport/schema and @appport/assessment at run time; never
//    on @appport/core, @appport/sdk or Distribution Protocol; nothing depends on it from below (assessment, recipe).
//    Its source has no code-execution or network primitive, and only its CLI writes a file. Adapters live in private
//    packages under extractions/, are never shipped, and pin AppPort exactly.
// 8. @appport/workspace (the project workspace and orchestrator; private, not published) depends at run time only on
//    @appport/assessment, @appport/extraction, @appport/protocol, @appport/client (discovery), @appport/github (the
//    stack's GitHub integration) and @feltdb/core (its only durable state), all published ones at exact versions; never
//    on @appport/core, @appport/services or a second database or scheduler. @appport/sdk is a test-only dependency (a
//    real application to discover). Processes run in two places only: git, against the isolated checkout
//    (src/repository.ts), and the approved extraction runner (src/runner.ts); only src/server.ts serves HTTP. Its schema
//    and workflow are its feltdb.flow, and nothing below it (assessment, extraction, recipe) depends on it.
//    Its agent runtime may also depend on @appport/schema (validating decisions) and on two model providers' SDKs,
//    @anthropic-ai/sdk and openai, each imported by its own adapter (src/agent/providers/<provider>.ts) and nowhere
//    else: the orchestrator, the action registry and the workflow know the provider-neutral contract only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const fail = (message) => violations.push(message);
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((entry) => {
    const path = join(dir, entry);
    if (["node_modules", "dist", ".git"].includes(entry)) return [];
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });

const APPPORT_UPSTREAM = ["@appport/protocol", "@appport/schema", "@appport/integration", "@appport/core", "@appport/authorization", "@appport/sdk"];
const packages = readdirSync(join(root, "packages")).map((dir) => ({ dir: `packages/${dir}`, manifest: json(`packages/${dir}/package.json`) }));
const byName = Object.fromEntries(packages.map((p) => [p.manifest.name, p]));

const recipe = byName["@appport/recipe"];
if (!recipe) fail("@appport/recipe is missing");
else {
  const allowed = new Set(["@appport/protocol", "@appport/schema", "@appport/integration"]);
  for (const name of Object.keys({ ...recipe.manifest.dependencies, ...recipe.manifest.peerDependencies })) {
    if (!allowed.has(name)) fail(`@appport/recipe depends on ${name}; it may depend only on ${[...allowed].join(", ")}`);
  }
}

const assessment = byName["@appport/assessment"];
if (!assessment) fail("@appport/assessment is missing");
else {
  for (const name of Object.keys({ ...assessment.manifest.dependencies, ...assessment.manifest.peerDependencies })) {
    if (name !== "@appport/protocol") fail(`@appport/assessment depends on ${name}; it may depend only on @appport/protocol`);
  }
  if ("@appport/core" in { ...assessment.manifest.devDependencies }) fail("@appport/assessment depends on @appport/core; it reimplements nothing of AppPort's runtime and needs none of it");
  for (const file of walk(`${assessment.dir}/src`).filter((f) => f.endsWith(".ts"))) {
    const text = read(file);
    if (/\beval\s*\(|new\s+Function\s*\(|child_process|node:vm\b|\bimport\s*\(|node:(?:http|https|http2|net|tls|dgram|dns|worker_threads)\b|\bfetch\s*\(|\bWebSocket\b/.test(text)) fail(`${file} contains a code-execution or network primitive; assessment only reads`);
    const writes = text.match(/\b(?:writeFile|appendFile|mkdir|rmdir|rm|unlink|rename|chmod|chown|symlink|link|copyFile|truncate|utimes|cp|createWriteStream|mkdtemp)(?:Sync)?\s*\(/g) ?? [];
    if (writes.length && !file.endsWith("/src/cli.ts")) fail(`${file} writes to the filesystem (${writes.join(", ")}); only the CLI writes, and only its output file`);
  }
}

const extraction = byName["@appport/extraction"];
if (!extraction) fail("@appport/extraction is missing");
else {
  const allowed = new Set(["@appport/protocol", "@appport/schema", "@appport/assessment"]);
  for (const name of Object.keys({ ...extraction.manifest.dependencies, ...extraction.manifest.peerDependencies })) {
    if (!allowed.has(name)) fail(`@appport/extraction depends on ${name}; it may depend only on ${[...allowed].join(", ")}`);
  }
  for (const name of ["@appport/core", "@appport/sdk"]) if (name in { ...extraction.manifest.devDependencies }) fail(`@appport/extraction depends on ${name}; adapters that need it live under extractions/`);
  for (const file of walk(`${extraction.dir}/src`).filter((f) => f.endsWith(".ts"))) {
    const text = read(file);
    if (/\beval\s*\(|new\s+Function\s*\(|child_process|node:vm\b|\bimport\s*\(|node:(?:http|https|http2|net|tls|dgram|dns|worker_threads|module)\b|\bfetch\s*\(|\bWebSocket\b|\brequire\s*\(/.test(text)) fail(`${file} contains a code-execution or network primitive; extraction reads and binds, it never runs an adapter`);
    const writes = text.match(/\b(?:writeFile|appendFile|mkdir|rmdir|rm|unlink|rename|chmod|chown|symlink|link|copyFile|truncate|utimes|cp|createWriteStream|mkdtemp)(?:Sync)?\s*\(/g) ?? [];
    if (writes.length && !file.endsWith("/src/cli.ts")) fail(`${file} writes to the filesystem (${writes.join(", ")}); only the CLI writes, and only its output file`);
  }
}
for (const lower of ["@appport/assessment", "@appport/recipe", "@appport/recipe-distribution"]) {
  const m = byName[lower]?.manifest;
  if (m && "@appport/extraction" in { ...m.dependencies, ...m.peerDependencies, ...m.devDependencies }) fail(`${lower} depends on @appport/extraction; extraction consumes assessments, never the reverse`);
}
const workspace = byName["@appport/workspace"];
if (workspace) {
  const allowed = new Set(["@appport/assessment", "@appport/extraction", "@appport/protocol", "@appport/client", "@appport/github", "@feltdb/core", "@appport/schema", "@anthropic-ai/sdk", "openai"]);
  const providerSdks = { "@anthropic-ai/sdk": "/src/agent/providers/anthropic.ts", openai: "/src/agent/providers/openai.ts" };
  for (const [name, spec] of Object.entries({ ...workspace.manifest.dependencies, ...workspace.manifest.peerDependencies })) {
    if (!allowed.has(name)) fail(`@appport/workspace depends on ${name}; it may depend only on ${[...allowed].join(", ")}`);
    if (!byName[name] && !/^\d+\.\d+\.\d+$/.test(spec)) fail(`@appport/workspace depends on ${name}@${spec}; published dependencies are exact versions`);
  }
  for (const name of Object.keys({ ...workspace.manifest.devDependencies })) if (name !== "@appport/sdk") fail(`@appport/workspace has devDependency ${name}; only @appport/sdk (a real application for discovery tests) is allowed`);
  if (workspace.manifest.private !== true) fail("@appport/workspace must be private: it is an application, and @appport/github brings a second AppPort stack a published library must not");
  if (!workspace.manifest.files?.includes("feltdb.flow")) fail("@appport/workspace must ship its feltdb.flow");
  try {
    if (!/^flow_version 1\b/m.test(read(`${workspace.dir}/feltdb.flow`))) fail("packages/workspace/feltdb.flow is not a flow_version 1 FeltDB flow");
  } catch {
    fail("packages/workspace/feltdb.flow is missing");
  }
  for (const file of walk(`${workspace.dir}/src`).filter((f) => f.endsWith(".ts"))) {
    const text = read(file);
    if (/\beval\s*\(|new\s+Function\s*\(|node:vm\b|\bimport\s*\(\s*[^"'@\s]/.test(text)) fail(`${file} contains a code-evaluation primitive`);
    if (/child_process/.test(text) && !/\/src\/(repository|runner)\.ts$/.test(file)) fail(`${file} runs processes; only src/repository.ts (git) and src/runner.ts (the approved runner) may`);
    if (/node:(?:http|https|http2|net|tls|dgram)\b/.test(text.replace(/import type[^;]*;/g, "")) && !file.endsWith("/src/server.ts")) fail(`${file} opens network connections or servers; only src/server.ts serves HTTP (discovery goes through @appport/client, GitHub through @appport/github)`);
    if (/["']@appport\/services["']|["']express["']|createFeltDB\(/.test(text) && !file.endsWith("/src/store.ts")) fail(`${file} opens another store or service runtime; FeltDB is opened in src/store.ts only`);
    for (const [sdk, home] of Object.entries(providerSdks)) if (new RegExp(`from\\s+["']${sdk.replace("/", "\\/")}(?:/[^"']*)?["']`).test(text) && !file.endsWith(home)) fail(`${file} imports ${sdk}; only ${home.slice(1)} (its adapter) may`);
  }
}
for (const lower of ["@appport/assessment", "@appport/extraction", "@appport/recipe", "@appport/recipe-distribution"]) {
  const m = byName[lower]?.manifest;
  if (m && "@appport/workspace" in { ...m.dependencies, ...m.peerDependencies, ...m.devDependencies }) fail(`${lower} depends on @appport/workspace; the workspace consumes them, never the reverse`);
}
for (const dir of readdirSync(join(root, "extractions"))) {
  const manifest = json(`extractions/${dir}/package.json`);
  if (manifest.private !== true) fail(`extractions/${dir} must be private: adapters are review and test material, not published packages`);
  for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith("@appport/") && !byName[name] && !/^\d+\.\d+\.\d+$/.test(spec)) fail(`extractions/${dir} depends on ${name}@${spec}; AppPort packages are pinned exactly`);
    if (name.startsWith("@distribution-protocol/")) fail(`extractions/${dir} depends on ${name}`);
  }
}

for (const { dir, manifest } of packages) {
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies };
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith("@distribution-protocol/") && manifest.name !== "@appport/recipe-distribution") fail(`${manifest.name} depends on ${name}; only @appport/recipe-distribution may`);
    if (APPPORT_UPSTREAM.includes(name) && !/^\d+\.\d+\.\d+$/.test(spec)) fail(`${manifest.name} depends on ${name}@${spec}; AppPort packages are consumed as exact published versions`);
  }
  // The AppPort runtime is a test-only dependency: real resolution and binding in tests, never in what is shipped.
  const runtime = { ...manifest.dependencies, ...manifest.peerDependencies };
  if ("@appport/core" in runtime) fail(`${manifest.name} depends on @appport/core at run time; it may only be a devDependency (tests)`);
  const shipped = { ...runtime };
  for (const file of walk(`${dir}/src`).filter((f) => f.endsWith(".ts"))) {
    const text = read(file);
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\s[^;'"]*?\sfrom\s*["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)
    ].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        const target = resolve(root, dirname(file), specifier);
        if (!target.startsWith(join(root, dir) + "/")) fail(`${file} imports ${specifier}, outside its package`);
        continue;
      }
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (name.startsWith("node:")) continue;
      if (!(name in shipped) && name !== manifest.name) fail(`${file} imports ${name}, which ${manifest.name} does not declare as a runtime dependency`);
      if (name.startsWith("@distribution-protocol/") && manifest.name !== "@appport/recipe-distribution") fail(`${file} imports ${name}`);
    }
    if (manifest.name === "@appport/recipe" && /\beval\s*\(|new\s+Function\s*\(|child_process|node:vm\b|\bimport\s*\(/.test(text)) fail(`${file} contains a code-execution primitive; recipes are data`);
  }
}

for (const file of ["tsconfig.base.json", "tsconfig.build.json", "tsconfig.test.json", "vitest.config.ts", "pnpm-workspace.yaml", ...packages.map((p) => `${p.dir}/tsconfig.json`)]) {
  if (/\.\.\/(?:\.\.\/)*appport\b|\/appport\/packages\//.test(read(file))) fail(`${file} refers to a sibling AppPort checkout`);
}

if (violations.length) {
  process.stderr.write(`boundary check failed:\n- ${violations.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`ok  AppWorks dependency boundary (${packages.length} packages)\n`);
}
