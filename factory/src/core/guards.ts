// The guards every runtime enforces before a tool call runs (the Claude runtime as PreToolUse
// hooks, eve as tool approvals). The container is the real boundary (no credentials for push,
// /work mounted read-only for read-only stages); these guards exist so the model learns *why* an action is refused
// instead of burning turns on a cryptic EACCES, and so the few things the container cannot
// stop (a commit with an AI trailer, a commit on the wrong branch, a `gh pr create` with the
// token the stage legitimately holds for reading) are refused before they happen. There is
// no human to ask, so a guard either denies with a reason phrased for the model or stays
// silent; it never asks.
import type { StageInput } from "@hardness/contracts";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { splitArgv } from "./argv.ts";
import { inRoots, pathsIn, resolvePath } from "./roots.ts";

export interface GuardContext {
  /** Whether this stage may edit the worktree and commit. */
  writable: boolean;
  /** The branches the stage may commit to: `task/` (the default) is a prefix; any other value is one exact branch. */
  branchPrefix?: string;
  /** The current branch, when known, so a commit on the wrong branch is refused before git runs. */
  branch?: string | null;
  /** Where the worktree and the run's output folder are (defaults /work and /out; a host run moves them). */
  workRoot?: string;
  outRoot?: string;
  /** The command prefixes the shell may run (the pack's access), for a runtime whose SDK does not
   *  enforce them itself; absent means any command the rules let through. */
  commands?: string[];
  /** The roots every path a tool names must lie in, symlinks followed (core/roots.ts): the
   *  worktree, the output, the run's scratch folder and `read`. Absent, paths are left to the
   *  rules above (the rule tests; a runtime always sets them). */
  roots?: StageRoots;
  /** Whether the pack may fetch from the web; absent leaves a fetch to the address rule. */
  web?: boolean;
  /** Variables a shell command may expand: the QA credentials the stage input names
   *  (`env:QA_PASSWORD`). Any other `$` expansion is refused when roots are set. */
  expandable?: string[];
}

export interface StageRoots {
  /** The run's scratch folder under /tmp, HOME and TMPDIR for commands: read and written. */
  scratch: string;
  /** Read-only roots besides the worktree and the output: the stage input, the skills. */
  read?: string[];
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
const PROTECTED_WRITE_ROOTS = ["/factory-src", "/opt/luna", "/factory", "/etc", "/usr", "/root", `${WORK}/.git`];
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
    return "piping a download into a shell is not allowed in a stage: save it to a file in the scratch folder (TMPDIR), read it, then run it";
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
  if (sub === "reset" && rest.some((a) => longOption(a, ["hard"]) === "hard")) {
    return "git reset --hard is not allowed in a stage: it discards work nothing can recover; use git reset (mixed) or git stash";
  }
  if (sub === "branch" && rest.some((a) => longOption(a, ["delete"]) === "delete" || /^-[a-zA-Z]*[dD]/.test(a))) {
    return "deleting a branch is not allowed in a stage: the machine owns branches";
  }
  if (!ctx.writable) {
    if (GIT_WRITES.has(sub)) {
      return `read-only stage: git ${sub} is not allowed; this stage may not change the worktree`;
    }
    if (rest.some((a) => longOption(a, ["output"]) === "output")) {
      return `read-only stage: git ${sub} --output writes a file; this stage may not change the worktree`;
    }
    if (sub === "checkout" && rest.some((a) => a === "--" || a === "." || a.startsWith("./"))) {
      return "read-only stage: git checkout of a path is not allowed; this stage may not change the worktree";
    }
    return null;
  }
  if (sub === "commit") return guardCommit(rest, ctx);
  return null;
}

/** The long option `arg` names as git reads it, among `names`: git takes any unambiguous prefix
 *  of a long option, so `--amen` is `--amend` and `--no-verif` is `--no-verify`. Any prefix of two
 *  letters or more is taken as the option, ambiguous or not (git refuses an ambiguous one anyway). */
function longOption(arg: string, names: string[]): string | null {
  if (!arg.startsWith("--")) return null;
  const name = arg.slice(2).split("=")[0] as string;
  if (name.length < 2) return null;
  return names.find((full) => full === name) ?? names.find((full) => full.startsWith(name)) ?? null;
}

/** Short commit options that take a value, glued (`-mfeat`) or as the next word. */
const COMMIT_SHORT_WITH_VALUE = new Set(["m", "F", "C", "c", "t"]);

/** The reason a commit message read from a file (`-F`) may not be used, or null: the file must be
 *  one the guard can read (in the roots), and its message must carry no attribution. */
