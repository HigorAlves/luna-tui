---
name: agent-browser
description: Browser automation CLI for AI agents; use for web tasks - navigate, click, fill forms, screenshot, scrape, test web/Electron apps.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with
accessibility-tree snapshots and compact `@eN` element refs.

## Factory mode

In factory mode (LUNA_FACTORY=1) the e2e stage runs this skill as Driver A of
`browser-qa`, inside a container that already has:

- the `agent-browser` CLI on `PATH` (no install step; `agent-browser --version` confirms it);
- Playwright's Chromium, which the CLI drives through `AGENT_BROWSER_EXECUTABLE_PATH` (already set — never override it);
- `ffmpeg`, so `agent-browser record` produces a real WebM.

The QA target comes from the stage prompt: its **name**, its **base URL**, and
credential **references** you resolve from the environment inline in the
command that consumes them (`agent-browser fill @e3 "$QA_ADMIN_PASSWORD"`),
never printed and never written to a packet file (see `qa-targets`).

The evidence packet lives under **`/out/files/qa/`** (write nothing else outside
`/work` and `/out`): `qa-manifest.json` (the spine — top-level `verdict`,
`driver: "agent-browser"`, `artifacts[]`, `curated[]`, one `acceptance[]` row
per criterion), per-step and per-criterion screenshots, `console.log`,
`network.har`, `snapshot-final.txt`, `steps.md`, and the WebM recording for a
visual change. The stage answers with its JSON result built from the manifest
rows; nobody is asked anything along the way.

## Start here

This file is a discovery stub, not the usage guide. Before running any
`agent-browser` command, load the actual workflow content from the CLI:

```bash
agent-browser skills get core             # start here — workflows, common patterns, troubleshooting
agent-browser skills get core --full      # include full command reference and templates
```

The CLI serves skill content that always matches the installed version,
so instructions never go stale. The content in this stub cannot change
between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task falls outside browser web pages:

```bash
agent-browser skills get electron          # Electron desktop apps (VS Code, Slack, Discord, Figma, ...)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA / bug hunts
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox microVMs
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

Run `agent-browser skills list` to see everything available on the
installed version.

## QA references (e2e stage, Driver A)

- [QA-RECIPES.md](references/QA-RECIPES.md): command shapes per workflow step (open, record, walk, edge cases, capture).
- [STEPS-TEMPLATE.md](references/STEPS-TEMPLATE.md): the `steps.md` narrative template.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP; needs no Playwright or Puppeteer library, only a browser binary (the container points it at Playwright's Chromium)
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers
