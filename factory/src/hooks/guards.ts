// In-process PreToolUse guards for a stage running headless through the Agent SDK. The
// container is the real boundary (no credentials for push, /work mounted read-only for
// read-only stages); these guards exist so the model learns *why* an action is refused
// instead of burning turns on a cryptic EACCES, and so the few things the container cannot
// stop (a commit with an AI trailer, a commit on the wrong branch, a `gh pr create` with the
// token the stage legitimately holds for reading) are refused before they happen. There is
// no human to ask, so a guard either denies with a reason phrased for the model or stays
// silent; it never asks.
import { posix } from "node:path";

import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { StageInput } from "@hardness/contracts";

export interface GuardContext {
  /** Whether this stage may edit the worktree and commit. */
  writable: boolean;
  /** Branches the stage may commit to must start with this (default "task/"). */
  branchPrefix?: string;
  /** The current branch, when known, so a commit on the wrong branch is refused before git runs. */
  branch?: string | null;
  /** Where the worktree and the run's output folder are (defaults /work and /out; a host run moves them). */
  workRoot?: string;
  outRoot?: string;
}

const WORK = "/work";
const OUT = "/out";
const TMP = "/tmp";
const DEFAULT_BRANCH_PREFIX = "task/";

/** The branches a stage may commit to: a PR task owns the PR's own head branch; a task the
 *  machine gave a branch outside `task/` (a Jira-linked one, `bug/PLAT-123` by its repo's
 *  pattern) owns exactly that branch; every other task a `task/` branch. */
export function branchPrefixFor(task: Pick<StageInput["task"], "branch" | "source">): string {
  if (task.source?.kind === "github_pr" && task.source.headRef) return task.source.headRef;
  if (task.branch && !task.branch.startsWith(DEFAULT_BRANCH_PREFIX)) return task.branch;
  return DEFAULT_BRANCH_PREFIX;
}

// ---------------------------------------------------------------------------------------
// Command parsing. A quote-aware scanner rather than a regex split: the attribution check
// reads the commit message, and a message split on an inner `;` would hide its tail.
// ---------------------------------------------------------------------------------------

/** One simple command, as whitespace-split tokens with the shell quoting removed. */
type SimpleCommand = string[];
/** The simple commands joined by `|` in one pipeline. */
type Pipeline = SimpleCommand[];

/** Splits a command string into pipelines (`&&`, `||`, `;`, `&`, newline) and each pipeline
 *  into its simple commands (`|`, `|&`), honouring quotes and backslashes. Subshell and group
 *  punctuation (`(`, `)`, `$(`, backticks, `{`, `}`) is treated as whitespace so a guarded
 *  command wrapped in one is still seen. */
function parseCommand(command: string): Pipeline[] {
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  const endToken = (): void => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endCommand = (): void => {
    endToken();
    if (tokens.length > 0) pipeline.push(tokens);
    tokens = [];
  };
  const endPipeline = (): void => {
    endCommand();
    if (pipeline.length > 0) pipelines.push(pipeline);
    pipeline = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const next = command[i + 1];
    const prev = command[i - 1];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
      } else if (c === "\\" && quote === '"' && next !== undefined) {
        token += next;
        i++;
      } else {
        token += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\" && next !== undefined) {
      token += next;
      inToken = true;
      i++;
    } else if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      i++;
      endPipeline();
    } else if (c === "|") {
      if (next === "&") i++;
      endCommand();
    } else if (c === "&" && (prev === ">" || prev === "<" || next === ">")) {
      // `2>&1`, `&>file`: part of a redirection, not a background separator.
      token += c;
      inToken = true;
    } else if (c === ";" || c === "\n" || c === "&") {
      endPipeline();
    } else if (c === "$" && next === "(") {
      i++;
      endToken();
    } else if (c === "(" || c === ")" || c === "`" || c === "{" || c === "}") {
      endToken();
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      token += c;
      inToken = true;
    }
  }
  endPipeline();
  return pipelines;
}

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "exec", "nohup", "time", "builtin"]);
const WRAPPER_FLAGS_WITH_ARG = new Set(["-u", "-g"]);

/** Drops leading env assignments (`FOO=1`) and wrappers (`sudo`, `env`, `exec`, ...) so
 *  the real command is the first token. */
