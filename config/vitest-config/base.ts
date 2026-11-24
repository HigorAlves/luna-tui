import { defineConfig } from "vitest/config";

/**
 * The settings every package's tests share; a package merges its own on top with `mergeConfig`.
 * Deliberately not `passWithNoTests`: a package whose tests stop being found must fail, not pass.
 */
export const baseConfig = defineConfig({
  test: {},
});
