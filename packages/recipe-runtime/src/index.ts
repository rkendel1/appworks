/**
 * @appport/recipe-runtime: durable execution of validated `appport.recipe/1` recipes (spec/runtime-1.md).
 *
 * Capabilities are reached only through AppPort (`@appport/core`): resolved, authorized and invoked afresh for every
 * call. State is FeltDB's. A run never reports success without independent verification, and never invokes a
 * consequential capability a second time for a step whose first invocation's outcome is unknown. Private; it does not
 * import `@appport/workspace`.
 */
export * from "./model.js";
export * from "./gateway.js";
export * from "./appport-gateway.js";
export * from "./engine.js";
export { applyRules } from "./rules.js";
export { unsupportedConstructs } from "./support.js";
