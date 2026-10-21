/**
 * Studio projects (README, "What is saved"). A project is a directory:
 *
 * - `recipe.json`: the canonical `appport.recipe/1` source, and nothing else. It is the source of truth and the exact file
 *   `appworks package publish` reads; the Studio has no recipe format of its own. A draft may be invalid: it is saved as it is.
 * - `studio.json`: what is not part of the recipe: a revision counter for lost-update detection, the release the author intends
 *   (a distribution product and version: a recipe has no version, a release does), and the last package made, for noticing
 *   that a capability's contract has changed since.
 *
 * Provider bindings, grants and trust are not saved here, because they are not the recipe's: they belong to an environment, are
 * read from it every time, and a project opened in another environment shows that environment's.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { digestOf } from "@appport/protocol";
import type { RecipeLock } from "@appport/recipe";

export const STUDIO_FORMAT = "appworks.recipe-studio/1" as const;
export const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

export interface ReleaseIntent {
  /** `product://namespace/slug`, as `appworks package publish --product` takes it. */
  product?: string;
  /** SemVer of the release. Immutable once published: Distribution Protocol, not the Studio, refuses a second, different one. */
  version?: string;
}

export interface LastPackage {
  digest: string;
  packagedAt: string;
  /** The portable lock the package carries: canonical identities only. */
  lock: RecipeLock;
  /** `digestOf` the recipe that was packaged, to tell whether it has been edited since. */
  recipeDigest: string;
}

export interface StudioMeta {
  format: typeof STUDIO_FORMAT;
  revision: number;
  savedAt: string;
  release: ReleaseIntent;
  lastPackage?: LastPackage;
}

export interface StudioProject {
  slug: string;
  dir: string;
  /** The recipe as saved: possibly incomplete or invalid. */
  recipe: unknown;
  meta: StudioMeta;
}

export class StudioError extends Error {
  constructor(readonly code: "NOT_FOUND" | "EXISTS" | "CONFLICT" | "INVALID", message: string) {
    super(message);
    this.name = "StudioError";
  }
}

export const recipeBytes = (recipe: unknown): string => `${JSON.stringify(recipe, null, 2)}\n`;

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export class StudioStore {
  constructor(readonly root: string, private readonly now: () => Date = () => new Date()) {}

  dirOf(slug: string): string {
    if (!SLUG.test(slug)) throw new StudioError("INVALID", `a project name is lowercase letters, digits and hyphens, starting with a letter (got "${slug}")`);
    return join(this.root, slug);
  }

  recipePath(slug: string): string {
    return join(this.dirOf(slug), "recipe.json");
  }

  list(): Array<{ slug: string; recipeId?: string; name?: string; revision: number; savedAt: string }> {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((slug) => SLUG.test(slug) && existsSync(join(this.root, slug, "studio.json")))
      .sort()
      .map((slug) => {
        const p = this.open(slug);
        const r = p.recipe as { id?: unknown; name?: unknown } | null;
        return { slug, ...(typeof r?.id === "string" ? { recipeId: r.id } : {}), ...(typeof r?.name === "string" ? { name: r.name } : {}), revision: p.meta.revision, savedAt: p.meta.savedAt };
      });
  }

  create(slug: string, recipe: unknown, release: ReleaseIntent = {}): StudioProject {
    const dir = this.dirOf(slug);
    if (existsSync(join(dir, "studio.json"))) throw new StudioError("EXISTS", `project "${slug}" already exists`);
    mkdirSync(dir, { recursive: true });
    return this.write(slug, recipe, { format: STUDIO_FORMAT, revision: 1, savedAt: this.now().toISOString(), release });
  }

  /** Imports an existing recipe file as a project. Importing is saving: it grants and installs nothing. */
  import(slug: string, text: string, release: ReleaseIntent = {}): StudioProject {
    let recipe: unknown;
    try {
      recipe = JSON.parse(text);
    } catch {
      throw new StudioError("INVALID", "the file is not JSON");
    }
    return this.create(slug, recipe, release);
  }

  open(slug: string): StudioProject {
    const dir = this.dirOf(slug);
    if (!existsSync(join(dir, "studio.json")) || !existsSync(join(dir, "recipe.json"))) throw new StudioError("NOT_FOUND", `no project "${slug}"`);
    let meta: StudioMeta;
    let recipe: unknown;
    try {
      meta = JSON.parse(readFileSync(join(dir, "studio.json"), "utf8")) as StudioMeta;
      recipe = JSON.parse(readFileSync(join(dir, "recipe.json"), "utf8"));
    } catch {
      throw new StudioError("INVALID", `project "${slug}" is not readable: recipe.json or studio.json is not JSON`);
    }
    if (meta.format !== STUDIO_FORMAT) throw new StudioError("INVALID", `project "${slug}" is not an ${STUDIO_FORMAT} project`);
    return { slug, dir, recipe, meta };
  }

  /**
   * Saves a new revision of the recipe. `expectRevision` is the revision the author was looking at: a save over a newer one is
   * refused, never merged, so nothing anyone saved is silently lost. The recipe is written as given, valid or not.
   */
  save(slug: string, recipe: unknown, expectRevision: number, patch: { release?: ReleaseIntent } = {}): StudioProject {
    const current = this.open(slug);
    if (current.meta.revision !== expectRevision) throw new StudioError("CONFLICT", `"${slug}" is at revision ${current.meta.revision}, not ${expectRevision}: reopen it and apply the change again`);
    return this.write(slug, recipe, { ...current.meta, revision: current.meta.revision + 1, savedAt: this.now().toISOString(), release: { ...current.meta.release, ...patch.release } });
  }

  /** Records the package just made, so a later contract change can be noticed. Not a revision of the recipe. */
  recordPackage(slug: string, pkg: LastPackage): StudioProject {
    const current = this.open(slug);
    writeAtomic(join(current.dir, "studio.json"), `${JSON.stringify({ ...current.meta, lastPackage: pkg }, null, 2)}\n`);
    return this.open(slug);
  }

  private write(slug: string, recipe: unknown, meta: StudioMeta): StudioProject {
    const dir = this.dirOf(slug);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "recipe.json"), recipeBytes(recipe));
    writeAtomic(join(dir, "studio.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return this.open(slug);
  }

  remove(slug: string): void {
    rmSync(this.dirOf(slug), { recursive: true, force: true });
  }
}

/** The digest of a recipe as the lock and package machinery see it, independent of key order or formatting. */
export const recipeDigestOf = (recipe: unknown): string => digestOf(recipe as never);
