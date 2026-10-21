/**
 * @appport/recipe-distribution: the boundary between AppWorks recipe packages and Distribution Protocol (spec/distribution-1.md).
 * Release manifests and acceptance of acquired bytes (`release.ts`), a file channel (`channel.ts`), publishing, acquisition and
 * installation into an environment. Distribution Protocol owns signatures, trust, digests, acquisition and receipts; this package
 * owns what is inside the artifact and what installing it means. Nothing here grants authorization or runs a recipe.
 */
export * from "./release.js";
export * from "./channel.js";
export * from "./publish.js";
export * from "./acquire.js";
export * from "./install.js";
