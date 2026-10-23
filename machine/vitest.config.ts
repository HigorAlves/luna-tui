import { defineConfig } from "vitest/config";

// Database tests share one Postgres database, so test files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });
