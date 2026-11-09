// A scenario that only runs one of the repository's own commands and expects it to pass ("when `pnpm board:test` runs, then it exits 0")
// is a check, not a behaviour: no test can fail for it before the code exists, so Build's tests step does not ask for one. The sweep
// and Verify run the command once the code is there. Pure.

/** The repo's commands: each package.json script as a package manager runs it, each luna.yaml check's line, and the toolchains' own test and lint commands. */
export function repoCommandsOf(scripts: readonly string[], checkRuns: readonly string[], workspaces: readonly { name: string; dir: string; scripts: readonly string[] }[] = []): string[] {
  const run = scripts.flatMap((name) => [`pnpm ${name}`, `pnpm run ${name}`, `npm run ${name}`, `npm ${name}`, `yarn ${name}`, `bun run ${name}`]);
  // A workspace package's script, run from the root: `pnpm --filter site typecheck` (the site card's checks were not recognised without these).
  const inWorkspace = workspaces.flatMap((w) =>
    w.scripts.flatMap((script) => [`pnpm --filter ${w.name} ${script}`, `pnpm --filter ${w.name} run ${script}`, `pnpm -F ${w.name} ${script}`, `pnpm --filter ./${w.dir} ${script}`, `npm --workspace ${w.name} run ${script}`, `npm -w ${w.name} run ${script}`, `yarn workspace ${w.name} ${script}`]),
  );
  const toolchains = ["cargo test", "cargo clippy", "cargo build", "cargo fmt", "go test", "go vet", "pytest"];
  return [...new Set([...run, ...inWorkspace, ...checkRuns.map((r) => r.trim()).filter(Boolean), ...toolchains])];
}

const PASSES = /\b(exits? (?:with )?(?:code )?0|exit code (?:is )?0|pass(?:es)?|clean|succeeds?|no (?:warnings|errors|failures)|green)\b/i;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the scenario's `when` runs one of `commands` (as a whole word run) and its `then` only asks that it pass. */
export function isCommandCheck(scenario: { when?: string | null; then?: string | null }, commands: readonly string[]): boolean {
  const when = scenario.when ?? "";
  const then = scenario.then ?? "";
  if (!when || !PASSES.test(then)) return false;
  return commands.some((command) => new RegExp(`(^|[\\s\`'"(])${escape(command)}(?=$|[\\s\`'".,;:)])`).test(when));
}
