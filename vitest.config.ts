import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to their sources; AppPort and Distribution Protocol resolve to the published packages
// installed in node_modules, never to a sibling checkout.
export default defineConfig({
  resolve: {
    alias: {
      "@appport/assessment": r("./packages/assessment/src/index.ts"),
      "@appport/extraction": r("./packages/extraction/src/index.ts"),
      "@appport/recipe": r("./packages/recipe/src/index.ts"),
      "@appport/recipe-distribution": r("./packages/recipe-distribution/src/index.ts"),
      "@appport/recipe-runtime": r("./packages/recipe-runtime/src/index.ts"),
      "@appport/workspace": r("./packages/workspace/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    // These start real OS processes and kill them. They run alone, in sequence, under vitest.processes.config.ts
    // (`pnpm test` runs both): beside the rest of the suite their processes starve it of CPU and time out its tests.
    exclude: ["**/node_modules/**", "packages/recipe-runtime/test/conformance.test.ts", "packages/recipe-runtime/test/workers.test.ts"],
    environment: "node",
    testTimeout: 20000
  }
});
