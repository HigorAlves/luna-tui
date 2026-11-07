---
name: code-discovery
description: Use when discovering or navigating a codebase before planning, implementing, debugging, or refactoring — query the repository's read-only Graphify code graph at /graph first, and fall back to Glob, Grep and Read when there is none or the prompt says it is stale.
---

# Code Discovery

Discovery — finding the code relevant to a task before changing it — is the largest easily-wasted token cost in a stage. The machine keeps one [Graphify](https://github.com/Graphify-Labs/graphify) code graph per repository, built from the default branch, and mounts it **read-only** at `/graph`. Query it and `Read` only the cited `source_location`s instead of grepping the tree. Every step below is guarded and **falls back to plain Glob/Grep/Read** — discovery never hard-blocks on the graph.

## The protocol

1. **Detect.** The `Code graph:` line of your prompt names the graph file (`/graph/graphify-out/graph.json`) and says whether it is fresh; `LUNA_GRAPH` holds the same path. `(none…)`, an unset `LUNA_GRAPH` or a missing file → step 4. When a `Branch graph:` line follows it (`LUNA_GRAPH_BRANCH`, read-only at `/graph-branch`), that graph holds this card's own commits: pass its path to `--graph` first (`--graph branch`) and the main graph's path for the rest (`--graph main`). A stage never builds or updates a graph: `/graph` is read-only, and the machine rebuilds it when the default branch moves.
2. **Freshness comes from the prompt.** `(fresh)`: trust it for where things are. `(stale: …)`: the base commit is newer than the graph, so use it for leads only and `Grep` the areas the task changes.
3. **Query-first.** Answer structural questions by traversal, most-specific verb first, always with `--graph` and the literal path (the bash tool does not expand variables):
   ```bash
   graphify query "where is auth wired to the database?" --graph /graph/graphify-out/graph.json --budget 1500
   graphify explain "RateLimiter" --graph /graph/graphify-out/graph.json
   graphify path "UserService" "DatabasePool" --graph /graph/graphify-out/graph.json
   graphify affected "processRefund" --depth 2 --graph /graph/graphify-out/graph.json   # reverse blast radius: leads, not verdicts
   graphify god-nodes --graph /graph/graphify-out/graph.json
   ```
   Then `Read` only the cited `source_location`s. Noisy answer → raise `--budget` or rephrase before abandoning the graph. Verify every cited caller by reading it. A verb that errors or emits unparseable output → treat the graph as unavailable for that question and fall back.
4. **Fallback** (none / stale area / failed / empty): `Glob` candidates, `Grep` symbols, `Read` immediate dependencies. Graceful degradation, not an error.

## Honesty rules

- Never claim you used the graph when you grepped, or vice-versa.
- The graph points; the code decides — read cited sources before asserting.
- Never claim "all callers handled" from graph output alone, least of all from a stale graph.

Deep detail — verb catalog and caveats, `--budget` discipline: [GRAPHIFY.md](references/GRAPHIFY.md) (this body is self-sufficient).
