// Finds the project's own test, lint and type-check commands in a worktree.
import { readFile as read } from "node:fs/promises";
import { join } from "node:path";

export type Manager = "pnpm" | "npm" | "yarn" | "go" | "python" | "make" | "cargo";
export type Argv = string[];

export interface DetectedChecks {
  test?: Argv;
  lint?: Argv;
  typecheck?: Argv;
  manager: Manager | null;
}

/** File access relative to the worktree; injected so detection is testable over a file map. */
export interface DetectFs {
  readFile(name: string): Promise<string | null>;
  exists(name: string): Promise<boolean>;
}

export const diskFs = (root: string): DetectFs => ({
  readFile: (name) => read(join(root, name), "utf8").catch(() => null),
  exists: (name) =>
    read(join(root, name)).then(
      () => true,
      () => false,
    ),
});

const TYPECHECK_SCRIPTS = ["typecheck", "type-check", "tsc"];

export async function detectChecks(worktreePath: string, fs: DetectFs = diskFs(worktreePath)): Promise<DetectedChecks> {
  const pkgText = await fs.readFile("package.json");
  if (pkgText !== null) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = JSON.parse(pkgText).scripts ?? {};
    } catch {
      // unreadable package.json: no scripts
    }
    const manager: Manager = (await fs.exists("pnpm-lock.yaml"))
      ? "pnpm"
      : (await fs.exists("yarn.lock"))
        ? "yarn"
        : "npm";
    const run = (name: string): Argv => [manager, "run", name];
    const found: DetectedChecks = { manager };
    if (typeof scripts.test === "string") found.test = run("test");
    if (typeof scripts.lint === "string") found.lint = run("lint");
    const tc = TYPECHECK_SCRIPTS.find((name) => typeof scripts[name] === "string");
    if (tc) found.typecheck = run(tc);
    return found;
  }
  if (await fs.exists("go.mod")) {
    return { manager: "go", test: ["go", "test", "./..."], lint: ["go", "vet", "./..."] };
  }
  if (await fs.exists("Cargo.toml")) return { manager: "cargo", test: ["cargo", "test"] };
  const pyproject = await fs.readFile("pyproject.toml");
  if (pyproject !== null || (await fs.exists("pytest.ini"))) {
    const found: DetectedChecks = { manager: "python", test: ["pytest", "-q"] };
    if ((pyproject !== null && /\[tool\.ruff/.test(pyproject)) || (await fs.exists("ruff.toml"))) {
      found.lint = ["ruff", "check", "."];
    }
    return found;
  }
  const makefile = await fs.readFile("Makefile");
  if (makefile !== null) {
    const has = (target: string) => new RegExp(`^${target}\\s*:`, "m").test(makefile);
    const found: DetectedChecks = { manager: "make" };
    if (has("test")) found.test = ["make", "test"];
    if (has("lint")) found.lint = ["make", "lint"];
    if (found.test || found.lint) return found;
  }
  return { manager: null };
}
