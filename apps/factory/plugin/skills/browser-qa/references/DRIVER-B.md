# Driver B — live browser extension (not available in factory mode)

Disclosed from `browser-qa`. This driver binds a browser extension to a person's own Chrome session and narrates each step to them as they watch. In factory mode (LUNA_FACTORY=1) there is no person and no extension, so `browser-qa` never selects it; it is kept so the chrome-mode evidence packet it defines stays documented for a future interactive runner.

## What the driver does

1. Load the extension tools in one call: tab context, navigate, computer, read page, create tab, read console messages, read network requests, GIF recorder (+ form input when the flow has forms). If the extension is not connected, fall back to Driver A and note the switch — never silently.
2. **Create a NEW tab** for the base URL — never drive existing tabs. Start a GIF recording (name it `qa-<sanitized-branch>.gif`, capture extra frames around each action). Avoid any element that triggers JS `alert`/`confirm` dialogs — they freeze the extension; test those paths under Driver A instead.
3. Walk the **same golden path + edge cases** Driver A prescribes (validation errors, empty state, failure state where reachable without request mocking, auth states), **driven by the step-2 acceptance criteria**. Number every step. When a step is the moment a criterion becomes observable, say so — that step number is the criterion's evidence anchor.
4. Capture the chrome-mode evidence packet into `<qa-dir>` via `Write`:
   - `qa-<branch>.gif` — the recording (replaces per-step screenshot files)
   - `qa-manifest.json` — the packet spine: `driver: "chrome"`, artifacts, curated selection, and one `acceptance[]` row per criterion
   - `snapshot-final.txt` — final page read output
   - `console.log` — console output (filter noise but state the filter used)
   - `network-summary.md` — distilled network output: method, endpoint, status per request + notable bodies (replaces `network.har`)
   - `steps.md` — same template and verdict rules as Driver A, with a `### Step <N>` heading per narrated step
5. Same verdict handling: `pass` → proceed; `fail`/`partial` → surface with the failing step + console/network line.

**Chrome-mode evidence trade-off, stated plainly:** the extension returns screenshots into the conversation and `Write` cannot emit binary, so chrome mode produces **no per-criterion PNG on disk**. A criterion's `evidence[]` entry is therefore `qa-<branch>.gif#step-<N>`, pointing at the numbered `### Step <N>` heading in `steps.md`. That is weaker than Driver A's annotated per-criterion shot — it is the cost of watching live, not a loophole. Every criterion still gets a result and an anchor.
