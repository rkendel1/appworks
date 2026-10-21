/**
 * Loading a recipe from an installed package (spec/distribution-1.md §6). The runtime reads the install record
 * (`appworks.recipe-install/1`) that `@appport/recipe-distribution` wrote, but does not import that package: the format is the
 * contract. Nothing is trusted from the directory itself: the package bytes are re-hashed and re-loaded against the digest
 * the record names, and the lock is re-checked against the recipe, every time a run starts. A source checkout is never read.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRecipeLock, loadRecipePackage, type RecipeLock, type RecipeSource } from "@appport/recipe";
import type { JsonValue } from "@appport/protocol";
import { RuntimeError } from "./model.js";

const INSTALL_FORMAT = "appworks.recipe-install/1";

export interface InstalledRecipe {
  recipe: RecipeSource;
  /** Recorded on the run: which package, release and lock it executes. */
  origin: JsonValue;
}

export function loadInstalledRecipe(dir: string): InstalledRecipe {
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : undefined);
  const recordBytes = read("install.json");
  if (!recordBytes) throw new RuntimeError("RECIPE_INVALID", `${dir} is not an installed package (no install.json)`);
  const record = JSON.parse(recordBytes.toString("utf8")) as {
    format?: string;
    release?: { id: string; publisher: string };
    package?: { recipe: string; digest: string };
    lock?: { digest: string };
  };
  if (record.format !== INSTALL_FORMAT || !record.package || !record.release || !record.lock) throw new RuntimeError("RECIPE_INVALID", `${dir}/install.json is not an ${INSTALL_FORMAT} record`);
  const bytes = read("package.bin");
  const lockBytes = read("lock.json");
  if (!bytes || !lockBytes) throw new RuntimeError("RECIPE_INVALID", `${dir} is missing its package or lock`);

  const loaded = loadRecipePackage(new Uint8Array(bytes), { digest: record.package.digest, recipe: record.package.recipe });
  if (!loaded.ok || !loaded.package) throw new RuntimeError("RECIPE_INVALID", `the installed package no longer is the package it was installed as: ${loaded.findings.map((f) => f.code).join(", ")}`, { findings: loaded.findings });
  const lockDigest = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
  if (lockDigest !== record.lock.digest) throw new RuntimeError("RECIPE_INVALID", "the installed lock does not match the digest in the install record");
  const checked = checkRecipeLock(JSON.parse(lockBytes.toString("utf8")) as RecipeLock, loaded.package.recipe);
  if (!checked.ok) throw new RuntimeError("RECIPE_INVALID", `the installed lock does not match the recipe: ${checked.findings.map((f) => f.code).join(", ")}`, { findings: checked.findings });

  return {
    recipe: loaded.package.recipe,
    origin: { kind: "installed-package", package: record.package.digest, recipe: record.package.recipe, release: record.release.id, publisher: record.release.publisher, lock: record.lock.digest }
  };
}
