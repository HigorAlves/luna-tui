// What a command line's exit status says of the test runs in it, and what a runner's own summary says
// when it says nothing. A line's status is its last command's, so `npm test | tail`, `pytest || true`
// and `pytest; echo "exit=$?"` exit 0 whatever the tests did; for those the summary, then the output's
// markers, decide. Ported from TokenEconomizer's turn reader (`status_of_tests`, `exit_status_covers`,
// `runner_verdict`), with its patterns (RFC 0007).
import path from "node:path";

export const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*['"]?(\w+)['"]?[^\n]*\n.*?\n\s*\1\b/gs;

const VERIFY_RE = new RegExp(
  "^(?:^|[\\s;&|(])(?:(?:~?/)?(?:[\\w.\\-]+/)*python\\d?(?:\\.\\d+)?\\s+)?" +
    "(?:~?/)?(?:[\\w.\\-]+/)*(?:pytest|py\\.test|tox|nox|python\\d?(?:\\.\\d+)?\\s+-m\\s+(?:pytest|unittest)|" +
    "manage\\.py\\s+test|runtests(?:\\.py)?|jest|vitest|mocha|ava|playwright\\s+test|" +
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test|go\\s+test|cargo\\s+(?:test|nextest)|" +
    "(?:mvn|mvnw|\\./mvnw)\\s+(?:\\S+\\s+)*test|(?:gradle|gradlew|\\./gradlew)\\s+(?:\\S+\\s+)*test|" +
    "make\\s+(?:test|check)|ctest|rspec|phpunit|dotnet\\s+test|swift\\s+test|mix\\s+test|" +
    "deno\\s+test|node\\s+--test|bazel\\s+test|(?:\\./)?bin/test)(?![\\w.\\-/])",
  "i",
);
const QUOTED_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const SEP_RE = /(&&|\|\||\|&|(?<!>)\||;|\n)/;
// A runner asked for its help, version or test list, not to run the tests.
const NOT_A_RUN_RE = /\s(?:-h|--help|--version|--collect-only|--co|--list\S*)(?!\S)/;
// What may precede the command itself: assignments, `timeout 60`, and a launcher that runs it in the project's environment.
const PREFIX_RE = new RegExp(
  "^\\s*(?:(?:\\w+=\\S*|time|nice|nohup|command|env|" +
    "timeout(?:\\s+(?:-\\S+|[A-Z]+|\\d\\S*))+|" +
    "(?:(?:uv|poetry|pipenv|pdm|hatch|rye)\\s+run|npx|bunx|(?:npm|pnpm|yarn)\\s+(?:exec|dlx)|bundle\\s+exec|xvfb-run)(?:\\s+-\\S+)*|" +
    "dotenv(?:\\s+(?!--(?:\\s|$))\\S+)*\\s+--)\\s+)*",
);
// What only reports on the run before it: `echo "exit=$?"`, `true`, `exit 0`.
const REPORT_RE = /^\s*(?:echo|printf|true|:|exit)(?:\s|$)/;
const RANK = { own: 0, hidden: 1, mixed: 2 } as const;
export type TestStatus = keyof typeof RANK;

/** Commands whose own failure does not matter to the loop guard: they read, move about, set up or report. */
const QUIET_HEADS = new Set([
  "cat", "head", "tail", "less", "more", "wc", "sort", "uniq", "cut", "tr", "nl", "column", "ls", "tree", "pwd", "stat", "file", "du",
  "which", "type", "whereis", "grep", "egrep", "fgrep", "rg", "ag", "jq", "find", "echo", "printf", "true", ":", "cd", "pushd", "popd",
  "export", "source", ".", "set", "sed", "git",
]);
const GIT_READS = new Set(["show", "diff", "log", "status", "grep", "ls-files", "blame", "rev-parse", "branch"]);

/** A command line as `[cmd, sep, cmd, ...]`, quoted text masked and heredoc bodies left out, and whether it sets `pipefail`. The caller has unwrapped a `sh -c`. */
function pieces(cmd: string): { parts: string[]; pipefail: boolean } {
  const text = cmd.replace(HEREDOC_RE, (m) => `${m.split("\n")[0]} <heredoc>`);
  const parts = text.replace(QUOTED_RE, "Q").replace(/[(){}]/g, " ").split(SEP_RE);
  while (parts.length > 1 && !(parts[parts.length - 1] as string).trim()) parts.splice(-2, 2);
  return { parts, pipefail: cmd.includes("pipefail") };
}

function quiet(stage: string): boolean {
  const words = `${stage.trim()} `.replace(PREFIX_RE, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const head = path.posix.basename(words[0] as string);
  if (!QUIET_HEADS.has(head)) return false;
  if (head === "git") return words.length > 1 && GIT_READS.has(words[1] as string);
  if (head === "sed") return !words.slice(1).some((w) => /^(?:-[a-zA-Z]*i|--in-place)/.test(w));
  if (head === "find") return !words.slice(1).some((w) => ["-delete", "-exec", "-execdir", "-ok"].includes(w));
  return true;
}

const keepsStatus = (sep: string, pipefail: boolean): boolean => sep === "&&" || (pipefail && (sep === "|" || sep === "|&"));

/** Whether the line's exit status says if the work it ran failed: not when a command that does work could have failed unseen (`python repro.py | tail`). */
export function exitStatusCovers(cmd: string): boolean {
  if (!cmd.trim()) return false;
  const { parts, pipefail } = pieces(cmd);
  for (let i = 0; i < parts.length - 1; i += 2) {
    if (keepsStatus(parts[i + 1] as string, pipefail)) continue;
    if (!quiet(parts[i] as string)) return false;
  }
  return true;
}

/** What the status says of the test runs in the line: undefined when there are none; `own` when it is theirs; `hidden` when a pipe, `||` or a mere report replaced it; `mixed` when other commands ran after. */
export function statusOfTests(cmd: string): TestStatus | undefined {
  const { parts, pipefail } = pieces(cmd);
  let found: TestStatus | undefined;
  for (let i = 0; i < parts.length; i += 2) {
    const stage = parts[i] as string;
    if (!VERIFY_RE.test(stage.replace(PREFIX_RE, "")) || NOT_A_RUN_RE.test(stage)) continue;
    let status: TestStatus = "own";
    for (let j = i + 1; j + 1 < parts.length; j += 2) {
      const sep = parts[j] as string;
      const then = parts[j + 1] as string;
      if (keepsStatus(sep, pipefail)) continue;
      if (sep === "|" || sep === "|&" || sep === "||") {
        status = "hidden";
        break;
      }
      if (!REPORT_RE.test(then)) {
        status = "mixed";
        break;
      }
      status = "hidden";
    }
    if (found === undefined || RANK[status] > RANK[found]) found = status;
  }
  return found;
}

// A test runner's summary of its run, which holds whatever the command line's exit status.
export const RUN_FAILED_RE = new RegExp(
  [
    String.raw`\b[1-9]\d* (?:failed|errors?)\b.*\bin \d+(?:\.\d+)?s\b`, // pytest
    String.raw`^FAILED \((?:failures|errors)=`, // unittest, Django
    String.raw`^tests finished:.*\b[1-9]\d* (?:failed|exceptions?)\b`, // sympy's bin/test
    String.raw`^# fail [1-9]`, // TAP (`node --test`)
    String.raw`^Tests:.*\b[1-9]\d* failed\b`, // jest
    String.raw`^\s*Tests\s+[1-9]\d* failed\b`, // vitest
    String.raw`^\s*[1-9]\d* failing\b`, // mocha
    String.raw`^\s*[1-9]\d* failed\s*$`, // Playwright
    String.raw`^(?:--- FAIL: |FAIL\t|FAIL$)`, // go
    String.raw`^test result: FAILED`, // cargo
    String.raw`\b\d+ examples?, [1-9]\d* failures?\b`, // rspec
    String.raw`Tests run: \d+, Failures: (?:[1-9]|0, Errors: [1-9])`, // JUnit (Maven, Gradle)
    String.raw`BUILD FAIL(?:URE|ED)`,
  ].join("|"),
  "m",
);
const RUN_PASSED_RE = new RegExp(
  [
    String.raw`\b\d+ passed\b.*\bin \d+(?:\.\d+)?s\b`,
    String.raw`^OK(?: \(.*\))?\s*$`,
    String.raw`^tests finished: \d+ passed`,
    String.raw`^# fail 0\b`,
    String.raw`^Tests:\s+\d+ passed`,
    String.raw`^\s*Tests\s+\d+ passed`,
    String.raw`^\s*\d+ passing\b`,
    String.raw`^\s*\d+ passed \(\d+(?:\.\d+)?(?:ms|s|m|h)\)`, // Playwright
    String.raw`^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))`,
    String.raw`^test result: ok\.`,
    String.raw`\b\d+ examples?, 0 failures\b`,
    String.raw`BUILD SUCCESS`,
  ].join("|"),
  "m",
);

/** True when a runner's summary in the text says its run failed, false when one says it passed (and none failed), undefined when there is no summary. */
export function runnerVerdict(text: string): boolean | undefined {
  if (!text) return undefined;
  if (RUN_FAILED_RE.test(text)) return true;
  return RUN_PASSED_RE.test(text) ? false : undefined;
}
