/**
 * @appport/recipe — business recipes: the `appport.recipe/1` source model, validation, dependency locks and source
 * packages (spec/recipe-1.md).
 *
 * Built on published AppPort packages. Executes nothing, selects no provider, grants no authority, and has no
 * dependency on Distribution Protocol or any registry.
 */
export * from "./source.js";
export * from "./expression.js";
export * from "./validate.js";
export * from "./lock.js";
export * from "./package.js";
export { lintRecipeRules, type RuleIssue, type RuleSource } from "./rules.js";
export {
  CANONICAL_CONTRACT_EXTENSION,
  isCanonicalContract,
  isCanonicalDependencyTarget,
  type CanonicalDependencyTarget,
  type FulfillmentStatus,
  type RecipeDependency
} from "./appport-compat.js";
