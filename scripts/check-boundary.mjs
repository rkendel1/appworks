#!/usr/bin/env node
// Enforces AppWorks' dependency rules (docs/architecture.md §3). Fails on the first category of violation it finds,
// listing every instance.
//
// 1. @appport/recipe depends only on the published AppPort protocol, schema and integration packages: never on
//    Distribution Protocol, a registry, or the AppPort runtime (@appport/core).
// 2. Only @appport/recipe-distribution depends on @distribution-protocol/*.
// 3. AppPort packages are consumed as published, exact versions: no workspace:, link:, file: or git dependency on them,
//    and no import, path alias or project reference into a sibling AppPort checkout.
// 4. No source imports outside its own package except through a declared package name.
// 5. The recipe model contains no code-execution primitive: recipes are data.
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

for (const { dir, manifest } of packages) {
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies };
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith("@distribution-protocol/") && manifest.name !== "@appport/recipe-distribution") fail(`${manifest.name} depends on ${name}; only @appport/recipe-distribution may`);
    if (APPPORT_UPSTREAM.includes(name) && !/^\d+\.\d+\.\d+$/.test(spec)) fail(`${manifest.name} depends on ${name}@${spec}; AppPort packages are consumed as exact published versions`);
    if (APPPORT_UPSTREAM.includes(name) && name === "@appport/core") fail(`${manifest.name} depends on @appport/core; AppWorks reads core's records structurally`);
  }
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
      if (!(name in deps) && name !== manifest.name) fail(`${file} imports ${name}, which ${manifest.name} does not declare`);
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
