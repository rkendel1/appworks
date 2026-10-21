import base from "./vitest.config.js";

// The tests that start real OS processes and kill them with SIGKILL (packages/recipe-runtime conformance and workers).
// One file at a time, so a worker process never competes with another test for the CPU it needs to finish in time.
// The test options are replaced, not merged: merging would concatenate the base's `exclude`, which names these very files.
export default {
  ...base,
  test: {
    environment: "node",
    include: ["packages/recipe-runtime/test/conformance.test.ts", "packages/recipe-runtime/test/workers.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 180000
  }
};