function guardMessageFile(file: string, ctx: GuardContext): string | null {
  const unreadable = `git commit -F ${file}: the guard cannot read that message; write it to a file in the worktree or the scratch folder and pass that, or use -m`;
  if (file === "-" || file.startsWith("/dev/")) return unreadable;
  const reason = readRootReason(file, ctx);
  if (reason !== null) return reason;
  try {
    return attributionReason(readFileSync(posix.resolve(ctx.workRoot ?? WORK, file), "utf8"));
  } catch {
    return unreadable;
  }
}

function attributionReason(message: string): string | null {
  if (ATTRIBUTION_TRAILER.test(message)) return "commits must not carry AI attribution; retry without the Co-Authored-By trailer";
  if (ATTRIBUTION_WORDS.test(message)) return "commits must not carry AI attribution; retry without mentioning Claude or Anthropic in the message";
  return null;
}

function guardCommit(args: string[], ctx: GuardContext): string | null {
  const messages: string[] = [];
  const files: string[] = [];
  let amend = false;
  let noVerify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const long = longOption(a, ["amend", "no-verify", "message", "trailer", "file"]);
    const value = (): string | undefined => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i]);
    if (long === "amend") amend = true;
    else if (long === "no-verify") noVerify = true;
    else if (long === "message" || long === "trailer") {
      const v = value();
      if (v !== undefined) messages.push(v);
    } else if (long === "file") {
      const v = value();
      if (v !== undefined) files.push(v);
    } else if (/^-[a-zA-Z]/.test(a)) {
      // A short cluster: `-am msg`, `-mfeat: x`, `-sn`, `-aF file`. Flags up to the first one
      // that takes a value are flags; what follows it (or the next word) is its value.
      for (let k = 1; k < a.length; k++) {
        const flag = a[k] as string;
        if (flag === "n") noVerify = true;
        if (!COMMIT_SHORT_WITH_VALUE.has(flag)) continue;
        const v = k + 1 < a.length ? a.slice(k + 1) : args[++i];
        if (v !== undefined && flag === "m") messages.push(v);
        if (v !== undefined && flag === "F") files.push(v);
        break;
      }
    }
  }
  if (amend) return "git commit --amend is not allowed in a stage: history is never rewritten; make a new commit";
  if (noVerify) return "git commit --no-verify is not allowed in a stage: the repository's hooks must run";
  // `task/` names a family of branches; anything else (the branch named for a Jira-linked task,
  // a PR's head) is one exact branch, so `bug/PLAT-1234` never passes as `bug/PLAT-123`.
  const prefix = ctx.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
  if (typeof ctx.branch === "string" && ctx.branch !== "") {
    const allowed = prefix === DEFAULT_BRANCH_PREFIX ? ctx.branch.startsWith(prefix) : ctx.branch === prefix;
    if (!allowed) return prefix === DEFAULT_BRANCH_PREFIX ? `commits must go on a "${prefix}" branch: the current branch is "${ctx.branch}"` : `commits must go on the "${prefix}" branch: the current branch is "${ctx.branch}"`;
  }
  for (const message of messages) {
    const reason = attributionReason(message);
    if (reason !== null) return reason;
  }
  for (const file of files) {
    const reason = guardMessageFile(file, ctx);
    if (reason !== null) return reason;
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
// The call every runtime asks about.
// ---------------------------------------------------------------------------------------

/** A tool call in no runtime's words: `bash` with a `command` a shell runs, `exec` with a
 *  `command` run as one process without a shell (core/argv.ts), `write` or `read` with a `path`
 *  (and a search's `pattern`), `fetch` with a `url`;
 *  any other tool is not guarded here. */
export interface GuardedCall {
  tool: string;
  input: unknown;
}

export type GuardDecision = { allow: true } | { allow: false; reason: string };

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Every simple command's tokens, quotes removed. */
const simpleCommands = (command: string): SimpleCommand[] => parseCommand(command).flat();

const outsideReason = (path: string, policy: GuardContext, roots: StageRoots): string =>
  `${path} is outside this stage's roots: a tool may only name paths under ${[policy.workRoot ?? WORK, policy.outRoot ?? OUT, roots.scratch, ...(roots.read ?? [])].join(", ")} (scratch space is ${roots.scratch})`;

/** The reason `path`, as the kernel would open it, lies outside the roots a read may name, or null. */
function readRootReason(path: string, policy: GuardContext): string | null {
  const roots = policy.roots;
  if (roots === undefined) return null;
  const work = policy.workRoot ?? WORK;
  const { real, device } = resolvePath(path, work, roots.scratch);
  if (device) return null;
  if (real !== null && inRoots(real, [work, policy.outRoot ?? OUT, roots.scratch, ...(roots.read ?? [])])) return null;
  return outsideReason(path, policy, roots);
}

/** The reason a write to `path`, as the kernel would open it, is refused, or null: the write
 *  rules, on the resolved path and with the scratch folder in place of /tmp. */
function writeRootReason(path: string, policy: GuardContext): string | null {
  const roots = policy.roots;
  if (roots === undefined) return guardWrite(path, policy);
  const work = policy.workRoot ?? WORK;
  const out = policy.outRoot ?? OUT;
  const { real } = resolvePath(path, work, roots.scratch);
  if (real === null) return outsideReason(path, policy, roots);
  const [realWork, realOut, realScratch] = [work, out, roots.scratch].map((root) => resolvePath(root, "/", roots.scratch).real as string);
  if (inRoots(real, [realWork as string]) && real.slice((realWork as string).length).split("/").includes(".git")) {
    return `${work}/.git is never written by a stage: hooks and config belong to the machine`;
  }
  if (inRoots(real, [realOut as string, realScratch as string])) return null;
  if (inRoots(real, [realWork as string])) return policy.writable ? null : `read-only stage: only ${out} and ${roots.scratch} may be written; ${path} is in the worktree`;
  return `${path} is outside the writable roots: only ${out}, ${roots.scratch} (scratch space) and (in a writable stage) ${work} may be written`;
}

/** The reason one command's words name a path outside the roots, or null. A shell's redirection
 *  operator is not part of the path; a nested shell's script is checked as a command. */
function argsRootReason(tokens: SimpleCommand, policy: GuardContext): string | null {
  if (policy.roots === undefined) return null;
  const cmd = basename(unwrap(tokens)[0]);
  const script = SHELLS.has(cmd) ? tokens[tokens.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) + 1] : cmd === "eval" ? tokens.slice(1).join(" ") : undefined;
  if (script !== undefined && script !== tokens[0]) {
    for (const nested of simpleCommands(script)) {
      const reason = argsRootReason(nested, policy);
      if (reason !== null) return reason;
    }
  }
  for (const token of tokens) {
    for (const path of pathsIn(token.replace(/^(\d*|&)[<>]+[&|]?/, ""), policy.workRoot ?? WORK)) {
      const reason = readRootReason(path, policy);
      if (reason !== null) return reason;
    }
  }
  return null;
}

