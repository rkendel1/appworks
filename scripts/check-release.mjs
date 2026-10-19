#!/usr/bin/env node
// Proves the packages work for someone who only has npm: packs each workspace package (after `pnpm build`), audits
// the tarballs, installs them into a clean project OUTSIDE this repository, with AppPort and Distribution Protocol
// resolved from the registry at the versions the manifests declare, and runs a consumer against the installed copies.
// Nothing is linked from the workspace, and no repository source is imported.
//
//   node scripts/check-release.mjs [--keep <dir>]
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep") ? process.argv[process.argv.indexOf("--keep") + 1] : undefined;
const scratch = keep ?? mkdtempSync(join(tmpdir(), "appworks-release-"));
const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (r.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed (${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
    process.exit(1);
  }
  return r;
};
const problems = [];

// 1. Pack. pnpm rewrites workspace: dependencies to the concrete version.
const tarballs = join(scratch, "tarballs");
mkdirSync(tarballs, { recursive: true });
const dirs = readdirSync(join(root, "packages")).map((d) => join(root, "packages", d));
const manifests = {};
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  manifests[manifest.name] = manifest;
  run("pnpm", ["pack", "--pack-destination", tarballs], { cwd: dir });
}
const files = readdirSync(tarballs).filter((f) => f.endsWith(".tgz")).map((f) => join(tarballs, f));

