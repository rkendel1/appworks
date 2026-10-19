// Compiled against the INSTALLED declarations only (skipLibCheck: false): @appport/recipe and @appport/recipe-distribution
// from their packed tarballs, AppPort from the registry.
import { createRecipeLock, validateRecipe, type RecipeLock, type RecipeSource, type RecipeValidation, type ResolvedDependencyRecord } from "@appport/recipe";
import { acceptAcquiredRecipePackage, type RecipePackageAcceptance } from "@appport/recipe-distribution";
import type { AppPortManifest, Dependency } from "@appport/protocol";
import type { ResolvedDependency } from "@appport/core";

export const v: (s: RecipeSource) => RecipeValidation = (s) => validateRecipe(s);
// A recipe's dependencies are AppPort's own Dependency type.
export const requires: (s: RecipeSource) => Dependency[] = (s) => s.requires;
// AppPort's published resolvedDependency() record is what a lock is built from.
export const lock = (s: RecipeSource, contracts: Record<string, AppPortManifest>, records: Record<string, ResolvedDependency>): RecipeLock => {
  const asRecords: Record<string, ResolvedDependencyRecord> = records;
  return createRecipeLock(s, { contracts, resolutions: asRecords });
};
export type A = RecipePackageAcceptance;
export const a = acceptAcquiredRecipePackage;

// @appport/assessment: its proposed capability shape is AppPort's own published CapabilityVersionEntry, not a copy.
import { assessRepository, verifyAssessment, type ApplicationAssessment, type ProposedCapability } from "@appport/assessment";
import type { CapabilityVersionEntry } from "@appport/protocol";
export const assess: (root: string) => ApplicationAssessment = (root) => assessRepository(root);
export const ok: (value: unknown) => boolean = (value) => verifyAssessment(value).ok;
export const asEntry = (p: ProposedCapability): Pick<CapabilityVersionEntry, "version" | "kind" | "inputSchema" | "outputSchema" | "effect"> => p;
