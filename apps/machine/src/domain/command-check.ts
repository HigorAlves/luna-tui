// A scenario that only runs one of the repository's own commands and expects it to pass ("when `pnpm board:test` runs, then it exits 0")
// is a check, not a behaviour: no test can fail for it before the code exists, so Build's tests step does not ask for one. The sweep
// and Verify run the command once the code is there. Pure.

/** The repo's commands: each package.json script as a package manager runs it, each luna.yaml check's line, the toolchains' own test and lint
 *  commands, each script file of the repo as tsx, node or a shell runs it, and a script whose name has a colon (`test:unit`) said bare. */
export function repoCommandsOf(scripts: readonly string[], checkRuns: readonly string[], workspaces: readonly { name: string; dir: string; scripts: readonly string[] }[] = [], scriptFiles: readonly string[] = []): string[] {
  const run = scripts.flatMap((name) => [`pnpm ${name}`, `pnpm run ${name}`, `npm run ${name}`, `npm ${name}`, `yarn ${name}`, `bun run ${name}`]);
  // A workspace package's script, run from the root: `pnpm --filter site typecheck` (the site card's checks were not recognised without these).
  const inWorkspace = workspaces.flatMap((w) =>
    w.scripts.flatMap((script) => [`pnpm --filter ${w.name} ${script}`, `pnpm --filter ${w.name} run ${script}`, `pnpm -F ${w.name} ${script}`, `pnpm --filter ./${w.dir} ${script}`, `npm --workspace ${w.name} run ${script}`, `npm -w ${w.name} run ${script}`, `yarn workspace ${w.name} ${script}`]),
  );
  const toolchains = ["cargo test", "cargo clippy", "cargo build", "cargo fmt", "go test", "go vet", "pytest"];
  // A script file of the repo, run directly ("yarn tsx scripts/cycle-inventory.mts --check"): the file is the repo's own, listed from the user's checkout.
  const files = scriptFiles.flatMap((file) => {
    const shell = /\.sh$/.test(file);
    const runners = shell ? ["bash", "sh"] : ["yarn tsx", "pnpm tsx", "pnpm exec tsx", "npx tsx", "tsx", "yarn node", "node"];
    return [...runners.map((runner) => `${runner} ${file}`), `./${file}`];
  });
  // A script said by its name alone ("test:unit runs"): only a name with a colon, which prose does not have; "the test runs" is not the `test` script.
  const bare = [...scripts, ...workspaces.flatMap((w) => w.scripts)].filter((name) => name.includes(":"));
  return [...new Set([...run, ...inWorkspace, ...checkRuns.map((r) => r.trim()).filter(Boolean), ...toolchains, ...files, ...bare])];
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
