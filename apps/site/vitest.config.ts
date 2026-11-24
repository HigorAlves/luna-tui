import { fileURLToPath } from "node:url"
import { baseConfig } from "@hardness/vitest-config/base"
import { defineConfig, mergeConfig } from "vitest/config"

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["src/test/setup.ts"] },
  }),
)
