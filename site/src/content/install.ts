export const installCommands = [
  "git clone https://github.com/HigorAlves/luna-tui && cd luna-tui",
  "pnpm install && pnpm db:up",
  "pnpm --filter @hardness/machine runner:build",
  "pnpm board:build && herdr plugin link ./board",
  "MACHINE_GITHUB_POLL=you/repo pnpm dev",
]

export const installOutput = "machine listening on http://127.0.0.1:4317 · real stages: triage, test_design, implementing, verifying, e2e, …"
