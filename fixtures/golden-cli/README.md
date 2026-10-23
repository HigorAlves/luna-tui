# Golden CLI fixture

A tiny Go tool used by the golden matrix (`machine/scripts/golden-task.mjs --matrix`).
The seeded bug: `Run` overwrites a name's total instead of adding to it. `.golden/` holds
the tickets, the reference patches and the hidden acceptance tests. The matrix never
copies `.golden/` into the repo the agent works on.