// 2. Audit contents: built output, shipped schemas and README only; no sources, tests or unresolved workspace specs.
for (const file of files) {
  const list = run("tar", ["-tzf", file]).stdout.trim().split("\n");
  const extracted = join(scratch, "audit", file.split(sep).pop());
  mkdirSync(extracted, { recursive: true });
  run("tar", ["-xzf", file, "-C", extracted]);
  const packed = JSON.parse(readFileSync(join(extracted, "package", "package.json"), "utf8"));
  for (const entry of list) {
    const path = entry.replace(/^package\//, "");
    if (!/^(dist\/|schemas\/|README\.md$|package\.json$)/.test(path)) problems.push(`${packed.name}: unexpected file ${path}`);
    if (/\.test\.|\/test\/|\/src\//.test(path)) problems.push(`${packed.name}: ships ${path}`);
  }
  if (!list.includes("package/dist/index.js") || !list.includes("package/dist/index.d.ts")) problems.push(`${packed.name}: missing dist/index.js or dist/index.d.ts`);
  for (const [name, spec] of Object.entries(packed.dependencies ?? {})) if (/^(workspace:|link:|file:)/.test(spec)) problems.push(`${packed.name}: dependency ${name}@${spec} is not publishable`);
}
if (problems.length) {
  console.error(`tarball audit failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Packed and audited ${files.length} tarballs`);

// 3. Install into a clean project outside the repository.
const project = join(scratch, "project");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "appworks-installed-consumer", version: "0.0.0", private: true, type: "module" }, null, 2));
const env = { ...process.env, npm_config_cache: join(scratch, "npm-cache") };
// The packed AppWorks tarballs, plus the AppPort runtime from the registry at the exact version @appport/recipe tests against
// (a consumer that resolves canonical dependencies brings its own @appport/core; @appport/recipe does not depend on it).
const coreVersion = JSON.parse(readFileSync(join(root, "packages", "recipe", "package.json"), "utf8")).devDependencies["@appport/core"];
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...files, `@appport/core@${coreVersion}`, "@types/node@22"], { cwd: project, env });
for (const name of Object.keys(manifests)) {
  const installed = join(project, "node_modules", name);
  if (lstatSync(installed).isSymbolicLink() || realpathSync(installed).startsWith(root + sep)) {
    console.error(`${name} is linked into the repository: this is not an install`);
    process.exit(1);
  }
}
const recipeManifest = manifests["@appport/recipe"];
const external = (deps) => Object.fromEntries(Object.entries(deps ?? {}).filter(([name]) => !manifests[name]));
for (const [name, version] of Object.entries({ ...recipeManifest.dependencies, ...manifests["@appport/assessment"].dependencies, ...external(manifests["@appport/extraction"].dependencies), "@appport/core": coreVersion })) {
  const installed = JSON.parse(readFileSync(join(project, "node_modules", name, "package.json"), "utf8")).version;
  if (installed !== version) {
    console.error(`${name}: installed ${installed}, the manifest declares ${version}`);
    process.exit(1);
  }
}
// One copy of each AppPort package: a second, older @appport/protocol beside the new one would split types and identities.
for (const name of ["@appport/protocol", "@appport/schema", "@appport/integration"]) {
  const listing = spawnSync("npm", ["ls", name, "--all", "--parseable"], { cwd: project, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  if (new Set(listing).size !== 1) {
    console.error(`${name} is installed more than once:\n${listing.join("\n")}`);
    process.exit(1);
  }
}
console.log(`Installed ${Object.keys(manifests).length} real packages, with @appport/{protocol,schema,integration} and @appport/core@${coreVersion} from the registry, one copy each`);

// 4. A consumer that knows only the public exports.
copyFileSync(join(root, "examples", "supplier-invoice", "recipe.json"), join(project, "recipe.json"));
writeFileSync(join(project, "consumer.mjs"), `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as recipe from "@appport/recipe";
import * as distribution from "@appport/recipe-distribution";
import { fromJSONSchema } from "@appport/schema";
const check = (ok, message) => { if (!ok) { console.error("FAIL", message); process.exit(1); } console.log("  ok ", message); };
const source = JSON.parse(readFileSync("recipe.json", "utf8"));
check(recipe.RECIPE_FORMAT === "appport.recipe/1" && recipe.RECIPE_PACKAGE_BINDING_SCHEME === "appport/recipe-package/1", "formats are exported");
const result = recipe.validateRecipe(source);
check(result.ok && result.findings.length === 0, "the supplier-invoice example is valid source");
const env = recipe.validateRecipe(source, {});
check(env.sourceOk && env.findings.length === 3 && env.findings.every((f) => f.code === "ENV_CONTRACT_UNAVAILABLE" && f.scope === "environment"), "its unresolved contract is reported as three environment findings");
check(recipe.validateRecipe({ ...source, format: "appport.recipe/2" }).findings[0].code === "RECIPE_FORMAT", "an unsupported format version is refused");
check(recipe.evaluateExpression({ op: "gt", args: [{ ref: "/input/amount" }, { value: 10000 }] }, { input: { amount: 25000 } }) === true, "expressions evaluate");
const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@appport/recipe/package.json").replace(/package\\.json$/, "schemas/recipe.schema.json"), "utf8"));
check(fromJSONSchema(schema).validate(source).ok, "the shipped recipe schema validates the example");
const refused = recipe.loadRecipePackage(JSON.stringify({ format: "appport.recipe-package/1", kind: "compiled" }));
check(!refused.ok && refused.executable === false && refused.findings[0].code === "PACKAGE_KIND_UNSUPPORTED", "a compiled package is refused, and nothing is executable");
check(distribution.DISTRIBUTION_PROTOCOL === "distribution/1" && typeof distribution.acceptAcquiredRecipePackage === "function", "the distribution boundary is exported");
`);
const consumer = run("node", ["consumer.mjs"], { cwd: project });
process.stdout.write(consumer.stdout);

// 5. A strict TypeScript consumer of the installed declarations, including AppPort's published record types.
copyFileSync(join(root, "scripts", "installed-consumer", "types.ts"), join(project, "types.ts"));
writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", lib: ["ES2022"], strict: true, noEmit: true, skipLibCheck: false, types: ["node"] }, files: ["types.ts"] }));
run(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: project });
console.log("  ok  the public declarations typecheck in a consumer project");
// 6. A recipe lock over real canonical resolution by the published @appport/core.
copyFileSync(join(root, "scripts", "installed-consumer", "canonical.mjs"), join(project, "canonical.mjs"));
process.stdout.write(run("node", ["canonical.mjs"], { cwd: project }).stdout);
// 7. The installed `appworks` command assesses a real application (the vendored Memos subset, copied outside the
//    repository), leaves it unchanged, and its artifact verifies through the installed library and its shipped schema.
const memos = join(scratch, "memos");
cpSync(join(root, "packages", "assessment", "test", "fixtures", "memos"), memos, { recursive: true });
const bin = join(project, "node_modules", ".bin", "appworks");
const listing = (dir) => readdirSync(dir, { recursive: true }).sort().map((p) => `${p}:${lstatSync(join(dir, p)).isFile() ? readFileSync(join(dir, p), "base64") : ""}`).join("\n");
const before = listing(memos);
const assessed = run(bin, ["assess", memos, "--output", join(project, "assessment.json")], { cwd: project });
process.stdout.write(`${assessed.stdout.trimEnd().replace(/^/gm, "  | ")}\n`);
if (listing(memos) !== before) {
  console.error("the assessed repository changed");
  process.exit(1);
}
run(bin, ["verify", join(project, "assessment.json"), "--repo", memos], { cwd: project });
writeFileSync(join(project, "assessment.mjs"), `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fromJSONSchema } from "@appport/schema";
import { ASSESSMENT_FORMAT, verifyAssessment } from "@appport/assessment";
const check = (ok, message) => { if (!ok) { console.error("FAIL", message); process.exit(1); } console.log("  ok ", message); };
const a = JSON.parse(readFileSync("assessment.json", "utf8"));
check(a.format === ASSESSMENT_FORMAT && verifyAssessment(a, { repository: ${JSON.stringify(memos)} }).ok, "the installed CLI's artifact verifies, locations included");
const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve("@appport/assessment/package.json").replace(/package\\.json$/, "schemas/application-assessment.schema.json"), "utf8"));
check(fromJSONSchema(schema).validate(a).ok, "the shipped schema validates it");
const recommended = a.candidates.find((c) => c.id === a.recommendation?.candidate);
check(recommended?.readiness.class === "exposure-candidate" && recommended.exposure.authoritative === false && a.scope.grantsAuthority === false, "it recommends an exposure candidate as a non-authoritative proposal");
a.candidates[0].readiness.class = "verified";
check(!verifyAssessment(a).ok, "a claim of verification is refused");
`);
process.stdout.write(run("node", ["assessment.mjs"], { cwd: project }).stdout);
// 8. The installed `appworks extract` refuses an assessment that is not tied to a revision, extracts from one that is
//    (a scratch copy given a synthetic git HEAD: this checks the tool, not Memos), and the installed library and shipped
//    schema verify both that artifact and the committed Memos extraction against its adapter sources.
const refused = spawnSync(bin, ["extract", join(project, "assessment.json"), "--candidate", "cand-memos.api.UserService.ListUsers", "--repo", memos, "--output", join(project, "refused.json")], { cwd: project, encoding: "utf8" });
if (refused.status !== 4 || !refused.stderr.includes("ASSESSMENT_REVISION_MISSING")) {
  console.error(`appworks extract accepted an unpinned assessment (${refused.status}): ${refused.stderr}`);
  process.exit(1);
}
console.log("  ok  appworks extract refuses an assessment without a source revision (exit 4, ASSESSMENT_REVISION_MISSING)");
const pinned = join(scratch, "memos-pinned");
cpSync(memos, pinned, { recursive: true });
mkdirSync(join(pinned, ".git"));
writeFileSync(join(pinned, ".git", "HEAD"), `${"1".repeat(40)}\n`);
const pinnedBefore = listing(pinned);
run(bin, ["assess", pinned, "--output", join(project, "pinned-assessment.json")], { cwd: project });
const extracted = run(bin, ["extract", join(project, "pinned-assessment.json"), "--candidate", "cand-memos.api.UserService.ListUsers", "--repo", pinned, "--output", join(project, "extraction.json")], { cwd: project });
process.stdout.write(`${extracted.stdout.trimEnd().split("\n").slice(0, 4).join("\n").replace(/^/gm, "  | ")}\n`);
run(bin, ["verify-extraction", join(project, "extraction.json"), "--assessment", join(project, "pinned-assessment.json"), "--repo", pinned], { cwd: project });
if (listing(pinned) !== pinnedBefore) {
  console.error("the repository changed during extraction");
  process.exit(1);
}
writeFileSync(join(project, "extraction.mjs"), `
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fromJSONSchema } from "@appport/schema";
import { EXTRACTION_FORMAT, verifyExtraction, verifyExtractionAt } from "@appport/extraction";
const check = (ok, message) => { if (!ok) { console.error("FAIL", message); process.exit(1); } console.log("  ok ", message); };
const require = createRequire(import.meta.url);
const schema = fromJSONSchema(JSON.parse(readFileSync(require.resolve("@appport/extraction/package.json").replace(/package\\.json$/, "schemas/capability-extraction-2.schema.json"), "utf8")));
const x = JSON.parse(readFileSync("extraction.json", "utf8"));
check(x.format === EXTRACTION_FORMAT && x.stage === "proposed" && x.fulfillment === null && x.adapter === null && x.verification.summary.passed === 0 && schema.validate(x).ok, "the installed CLI proposes an extraction: no adapter, nothing verified, schema-valid");
const memos = JSON.parse(readFileSync(${JSON.stringify(join(root, "extractions", "memos-reactions", "revisions", "2", "extraction.json"))}, "utf8"));
check(schema.validate(memos).ok && verifyExtractionAt(memos, { planDirectory: ${JSON.stringify(join(root, "extractions", "memos-reactions"))} }).ok, "the committed Memos extraction (revision 2, declared claim) verifies against its adapter and declaration sources with the installed library");
x.scope.grantsAuthority = true;
check(!verifyExtraction(x).ok, "an extraction claiming authority is refused");
`);
process.stdout.write(run("node", ["extraction.mjs"], { cwd: project }).stdout);
console.log(`\nRelease check passed (${project})`);
