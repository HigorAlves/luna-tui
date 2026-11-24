export const installCommands = [
  "git clone https://github.com/HigorAlves/luna-tui && cd luna-tui",
  "pnpm install",
  "pnpm board:build && herdr plugin link ./apps/board",
  "MACHINE_GITHUB_POLL=you/repo pnpm start",
]

