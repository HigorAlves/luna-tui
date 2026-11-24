// One command line as the argv of one process, for a runtime that runs commands without a shell
// (eve). Quotes and backslashes are read as a shell reads them, so `git commit -m "a b"` means
// what it says; anything a shell would act on (expansion, substitution, globs, redirection,
// pipes, chaining, groups, comments, a home directory) is refused instead of passed on as text,
// so a command never means one thing to the guard and another to the process.

export type Argv = { argv: string[] } | { refused: string };

/** Characters a shell would act on anywhere in an unquoted word. */
const META = new Set(["$", "`", "|", "&", ";", "<", ">", "(", ")", "{", "}", "*", "?", "[", "]", "\n"]);

const refuse = (what: string, hint = "quote it ('...') if it is meant literally"): Argv => ({
  refused: `${what}: commands here run as one process, not a shell: no pipes, redirection, substitution, globs or chaining; run one command per call, ${hint}`,
});

/** The argv a command line stands for, or why it is refused. */
export function splitArgv(command: string): Argv {
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  const end = (): void => {
    if (inWord) argv.push(word);
    word = "";
    inWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return refuse("an unterminated ' quote", "close the quote");
      word += command.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j] as string;
        if (d === "\\" && j + 1 < command.length && '"\\$`\n'.includes(command[j + 1] as string)) {
          if (command[j + 1] !== "\n") word += command[j + 1];
          j++;
        } else if (d === "$" || d === "`") {
          return refuse(`\`${d}\` inside double quotes would expand in a shell`, "use single quotes for a literal $ or `");
        } else {
          word += d;
        }
      }
      if (j >= command.length) return refuse('an unterminated " quote', "close the quote");
      i = j;
    } else if (c === "\\") {
      if (next === undefined) return refuse("a trailing \\", "remove it");
      if (next !== "\n") word += next;
      inWord = true;
      i++;
    } else if (c === " " || c === "\t") {
      end();
    } else if (META.has(c)) {
      return refuse(`\`${c === "\n" ? "\\n" : c}\` is shell syntax`);
    } else if (c === "#" && !inWord) {
      return refuse("`#` starts a comment in a shell");
    } else if (c === "~" && (!inWord || word.endsWith("=") || word.endsWith(":"))) {
      return refuse("`~` names a home directory in a shell", "name the path from the worktree instead");
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  if (argv.length === 0) return { refused: "an empty command: name the command to run" };
  return { argv };
}