function unwrap(tokens: SimpleCommand): SimpleCommand {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
    } else if (WRAPPERS.has(t)) {
      i++;
      while (i < tokens.length && (tokens[i] as string).startsWith("-")) {
        i += WRAPPER_FLAGS_WITH_ARG.has(tokens[i] as string) ? 2 : 1;
      }
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

function basename(token: string | undefined): string {
  return (token ?? "").replace(/^.*\//, "");
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

// ---------------------------------------------------------------------------------------
// Bash rules.
// ---------------------------------------------------------------------------------------

const NETWORK_TOOLS = new Set(["docker", "ssh", "scp", "nc", "netcat", "ncat"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "node", "python", "python3", "perl", "ruby"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Paths a stage must never write through a redirection or `tee`: the orchestrator's own
 *  code, the system, and the repository's `.git`. */
const PROTECTED_WRITE_ROOTS = ["/factory-src", "/factory", "/etc", "/usr", "/root", `${WORK}/.git`];
/** `rm -r` targets that would take the worktree, the output, or the container with them. */
const FORBIDDEN_RM_TARGETS = new Set([
  "/", "/*", WORK, `${WORK}/*`, `${WORK}/.git`, OUT, `${OUT}/*`,
  "~", "~/*", "$HOME", "${HOME}", ".", "./*", "..", "*",
]);
const GH_PR_MUTATIONS = new Set(["create", "ready", "merge", "review", "comment", "edit", "close"]);
const GH_API_MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const GH_API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
const GIT_OPTIONS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** Git subcommands that change the worktree or the index, refused in a read-only stage. */
const GIT_WRITES = new Set(["add", "commit", "stash", "apply", "am", "merge", "cherry-pick", "mv", "rm", "restore"]);

/** Case-insensitive signs that a commit message credits an AI. The trailer form is matched
 *  first so the reason can name it. */
const ATTRIBUTION_TRAILER = /co-authored-by:[^\n]*\b(claude|anthropic|ai)\b/i;
const ATTRIBUTION_WORDS = /generated (by|with) claude|claude code|anthropic|🤖/iu;

/** The reason a Bash command is refused, or null when it may run. */
export function guardBash(command: string, ctx: GuardContext): string | null {
  for (const pipeline of parseCommand(command)) {
    const reason = guardPipeline(pipeline, ctx);
    if (reason !== null) return reason;
  }
  return null;
}

function guardPipeline(pipeline: Pipeline, ctx: GuardContext): string | null {
  const commands = pipeline.map(unwrap).filter((tokens) => tokens.length > 0);
  // `curl ... | sh`: a downloader anywhere upstream of a shell or interpreter in one pipeline.
  const downloaderAt = commands.findIndex((tokens) => DOWNLOADERS.has(basename(tokens[0])));
  if (downloaderAt !== -1 && commands.slice(downloaderAt + 1).some((tokens) => INTERPRETERS.has(basename(tokens[0])))) {
    return "piping a download into a shell is not allowed in a stage: save it to a file under /tmp, read it, then run it";
  }
  for (const tokens of pipeline) {
    const reason = guardRedirections(tokens);
    if (reason !== null) return reason;
  }
  for (const tokens of commands) {
    const reason = guardSimpleCommand(tokens, ctx);
    if (reason !== null) return reason;
  }
  return null;
}

/** `> /etc/x`, `2>>/usr/x`, `&>/factory/x`: the target follows the operator or is glued to it. */
function guardRedirections(tokens: SimpleCommand): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(?:\d*|&)>>?\|?(.*)$/s.exec(tokens[i] as string);
    if (match === null) continue;
    const target = match[1] !== "" ? (match[1] as string) : tokens[i + 1];
    if (target !== undefined && isProtectedWriteTarget(target)) return protectedWriteReason(target);
  }
  return null;
}

function isProtectedWriteTarget(target: string): boolean {
  return PROTECTED_WRITE_ROOTS.some((root) => isUnder(stripTrailingSlash(target), root));
}

function protectedWriteReason(target: string): string {
  return `writing to ${target} is not allowed in a stage: only /out, /tmp and (in a writable stage) /work may be written`;
}

function guardSimpleCommand(tokens: SimpleCommand, ctx: GuardContext): string | null {
  const cmd = basename(tokens[0]);
  const args = tokens.slice(1);
  if (NETWORK_TOOLS.has(cmd)) return `${cmd} is not allowed in a stage: the container has no peers to reach`;
  if (cmd === "git") return guardGit(args, ctx);
  if (cmd === "gh") return guardGh(args);
  if (cmd === "rm") return guardRm(args);
  if (cmd === "chmod") return guardChmod(args);
  if (cmd === "tee") {
    const target = args.find((a) => !a.startsWith("-") && isProtectedWriteTarget(a));
    return target === undefined ? null : protectedWriteReason(target);
  }
  // A command string handed to a nested shell is guarded as if it were run directly.
  if (SHELLS.has(cmd)) {
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    const script = at === -1 ? undefined : args[at + 1];
    return script === undefined ? null : guardBash(script, ctx);
  }
  if (cmd === "eval") return guardBash(args.join(" "), ctx);
  return null;
}

function guardGit(args: string[], ctx: GuardContext): string | null {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    i += GIT_OPTIONS_WITH_ARG.has(args[i] as string) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return null;
  if (sub === "push") return "git push is not allowed in a stage: the machine pushes after approval";
  if (sub === "rebase") return "git rebase is not allowed in a stage: history is never rewritten; make a new commit instead";
  if (sub === "filter-branch") return "git filter-branch is not allowed in a stage: history is never rewritten";
  if (sub === "clean") return "git clean is not allowed in a stage: it deletes files nothing can recover";
  if (sub === "reset" && rest.includes("--hard")) {
    return "git reset --hard is not allowed in a stage: it discards work nothing can recover; use git reset (mixed) or git stash";
  }
  if (sub === "branch" && rest.some((a) => a === "--delete" || /^-[a-zA-Z]*[dD]/.test(a))) {
    return "deleting a branch is not allowed in a stage: the machine owns branches";
  }
  if (!ctx.writable) {
    if (GIT_WRITES.has(sub)) {
      return `read-only stage: git ${sub} is not allowed; this stage may not change the worktree`;
    }
    if (sub === "checkout" && rest.some((a) => a === "--" || a === "." || a.startsWith("./"))) {
      return "read-only stage: git checkout of a path is not allowed; this stage may not change the worktree";
    }
    return null;
  }
  if (sub === "commit") return guardCommit(rest, ctx);
  return null;
}

function guardCommit(args: string[], ctx: GuardContext): string | null {
  const messages: string[] = [];
  let amend = false;
  let noVerify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--amend") amend = true;
    else if (a === "--no-verify") noVerify = true;
    else if (a === "-m" || a === "--message" || a === "--trailer") {
      const value = args[++i];
      if (value !== undefined) messages.push(value);
    } else if (a.startsWith("--message=") || a.startsWith("--trailer=")) {
      messages.push(a.slice(a.indexOf("=") + 1));
    } else if (/^-[a-zA-Z]/.test(a) && !a.startsWith("--")) {
      // A short cluster: `-am msg`, `-mfeat: x`, `-sn`. Flags before an `m` are flags; what
      // follows the `m` (or the next token) is the message.
      const cluster = /^-([a-zA-Z]*?)(m(.*))?$/s.exec(a);
      const flags = cluster?.[1] ?? "";
      if (flags.includes("n")) noVerify = true;
      if (cluster?.[2] !== undefined) {
        const inline = cluster[3] ?? "";
        const value = inline !== "" ? inline : args[++i];
        if (value !== undefined) messages.push(value);
      }
    }
  }
  if (amend) return "git commit --amend is not allowed in a stage: history is never rewritten; make a new commit";
  if (noVerify) return "git commit --no-verify is not allowed in a stage: the repository's hooks must run";
  const prefix = ctx.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  if (typeof ctx.branch === "string" && ctx.branch !== "" && !ctx.branch.startsWith(prefix)) {
    return `commits must go on a "${prefix}" branch: the current branch is "${ctx.branch}"`;
  }
  for (const message of messages) {
    if (ATTRIBUTION_TRAILER.test(message)) {
      return "commits must not carry AI attribution; retry without the Co-Authored-By trailer";
    }
    if (ATTRIBUTION_WORDS.test(message)) {
      return "commits must not carry AI attribution; retry without mentioning Claude or Anthropic in the message";
    }
  }
  return null;
}

function guardGh(args: string[]): string | null {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) i++;
  const sub = args[i];
  const action = args[i + 1];
  const rest = args.slice(i + 1);
  if (sub === "pr" && action !== undefined && GH_PR_MUTATIONS.has(action)) {
    return `gh pr ${action} is not allowed in a stage: the machine opens, updates and merges the PR after approval`;
  }
  if (sub === "issue" && action !== "view" && action !== "list") return "gh issue may only be read in a stage (view, list): issues are the machine's to create and update";
  if (sub === "release") return "gh release is not allowed in a stage: releases are cut by the machine";
  if (sub === "api") {
    for (let j = 0; j < rest.length; j++) {
      const a = rest[j] as string;
      const method =
        a === "-X" || a === "--method" ? rest[j + 1]
        : a.startsWith("--method=") ? a.slice("--method=".length)
        : a.startsWith("-X") ? a.slice(2)
        : undefined;
      if (method !== undefined && GH_API_MUTATING_METHODS.has(method.toUpperCase())) {
        return `gh api ${method.toUpperCase()} is not allowed in a stage: only GET requests may be made`;
      }
      if (GH_API_FIELD_FLAGS.has(a) || a.startsWith("--field=") || a.startsWith("--raw-field=") || a.startsWith("--input=")) {
        return "gh api with fields sends a POST, which is not allowed in a stage: only GET requests may be made";
      }
    }
  }
  return null;
}

function guardRm(args: string[]): string | null {
  const separator = args.indexOf("--");
  const flags = separator === -1 ? args.filter((a) => a.startsWith("-")) : args.slice(0, separator).filter((a) => a.startsWith("-"));
  const recursive = flags.some((a) => a === "--recursive" || /^-[a-zA-Z]*[rR]/.test(a));
  if (!recursive) return null;
  const targets = separator === -1 ? args.filter((a) => !a.startsWith("-")) : args.slice(separator + 1);
  for (const raw of targets) {
    const target = stripTrailingSlash(raw);
    if (!FORBIDDEN_RM_TARGETS.has(target)) continue;
    if (target === "." || target === "*" || target === "./*" || target === "..") {
      return `rm -r ${raw} is not allowed in a stage: it would empty the worktree; name the paths to remove instead`;
    }
    return `rm -r ${raw} is not allowed in a stage: it would destroy the worktree, the output or the container`;
  }
  return null;
}

function guardChmod(args: string[]): string | null {
  const recursive = args.some((a) => a === "--recursive" || /^-[a-zA-Z]*R/.test(a));
  const worldWritable = args.some((a) => /^0?777$/.test(a) || a === "a+rwx" || a === "ugo+rwx");
  return recursive && worldWritable ? "chmod -R 777 is not allowed in a stage: fix the one path that needs a mode instead" : null;
}

// ---------------------------------------------------------------------------------------
// Write rules.
// ---------------------------------------------------------------------------------------

/** The reason a Write/Edit/MultiEdit/NotebookEdit to `filePath` is refused, or null. */
export function guardWrite(filePath: string, ctx: GuardContext): string | null {
  if (typeof filePath !== "string" || filePath.trim() === "") return "malformed tool input: the file path is empty";
  // A relative path is relative to the worktree; normalize resolves `..`, so a path that
  // escapes a root lands outside it and is refused by the root check below.
  const WORK = posix.normalize(ctx.workRoot ?? "/work");
  const OUT = posix.normalize(ctx.outRoot ?? "/out");
  const resolved = posix.normalize(filePath.startsWith("/") ? filePath : posix.join(WORK, filePath));
  if (isUnder(resolved, WORK) && resolved.slice(WORK.length).split("/").includes(".git")) {
    return `${WORK}/.git is never written by a stage: hooks and config belong to the machine`;
  }
  if (isUnder(resolved, OUT) || isUnder(resolved, TMP)) return null;
  if (isUnder(resolved, WORK)) {
    return ctx.writable ? null : `read-only stage: only ${OUT} may be written; ${resolved} is in the worktree`;
  }
  return `${resolved} is outside the writable roots: only ${OUT}, ${TMP} and (in a writable stage) ${WORK} may be written`;
}

// ---------------------------------------------------------------------------------------
// SDK hook wrappers.
// ---------------------------------------------------------------------------------------

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

/** Reads `tool_input[key]` as a string; undefined when absent or not a string. Reading may
 *  throw (a hostile or broken input) and the wrapper turns that into a deny. */
function toolInputString(input: HookInput, key: string): string | undefined {
  const toolInput: unknown = "tool_input" in input ? input.tool_input : undefined;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const value: unknown = (toolInput as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Wraps a guard as a hook callback. Fails closed: any exception inside is a deny. */
function asHook(guard: (input: HookInput) => string | null): (input: HookInput) => Promise<HookJSONOutput> {
  return async (input) => {
    try {
      const reason = guard(input);
      return reason === null ? {} : deny(reason);
    } catch (error) {
      return deny(`guard failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** The SDK hook matchers for PreToolUse: one for Bash, one for the write tools. Fails
 *  closed: any exception inside a guard denies. */
export function preToolUseGuards(ctx: GuardContext): HookCallbackMatcher[] {
  return [
    {
      matcher: "^Bash$",
      hooks: [
        asHook((input) => {
          const command = toolInputString(input, "command");
          return command === undefined ? "malformed tool input: Bash needs a string command" : guardBash(command, ctx);
        }),
      ],
    },
    {
      matcher: `^(${WRITE_TOOLS.join("|")})$`,
      hooks: [
        asHook((input) => {
          const filePath = toolInputString(input, "file_path") ?? toolInputString(input, "notebook_path");
          return filePath === undefined ? "malformed tool input: a write needs a string file_path" : guardWrite(filePath, ctx);
        }),
      ],
    },
  ];
}
