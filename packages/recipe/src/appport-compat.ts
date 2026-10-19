/**
 * The AppPort surface AppWorks needs that the **published** AppPort packages do not yet provide.
 *
 * AppWorks builds against published `@appport/protocol`, `@appport/schema` and `@appport/integration` 1.1.0. The
 * canonical-capability work (rkendel1/appport#276, #277) is merged on AppPort `main` but unreleased, so 1.1.0 has no
 * canonical-contract marker check and no canonical dependency target. Everything below is either a wire-format constant
 * those changes define, or a check of the shape they define, kept minimal and in one place. None of it re-implements
 * fulfillment evaluation, resolution, compatibility or linting: those are used from the published packages, or are the
 * environment's job.
 *
 * When AppPort publishes the canonical-capability release, replace each item as noted and delete this module
 * (docs/compatibility.md §3).
 */
import { isVersionConstraint, parseDependencyRef, type AppPortManifest } from "@appport/protocol";

/**
 * The extension a canonical capability contract advertises (AppPort `fulfillment-1` §2).
 * Replace with `CANONICAL_CONTRACT_EXTENSION` from `@appport/protocol`.
 */
export const CANONICAL_CONTRACT_EXTENSION = "appport.canonical-contract/1" as const;

/** Replace with `isCanonicalContract` from `@appport/protocol`. */
export function isCanonicalContract(manifest: Pick<AppPortManifest, "extensions">): boolean {
  return manifest.extensions?.includes(CANONICAL_CONTRACT_EXTENSION) ?? false;
}

/**
 * A dependency on a capability of a canonical contract (AppPort `dependencies-1` §3, canonical targets). The
 * wire shape is AppPort's; published `@appport/protocol` 1.1.0 types `Dependency.target` without it.
 * Replace with `Dependency` and `CanonicalDependencyTarget` from `@appport/protocol`.
 */
export interface CanonicalDependencyTarget {
  contract: string;
  capability: string;
  provider?: string;
}

/** A recipe dependency: AppPort's `Dependency` with a canonical target. */
export interface RecipeDependency {
  id: string;
  relationship: "invokes" | "observes" | "delegates" | "consumes-event";
  target: CanonicalDependencyTarget | { application?: string; capability: string } | { application?: string; event: string };
  required: boolean;
  versionConstraint?: string;
  purpose?: string;
}

/** Replace with `isCanonicalDependencyTarget` from `@appport/protocol`. */
export function isCanonicalDependencyTarget(target: RecipeDependency["target"]): target is CanonicalDependencyTarget {
  return typeof (target as { contract?: unknown } | undefined)?.contract === "string";
}

const DEPENDENCY_RELATIONSHIPS = ["invokes", "observes", "delegates", "consumes-event"];

/**
 * Checks dependency declarations with canonical targets by the rules AppPort's `lintIntegration` applies to them on
 * `main` (`descriptor.requires[i]…` paths, same messages). Published 1.1.0 `lintIntegration` predates canonical targets
 * and would read one as a same-application capability, so it cannot be used for them yet.
 * Replace with `lintIntegration` from `@appport/protocol` on a manifest carrying the dependencies.
 */
export function lintCanonicalDependencies(dependencies: readonly unknown[], self: string): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  const error = (path: string, message: string) => issues.push({ path, message });
  const ids = new Set<string>();
  dependencies.forEach((value, index) => {
    const path = `descriptor.requires[${index}]`;
    const dependency = value as Partial<RecipeDependency> | null;
    if (dependency === null || typeof dependency !== "object") return error(path, "a dependency is an object");
    if (typeof dependency.id !== "string" || !dependency.id) error(path, "a dependency needs an id");
    else if (ids.has(dependency.id)) error(path, `duplicate dependency id "${dependency.id}"`);
    else ids.add(dependency.id);
    if (!DEPENDENCY_RELATIONSHIPS.includes(dependency.relationship as string)) error(path, `relationship must be one of ${DEPENDENCY_RELATIONSHIPS.join(", ")}`);
    if (typeof dependency.required !== "boolean") error(path, "required must be true or false");
    if (dependency.versionConstraint !== undefined && !isVersionConstraint(dependency.versionConstraint)) error(`${path}.versionConstraint`, "not a valid version constraint");
    const target = dependency.target as Partial<CanonicalDependencyTarget> & { application?: unknown; event?: unknown } | undefined;
    if (!target || typeof target !== "object") return error(path, "a dependency needs a target");
    if (target.contract === undefined) return; // not canonical: the recipe rules refuse it separately
    if (typeof target.contract !== "string" || !target.contract) error(`${path}.target.contract`, "must be a canonical contract id");
    else if (target.contract === self) error(`${path}.target.contract`, "an application is not a canonical contract");
    if (target.application !== undefined || target.event !== undefined) error(`${path}.target`, "a canonical target names a contract and a capability, not an application or event");
    if (target.provider !== undefined && (typeof target.provider !== "string" || !target.provider)) error(`${path}.target.provider`, "must be an application id");
    if (dependency.relationship === "consumes-event") return error(path, "consumes-event targets an event");
    const ref = typeof target.capability === "string" ? parseDependencyRef(target.capability) : undefined;
    if (!ref) return error(`${path}.target.capability`, "must be name or name@version");
    if (ref.version === undefined && dependency.versionConstraint === undefined) error(path, "an unpinned target needs a versionConstraint");
  });
  return issues;
}

/**
 * AppPort's fulfillment status (AppPort `fulfillment-1` §4), as `resolvedDependency()` records carry it. Published
 * `@appport/core` 1.2.0 predates the record, which a lock reads structurally (./lock.ts).
 * Replace with `FulfillmentStatus` from `@appport/protocol`.
 */
export type FulfillmentStatus = "valid" | "unverified" | "stale" | "invalid";

