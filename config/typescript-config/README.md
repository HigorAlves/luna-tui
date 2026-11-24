# @hardness/typescript-config

The tsconfig presets every package extends.

- `base.json`: the Node packages (contracts, factory, machine, evals). Erasable TypeScript that Node and tsx run straight from source, so `noEmit` and `allowImportingTsExtensions`.
- `nextjs.json`: Next.js apps (site).

A package extends a preset and keeps its own `include` (paths in a preset resolve against the preset's folder, not the package's):

```jsonc
{ "extends": "@hardness/typescript-config/base.json", "include": ["src"] }
```
