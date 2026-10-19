import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to their sources; AppPort and Distribution Protocol resolve to the published packages
// installed in node_modules, never to a sibling checkout.
export default defineConfig({
  resolve: {
    alias: {
      "@appport/recipe": r("./packages/recipe/src/index.ts"),
      "@appport/recipe-distribution": r("./packages/recipe-distribution/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000
  }
});
