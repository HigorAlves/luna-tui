# QA recipes (e2e stage, Driver A)

Command shapes for each step of the Driver A walk in `browser-qa`. `agent-browser skills get core` is the source of truth for the installed version; prefer it when the two disagree. The packet directory is `/out/files/qa/` throughout; `<url>` is the resolved target's base URL from the stage prompt.

## Open, capture, record

```bash
mkdir -p /out/files/qa
agent-browser open <url>
agent-browser network har start

# record start succeeds optimistically; only record stop fails without ffmpeg
command -v ffmpeg >/dev/null 2>&1 && \
  agent-browser record start "/out/files/qa/qa-<sanitized-branch>.webm"

agent-browser set viewport 375 667 2          # iPhone-ish
agent-browser set device "iPhone 14"          # or a named device
```

## Sign in (named target with users)

Credentials are references resolved from the environment inside the command that types them — never echoed, never in a packet file, never in the stage answer:

```bash
agent-browser find label "Email" fill "$QA_ADMIN_USER"
agent-browser find label "Password" fill "$QA_ADMIN_PASSWORD"
agent-browser find role button click --name "Sign in"
agent-browser wait --url "**/dashboard"
```

Record it in `steps.md` as `Auth: signed in as admin (target <name>)`. An unresolvable reference makes the affected criteria `partial` with the reason, never a silent skip.

## Walk a step

```bash
agent-browser snapshot                                           # accessibility tree with @eN refs
agent-browser screenshot --annotate "/out/files/qa/screenshot-NN-<step-slug>.png"
agent-browser screenshot --annotate "/out/files/qa/ac-<idx>-<criterion-slug>.png"  # at the moment a criterion is observable

agent-browser click @e2
agent-browser fill @e3 "test@example.com"
agent-browser press Enter

agent-browser find role button click --name "Submit"             # semantic locators when refs are unstable
agent-browser find label "Email" fill "test@example.com"

agent-browser wait --text "Welcome"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle

agent-browser batch "open <url>" "snapshot" "screenshot --annotate /out/files/qa/screenshot-01-loaded.png"
```

## Edge cases

- Validation errors: submit empty required fields and wrong formats; screenshot the inline error.
- Empty state: a fresh user, or a stubbed API.
- Failure state:

```bash
agent-browser network route "**/api/billing" --abort
agent-browser network route "**/api/billing" --body '{"error":"server"}'
```

- Loading or suspense: throttle the network (project-dependent; DevTools or Chrome flags).
- Auth states: signed-in and signed-out when the change applies to both.
- Guarded target (`guard: true`): mutating scenarios are scored `partial` with note `guarded target` — never executed, never dropped.

## Capture artifacts

```bash
agent-browser network har stop "/out/files/qa/network.har"
agent-browser console > "/out/files/qa/console.log"
agent-browser snapshot > "/out/files/qa/snapshot-final.txt"
command -v ffmpeg >/dev/null 2>&1 && agent-browser record stop   # before close, or the file is lost
agent-browser close
```

Then write `steps.md` (template: [STEPS-TEMPLATE.md](STEPS-TEMPLATE.md)) and `qa-manifest.json`; the stage answer's `criteria[]` is built from the manifest rows, with `evidence[]` paths relative to `/out` (`files/qa/ac-1-export-202.png`).

Optional GIF for ticket embedding (a GIF renders inline in Jira; a WebM does not):

```bash
ffmpeg -y -i "/out/files/qa/qa-<branch>.webm" -vf "fps=8,scale=960:-1:flags=lanczos" \
  "/out/files/qa/qa-<branch>.gif" || echo "gif conversion failed — webm stands"
```

Optional, never required:

- Chrome DevTools trace: `agent-browser trace start "/out/files/qa/trace.json"` … `agent-browser trace stop`.
- React render profile: `agent-browser react renders start` / `stop --json > "/out/files/qa/react-renders.json"`.
- Web Vitals: `agent-browser vitals --json > "/out/files/qa/vitals.json"`.
