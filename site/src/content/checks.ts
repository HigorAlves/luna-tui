export const checks = [
  { command: "pnpm golden --selftest", note: "three fixtures, six tickets: seed red, patch green" },
  { command: "pnpm smoke:sandbox", note: "orc packs run under the hardened flags" },
  { command: "pnpm golden --matrix", note: "graded end to end, nightly" },
  { command: "pnpm golden:live", note: "abort · retry · concurrency against a real machine" },
]
