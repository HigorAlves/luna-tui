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
    },
  }),
);
