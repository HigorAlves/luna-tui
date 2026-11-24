# Graphify deep reference (code-discovery)

Elaboration for the `code-discovery` protocol. The SKILL.md body is operationally complete; read this only when you need the reasoning or the full verb surface.

## Verb catalog

Every verb reads the stage's graph with `--graph /graph/graphify-out/graph.json` (a stage never builds one):

```bash
graphify query "<natural-language question>" --graph <graph> --budget 1500   # BFS/DFS traversal; --budget caps answer tokens
graphify explain "<Symbol>" --graph <graph>                                  # what one symbol is and connects to
graphify path "<A>" "<B>" --graph <graph>                                    # shortest path between two concepts
graphify affected "<Symbol>" --depth 2 --graph <graph>                       # reverse blast-radius: who calls / what breaks
graphify god-nodes --graph <graph>                                           # architectural hubs (degree centrality)
```

The graph is built outside the stage: AST-only, no model, from the repository's default branch (the `built at <sha>` in the prompt is that commit), and rebuilt by the machine when the branch moves. `extract`, `update` and `check-update` are not available to a stage.

## `affected` / `god-nodes` caveats

- Output shape: `affected` prints each impacted node as `- <symbol> [<relation>] <file>:<line>` — read the cited spans.
- They are **leads, not verdicts**: candidate callers and load-bearing hubs, far faster than grep — but they do not license a completeness claim. Some edges are `INFERRED`; verify each cited caller by reading it before asserting anything about it.
- Never state "all callers handled / nothing else affected" from graph output alone — least of all from a graph the prompt calls stale. A stale graph can omit a new caller or list a deleted one; a confident-but-wrong answer is worse than none.

## `--budget` discipline

Keep query answers capped (`--budget 1500` default). If a query returns noise, raise the budget or rephrase against the graph's own node/community names before falling back to grep — don't reflexively abandon the graph.

## Version tolerance

Graphify is pre-1.0 and its CLI surface moves. A command that errors, exits non-zero, or returns unparseable output means the graph is unavailable *for that question* — degrade to a slower answer, never to a wrong one.
