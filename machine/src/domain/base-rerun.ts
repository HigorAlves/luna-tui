// What Verify needs to ask "does this check fail on the base too?": the test files a red run names, and the same check narrowed to those files,
// so the base re-run costs a few seconds and not the whole suite. Pure; the stage runs the commands.
const COLOUR = /\u001b\[[0-9;]*m/g;
/** A failing test file: `FAIL file.test.ts > name`, with an optional `|project|` label before the file. */
const FAIL_LINE = /\bFAIL\s+(?:\|[^|\s]*\|\s+)?([\w@./-]+\.(?:test|spec)\.\w+)/;
/** Past this many failing files the cause is not one test: an environment fault (no database) fails them all, and the whole check is the better question. */
export const FILES_CAP = 20;

/** The test files a check's output names as failing, once each, in order; empty when none is named or there are more than `FILES_CAP`. */
export function failingTestFiles(text: string): string[] {
  const files = new Set<string>();
  for (const line of text.replace(COLOUR, "").split("\n")) {
    const match = FAIL_LINE.exec(line);
    if (match) files.add(match[1]!);
  }
  return files.size > FILES_CAP ? [] : [...files];
}

const quote = (value: string): string => `'${value}'`;
/** A script a package manager runs, with its arguments and no shell syntax of its own. */
const PLAIN_SCRIPT = /^(?:cd '[^']*' && )?(pnpm|yarn|bun|npm|npx)\s[^|;&<>`$()\n]*$/;
const SAFE_FILE = /^[\w@./ -]+$/;

/**
 * The check's command with the files appended, so only those files run; null when the line cannot be narrowed safely (a pipeline, several
 * commands, a runner that is not a package manager, a file name that could be read as an option or a quote), and then the whole check runs.
 * A test script takes its files after its name (pnpm, yarn, bun); npm needs `--` first.
 */
export function narrowedArgv(argv: string[], files: string[]): string[] | null {
  if (files.length === 0 || !files.every((f) => SAFE_FILE.test(f) && !f.startsWith("-"))) return null;
  if (argv[0] === "sh" && argv[1] === "-c" && argv.length === 3) {
    const match = PLAIN_SCRIPT.exec(argv[2]!);
    if (!match) return null;
    const dashes = match[1] === "npm" ? " --" : "";
    return ["sh", "-c", `${argv[2]}${dashes} ${files.map(quote).join(" ")}`];
  }
  if (argv[0] && ["pnpm", "yarn", "bun", "npm", "npx"].includes(argv[0])) return [...argv, ...(argv[0] === "npm" ? ["--"] : []), ...files];
  return null;
}
