// The words the token economy's observer reads a command with, and the one grammar a command spelling in a learned fact must fit. The
// factory's observer builds every form it reports from these lists; the machine, which cannot import from the factory, checks a form from the
// container against them again, so a fact never states a command the observer could not have written (RFC 0007).

export const INTERPRETERS: ReadonlySet<string> = new Set(["python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "tsx", "ts-node", "ruby", "perl", "php", "Rscript", "julia", "lua", "elixir"]);
export const RUNNER_HEADS: ReadonlySet<string> = new Set(["pytest", "py.test", "tox", "nox", "nosetests", "trial", "jest", "vitest", "mocha", "playwright", "cypress", "ava", "karma", "rspec", "phpunit", "ctest", "bats"]);
export const RUNNER_SCRIPTS: readonly string[] = ["runtests.py", "bin/test", "bin/doctest", "manage.py"];
export const RUNNER_MODULES: ReadonlySet<string> = new Set(["pytest", "unittest", "nose", "django", "tox", "nox"]);
export const PACKAGE_TOOLS: ReadonlySet<string> = new Set([
  "pip", "pip3", "conda", "mamba", "poetry", "pipenv", "uv", "apt", "apt-get", "npm", "yarn", "pnpm", "corepack",
  "gem", "bundle", "composer", "cargo", "go", "mvn", "gradle", "dotnet", "brew", "rustup", "pyenv", "nvm", "asdf",
]);
export const TASK_HEADS: ReadonlySet<string> = new Set(["make", "npm", "yarn", "pnpm", "cargo", "go", "mvn", "gradle", "gradlew", "dotnet", "mix", "swift", "rake"]);
export const BUILD_HEADS: ReadonlySet<string> = new Set([
  "make", "cmake", "ninja", "bazel", "tsc", "eslint", "prettier", "ruff", "flake8", "pylint", "mypy", "pyright", "black", "isort",
  "golangci-lint", "gcc", "g++", "clang", "javac", "webpack", "vite", "pre-commit", "shellcheck",
]);
export const BUILD_SUBS: ReadonlySet<string> = new Set(["build", "check", "compile", "lint", "vet", "typecheck", "type-check", "clippy", "package", "verify", "fmt", "format"]);
export const SCRIPT_HEADS: ReadonlySet<string> = new Set(["npm", "yarn", "pnpm", "bun"]);
/** A versioned interpreter (`python3.11`, `node18`). */
export const INTERP_VERSIONED_RE = /^(?:python|node)\d(?:\.\d+)?$/;
/** The tools whose `<tool> run` (or `exec`) launches the command that follows; the observer writes it as `<tool> run`. */
export const LAUNCH_RUN_TOOLS: ReadonlySet<string> = new Set(["poetry", "pipenv", "uv", "npx", "bundle", "yarn", "pnpm"]);

const FORM = /^[A-Za-z0-9 ._:=/@+-]{1,120}$/;
const WORD = /^[\w.-]+$/;
/** Option words that point a command at another package, index, code or plugin: never in a stated command. */
const BANNED_ARGS = ["--registry", "--index-url", "--extra-index-url", "-i", "--from", "--package", "-p", "--yes", "-y", "--call", "-c", "-e", "--eval", "--require", "-r"];
const MAX_ARGS = 3;

const baseName = (head: string): string => head.slice(head.lastIndexOf("/") + 1);
const clean = (token: string | undefined): token is string => token !== undefined && token !== "" && !token.includes("://") && !/@[\dv]/.test(token) && !token.split("/").includes("..");

function head(t: readonly string[], at: number): boolean {
  const first = t[at];
  if (!clean(first)) return false;
  const base = baseName(first);
  const args = t.slice(at + 1);
  if (args.length > MAX_ARGS || args.some((a) => !clean(a) || a.includes("@") || BANNED_ARGS.some((b) => a.startsWith(b)))) return false;
  if (INTERPRETERS.has(base) || INTERP_VERSIONED_RE.test(base)) {
    if (args.length === 0) return true;
    if (args[0] === "-m") return args[1] !== undefined && (RUNNER_MODULES.has(args[1]) || BUILD_HEADS.has(args[1]));
    return !(args[0] as string).startsWith("-") && RUNNER_SCRIPTS.some((s) => (args[0] as string).endsWith(s));
  }
  if (RUNNER_HEADS.has(base) || BUILD_HEADS.has(base)) return true;
  if (!TASK_HEADS.has(base) && !PACKAGE_TOOLS.has(base) && !SCRIPT_HEADS.has(base)) return false;
  if (args.length === 0) return true;
  const sub = args[0] as string;
  if (sub === "test" || BUILD_SUBS.has(sub)) return true;
  const script = args[1];
  return SCRIPT_HEADS.has(base) && sub === "run" && script !== undefined && ((script.split(":")[0] as string) === "test" || BUILD_SUBS.has(script.split(":")[0] as string));
}

/** Whether `form` is a command spelling the observer could have written: `[cd <path>] [source|conda activate <env>] [launcher] <known head> [at most three plain arguments]`. A launcher is followed directly by a known head, so `npx jest` is one and `npx some-package` is not. The observer drops `&&`, so a prefixed form reads `cd sub pytest`. */
export function knownForm(form: string): boolean {
  if (!FORM.test(form)) return false;
  const t = form.split(" ");
  if (t.some((w) => w === "")) return false;
  let i = 0;
  while (i < 6) {
    if (t[i] === "cd" && clean(t[i + 1])) i += 2;
    else if ((t[i] === "source" || t[i] === "conda") && t[i + 1] === "activate" && WORD.test(t[i + 2] ?? "")) i += 3;
    else break;
  }
  if (i >= t.length) return false;
  const launched: number[] = [];
  if (t[i] === "conda" && t[i + 1] === "run" && t[i + 2] === "-n" && WORD.test(t[i + 3] ?? "")) launched.push(i + 4);
  else if (LAUNCH_RUN_TOOLS.has(t[i] as string) && t[i] !== "npx" && t[i + 1] === "run") launched.push(i + 2);
  else if (t[i] === "pipx" && t[i + 1] === "run") launched.push(i + 2);
  else if (t[i] === "npx" || t[i] === "uvx") launched.push(i + 1);
  // A form with no launcher is tried too: `yarn run build` is a task before it is a launcher.
  return [...launched, i].some((at) => head(t, at));
}
