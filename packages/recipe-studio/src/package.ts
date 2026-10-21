/**
 * Packaging: the Studio's one hand-off to the existing lifecycle. It builds the package with the function `appworks package
 * publish` itself uses (`packageForPublish`), so the digest announced here is the digest that command will publish, writes the
 * canonical bytes next to the recipe, and checks them with the package loader before saying so. It then stops: signing,
 * publishing, trust, acquisition, installation and running are the existing commands', with their own checks, and the Studio
 * holds no key, no trust policy and no grant to do any of them with.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecipeLockError, RecipePackageError, loadRecipePackage, serializeRecipePackage, validateRecipe, type RecipeSource } from "@appport/recipe";
import { packageForPublish } from "@appport/recipe-distribution";
import type { StudioEnvironment } from "./environment.js";
import { recipeDigestOf, type StudioStore } from "./project.js";

export const PACKAGE_FILE = "recipe.package.json";

export type PackageStage = "source" | "environment" | "lock";

export type PackageResult =
  | {
      ok: true;
      digest: string;
      recipe: string;
      file: string;
      size: number;
      /** A source package is never executable: running is the runtime's decision, at start, from the installed package. */
      executable: false;
      /** The existing commands that carry this package on. `<…>` is the operator's: a key, a channel, a policy. */
      next: string[];
    }
  | { ok: false; stage: PackageStage; reasons: string[] };

export async function packageProject(store: StudioStore, slug: string, environment: StudioEnvironment, now: () => Date = () => new Date()): Promise<PackageResult> {
  const project = store.open(slug);
  const source = validateRecipe(project.recipe);
  if (!source.sourceOk) return { ok: false, stage: "source", reasons: source.findings.filter((f) => f.scope === "source" && f.severity === "error").map((f) => `${f.code} at ${f.path || "/"}: ${f.message}`) };
  const recipe = project.recipe as RecipeSource;

  let pkg;
  try {
    const snapshot = await environment.gateway.snapshot(recipe.requires);
    pkg = packageForPublish(recipe, snapshot, { file: store.recipePath(slug) });
  } catch (error) {
    if (error instanceof RecipeLockError) return { ok: false, stage: "lock", reasons: [...error.problems, "a package pins the contract revisions it was written against; open the recipe in an environment that holds them"] };
    if (error instanceof RecipePackageError) return { ok: false, stage: "source", reasons: [...error.problems] };
    return { ok: false, stage: "environment", reasons: [`the environment could not be inspected: ${(error as Error).message}`] };
  }

  const bytes = serializeRecipePackage(pkg);
  // Loaded back exactly as a consumer will load it: the digest recomputed from the bytes, the recipe validated again.
  const loaded = loadRecipePackage(bytes, { digest: pkg.digest, recipe: recipe.id });
  if (!loaded.ok) return { ok: false, stage: "source", reasons: loaded.findings.map((f) => `${f.code}: ${f.message}`) };

  const file = join(project.dir, PACKAGE_FILE);
  const tmp = `${file}.tmp-${randomUUID()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  store.recordPackage(slug, { digest: pkg.digest, packagedAt: now().toISOString(), lock: pkg.lock, recipeDigest: recipeDigestOf(recipe) });

  const product = project.meta.release.product ?? "<product://namespace/slug>";
  const version = project.meta.release.version ?? "<semver>";
  return {
    ok: true,
    digest: pkg.digest,
    recipe: recipe.id,
    file,
    size: bytes.byteLength,
    executable: false,
    next: [
      `appworks package publish ${store.recipePath(slug)} --channel <dir> --product ${product} --version ${version} --key <dir> --environment <module>`,
      `appworks package verify --channel <dir> --product ${product} --version ${version} --digest ${pkg.digest} --policy <file> --recipe ${recipe.id}`,
      `appworks package install --channel <dir> --product ${product} --version ${version} --digest ${pkg.digest} --policy <file> --store <dir> --environment <module>`,
      `appworks recipe run --package <installed-dir> --input <json|@file> --environment <module>`
    ]
  };
}

export interface PackageCheck {
  ok: boolean;
  digest?: string;
  /** The package file is the one that was made, and still is the package it claims to be. */
  findings: string[];
  /** The recipe has been edited since this package was made. */
  stale: boolean;
}

/** Re-reads the written package and checks it against the digest recorded when it was made, and against the recipe as it stands. */
export function checkPackageFile(store: StudioStore, slug: string): PackageCheck {
  const project = store.open(slug);
  const last = project.meta.lastPackage;
  const file = join(project.dir, PACKAGE_FILE);
  if (!last || !existsSync(file)) return { ok: false, findings: ["no package has been made for this recipe"], stale: false };
  const loaded = loadRecipePackage(new Uint8Array(readFileSync(file)), { digest: last.digest });
  return { ok: loaded.ok, ...(loaded.identity ? { digest: loaded.identity.digest } : {}), findings: loaded.findings.map((f) => `${f.code}: ${f.message}`), stale: last.recipeDigest !== recipeDigestOf(project.recipe) };
}
