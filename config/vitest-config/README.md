# @hardness/vitest-config

The vitest settings every package shares. A package merges its own on top:

```ts
import { baseConfig } from "@hardness/vitest-config/base";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(baseConfig, defineConfig({ test: { fileParallelism: false } }));
```
