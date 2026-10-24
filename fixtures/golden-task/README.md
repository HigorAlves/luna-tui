# Golden task fixture

A tiny repo with one seeded bug, used by `machine/scripts/golden-task.mjs` as the
regression check for the whole pipeline (see [docs/install.md](../../docs/install.md)).
The script copies this directory into a fresh git repo per run, so edit the bug
here, not in a copy.

The bug: `formatPrice` in `src/cart.js` uses `toFixed(1)` instead of `toFixed(2)`,
so round amounts lose their second decimal (`$1.00` shows as `$1.0`). `npm test`
fails until it's fixed.