/** The reason a shell redirection (`> x`, `2>>x`, `&>x`) writes where a write may not, or null. */
function redirectRootReason(tokens: SimpleCommand, policy: GuardContext): string | null {
  if (policy.roots === undefined) return null;
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(?:\d*|&)>>?\|?(.*)$/s.exec(tokens[i] as string);
    if (match === null) continue;
    const target = match[1] !== "" ? (match[1] as string) : tokens[i + 1];
    if (target === undefined || target.startsWith("&")) continue;
    const reason = writeRootReason(target, policy);
    if (reason !== null && !resolvePath(target, policy.workRoot ?? WORK, policy.roots.scratch).device) return reason;
  }
  return null;
}

/** The reason a shell command expands something, or null. Claude's Bash runs a real shell: a
 *  `$NAME`, `$(...)`, backtick or `<(...)` would turn into text the guard never saw (an env
 *  token, /proc/$PPID/environ). A literal `$` in single quotes, and a credential the stage names,
 *  stay allowed. A nested shell's script is checked too. */
function guardExpansion(command: string, policy: GuardContext): string | null {
  const allowed = new Set(policy.expandable ?? []);
  const refuse = (what: string, kind: string) => `\`${what}\` is ${kind}: a stage's shell expands nothing; write the value itself, or single-quote a literal $`;
  let dq = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const next = command[i + 1];
    if (!dq && c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) break;
      i = close;
    } else if (c === "\\") {
      i++;
    } else if (c === '"') {
      dq = !dq;
    } else if (c === "`") {
      return refuse("`", "a command substitution");
    } else if (!dq && (c === "<" || c === ">") && next === "(") {
      return refuse(`${c}(`, "a process substitution");
    } else if (c === "$") {
      if (next === undefined || /\s/.test(next) || (dq && next === '"')) continue;
      if (next === "(") return refuse("$(", "a command substitution");
      const name = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(command.slice(i));
      const variable = name?.[1] ?? name?.[2];
      if (variable === undefined || !allowed.has(variable)) return refuse(name?.[0] ?? `$${next}`, "an expansion");
      i += (name?.[0].length ?? 1) - 1;
    }
  }
  for (const tokens of simpleCommands(command)) {
    const unwrapped = unwrap(tokens);
    const cmd = basename(unwrapped[0]);
    const at = SHELLS.has(cmd) ? unwrapped.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) : -1;
    const script = at > 0 ? unwrapped[at + 1] : cmd === "eval" ? unwrapped.slice(1).join(" ") : undefined;
    if (script !== undefined) {
      const reason = guardExpansion(script, policy);
      if (reason !== null) return reason;
    }
  }
  return null;
}

