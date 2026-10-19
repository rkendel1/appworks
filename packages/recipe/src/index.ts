/**
 * @appport/recipe — business recipes: the `appport.recipe/1` source model, validation, dependency locks and source
 * packages (spec/recipe-1.md).
 *
 * Built on the published AppPort packages `@appport/protocol` 1.2.0, `@appport/schema` 1.1.1 and `@appport/integration`
 * 1.2.0. Executes nothing, selects no provider, grants no authority, and has no dependency on Distribution Protocol or any
 * registry.
 */
export * from "./source.js";
export * from "./expression.js";
export * from "./validate.js";
export * from "./lock.js";
export * from "./package.js";
