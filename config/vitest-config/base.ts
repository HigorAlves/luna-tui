import { defineConfig } from "vitest/config";

/** The settings every package's tests share; a package merges its own on top with `mergeConfig`. */
export const baseConfig = defineConfig({
  test: {
    passWithNoTests: true,
  },
});