/** The reason a command, or any part of a chain, starts with no listed prefix, or null. */
function guardAllowList(command: string, policy: GuardContext): string | null {
  for (const tokens of simpleCommands(command)) {
    const reason = guardListed(tokens, policy);
    if (reason !== null) return reason;
  }
  return null;
}

/** The reason one simple command starts with no listed prefix (`git add` is argv[0] and its
 *  subcommand), or null. */
function guardListed(tokens: SimpleCommand, policy: GuardContext): string | null {
  if (policy.commands === undefined) return null;
  const prefixes = policy.commands.map((p) => p.split(/\s+/));
  if (prefixes.some((p) => p.every((word, i) => tokens[i] === word))) return null;
  return `\`${tokens.join(" ")}\` is not on this stage's command allow-list (${policy.commands.join(", ")}): run one listed command per call`;
}

/** The reason one process's argv may not run, or null: the command rules (git, gh, rm, ...) on
 *  the command a wrapper such as `env` would run, then the allow-list, as for a shell command. */
function guardArgv(argv: string[], policy: GuardContext): string | null {
  return guardSimpleCommand(unwrap(argv), policy) ?? guardListed(argv, policy);
}

function decide(call: GuardedCall, policy: GuardContext): string | null {
  if (call.tool === "exec") {
    const command = field(call.input, "command");
    if (command === undefined) return "malformed tool input: a command needs a string command";
    const parsed = splitArgv(command);
    return "refused" in parsed ? parsed.refused : (guardArgv(parsed.argv, policy) ?? argsRootReason(parsed.argv, policy));
  }
  if (call.tool === "bash") {
    const command = field(call.input, "command");
    if (command === undefined) return "malformed tool input: Bash needs a string command";
    const expansion = policy.roots === undefined ? null : guardExpansion(command, policy);
    return (
      expansion ??
      guardBash(command, policy) ??
      guardAllowList(command, policy) ??
      firstReason(simpleCommands(command), (tokens) => argsRootReason(tokens, policy) ?? redirectRootReason(tokens, policy))
    );
  }
  if (call.tool === "fetch") {
    const url = field(call.input, "url");
    return url === undefined ? "malformed tool input: a fetch needs a string url" : guardFetch(url, policy);
  }
  if (call.tool === "write" || call.tool === "read") {
    const path = field(call.input, "path");
    if (path === undefined) return `malformed tool input: a ${call.tool} needs a string file_path`;
    if (call.tool === "write") return writeRootReason(path, policy);
    // A search names its folder, and its pattern may name another (`/proc/*/environ`, `../..`).
    const pattern = field(call.input, "pattern");
    const fixed = pattern === undefined ? undefined : /^[^*?[{]*\//.exec(pattern)?.[0];
    const patternRoot = fixed !== undefined && (fixed.startsWith("/") || fixed.startsWith("~") || fixed.startsWith("$") || fixed.split("/").includes("..")) ? (fixed.startsWith("/") || fixed.startsWith("~") || fixed.startsWith("$") ? fixed : posix.join(path, fixed)) : undefined;
    return readRootReason(path, policy) ?? (patternRoot === undefined ? null : readRootReason(patternRoot, policy));
  }
  return null;
}

/** The reason a web fetch of `url` is refused, or null: only http(s) to a public host. The
 *  runner's luna bridge and the eve server listen on loopback, a cloud's metadata service on a
 *  link-local address, a container's peers on private ones; none of them is the web. */
function guardFetch(url: string, policy: GuardContext): string | null {
  if (policy.web === false) return "this stage has no web access: work from the stage input and the worktree";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${url} is not a URL: give a full https:// address`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return `${parsed.protocol} URLs are not fetched in a stage: only http(s) pages on the web`;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)?.slice(1).map(Number);
  const local =
    host === "localhost" ||
    /\.(localhost|local|internal)$/.test(host) ||
    (ipv4 !== undefined &&
      (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254) || (ipv4[0] === 172 && (ipv4[1] as number) >= 16 && (ipv4[1] as number) <= 31) || (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 100 && (ipv4[1] as number) >= 64 && (ipv4[1] as number) <= 127))) ||
    (host.includes(":") && (host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:")));
  return local ? `${parsed.host} is not on the web: a stage fetches public pages only, never loopback, private or link-local addresses` : null;
}

function firstReason<T>(items: T[], check: (item: T) => string | null): string | null {
  for (const item of items) {
    const reason = check(item);
    if (reason !== null) return reason;
  }
  return null;
}

/** Whether a call may run under `policy`, with the reason phrased for the model when it may not.
 *  Fails closed: an input that throws when read is refused. */
export function checkCall(call: GuardedCall, policy: GuardContext): GuardDecision {
  try {
    const reason = decide(call, policy);
    return reason === null ? { allow: true } : { allow: false, reason };
  } catch (error) {
    return { allow: false, reason: `guard failed closed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
