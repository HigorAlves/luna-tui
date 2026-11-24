import { baseConfig } from "@hardness/vitest-config/base";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Multiple test files share one Postgres database (freshTestDatabase() drops and
      // recreates its schema in each file's beforeAll). Running files in parallel races
      // that schema recreation against another file's migrations — serialize them instead.
      fileParallelism: false,
      // Every answer the tests see is held to GET /openapi.json (src/test/openapi-conformance.ts).
      setupFiles: ["src/test/openapi-conformance.ts"],
    },
  }),
);
