// One tool call's result as its class: what later code may learn from, never the text. A command is
// read into an intent (test, build, fetch, ...) and a safe spelling of it; an output into an error
// class and a failure fingerprint; a write into a repo-relative path. Ported from TokenEconomizer's
// micro-skill observer, with its generic vocabulary (RFC 0007).
import path from "node:path";

import type { Observation } from "@hardness/contracts";

import { errorClassOf, failureSignature, NETWORK_ERRORS, splitLines } from "./fingerprint-failure.ts";
import { shellEditTargets } from "./shell-edits.ts";

export interface ObservedCall {
  tool: string;
  input: unknown;
  output: string;
  ok: boolean;
}

/** What an output is cut to before it is read: a runner's summary is at the end of a page, not a megabyte in. */
const OUTPUT_CAP = 20000;

type Intent = NonNullable<Observation["intent"]>;
/** An intent, or `probe` for a command that reads the environment and has no intent of its own. */
type Kind = Intent | "probe";
interface Segment {
  kind: Kind;
  form: string;
  head: string;
  hosts: string[];
}

// The generic vocabulary: every ecosystem at once.
const INTERPRETERS = new Set(["python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "tsx", "ts-node", "ruby", "perl", "php", "Rscript", "julia", "lua", "elixir"]);
const RUNNER_HEADS = new Set(["pytest", "py.test", "tox", "nox", "nosetests", "trial", "jest", "vitest", "mocha", "playwright", "cypress", "ava", "karma", "rspec", "phpunit", "ctest", "bats"]);
const RUNNER_SCRIPTS = ["runtests.py", "bin/test", "bin/doctest", "manage.py"];
const RUNNER_MODULES = new Set(["pytest", "unittest", "nose", "django", "tox", "nox"]);
const PACKAGE_TOOLS = new Set([
  "pip", "pip3", "conda", "mamba", "poetry", "pipenv", "uv", "apt", "apt-get", "npm", "yarn", "pnpm", "corepack",
  "gem", "bundle", "composer", "cargo", "go", "mvn", "gradle", "dotnet", "brew", "rustup", "pyenv", "nvm", "asdf",
]);
const FETCH_HEADS = new Set(["curl", "wget"]);
const PROBE_HEADS = new Set(["which", "command", "type", "whereis"]);
const TASK_HEADS = new Set(["make", "npm", "yarn", "pnpm", "cargo", "go", "mvn", "gradle", "gradlew", "dotnet", "mix", "swift", "rake"]);
const BUILD_HEADS = new Set([
  "make", "cmake", "ninja", "bazel", "tsc", "eslint", "prettier", "ruff", "flake8", "pylint", "mypy", "pyright", "black", "isort",
  "golangci-lint", "gcc", "g++", "clang", "javac", "webpack", "vite", "pre-commit", "shellcheck",
]);
const BUILD_SUBS = new Set(["build", "check", "compile", "lint", "vet", "typecheck", "type-check", "clippy", "package", "verify", "fmt", "format"]);
const SCRIPT_HEADS = new Set(["npm", "yarn", "pnpm", "bun"]);
const GIT_FETCH_SUBS = new Set(["fetch", "clone", "pull", "ls-remote"]);
const GIT_PROBE_SUBS = new Set(["remote", "branch", "tag", "fsck", "stash", "show-ref", "for-each-ref"]);
const PREFIX_HEADS = new Set(["sudo", "env", "time", "exec", "nice", "nohup", "timeout"]);
const VERSION_FLAGS = new Set(["--version", "-V", "-VV", "-v"]);

const ACTIVATE_RE = /^(?:source|\.)\s+\S*activate\s+([\w.-]+)\s*$/;
const CD_RE = /^cd\s+(['"]?)([^\s;&|'"]+)\1\s*$/;
const CD_FAILED_RE = /\bcd: [^\n]*: (?:No such file or directory|Not a directory)/;
const CONDA_ACTIVATE_RE = /^(?:conda|mamba)\s+activate\s+([\w.-]+)\s*$/;
const CONDA_RUN_RE = /^(?:conda|mamba)\s+run\s+(?:--no-capture-output\s+|--live-stream\s+)*(?:-n|--name)\s+([\w.-]+)\s+/;
const TOOL_RUN_RE = /^(poetry|pipenv|uv|npx|bundle|yarn|pnpm)\s+(?:run|exec)\s+/;
const NPX_RE = /^npx\s+(?:(?:--yes|-y|--no-install|--no)\s+)*/;
const TOOL_LAUNCH_RE = /^(uvx|uv\s+tool\s+run|pipx\s+run)\s+/;
const INTERP_VERSIONED_RE = /^(?:python|node)\d(?:\.\d+)?$/;
const ENV_ASSIGN_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/;
const ASSIGN_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Upstream reads `/bin/sh -c` and `/bin/bash -lc`; a bare `bash -lc` (Codex) is the same shape.
const WRAP_RE = /^(?:\/bin\/)?(?:ba)?sh\s+-[a-z]*c\s+(.*)$/s;
const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*['"]?(\w+)['"]?[^\n]*\n.*?\n\s*\1\b/gs;
const RTK_RE = /^rtk\s+(?:proxy\s+)?(?=\S)/;
const HOST_RE = /https?:\/\/([^/\s'"`]+)/g;

const LOADED_RE = /\bRan [1-9]\d* tests?\b|\b[1-9]\d* (?:passed|failed|passing|failing)\b|\bcollected [1-9]\d* items?\b/;
const LOADED_GENERIC_RE =
  /^ok\s+\S+\s+[\d.]+s\b|^--- (?:PASS|FAIL)\b|\btest result: (?:ok|FAILED)\b|\b[1-9]\d* examples?, \d+ failures?\b|\b(?:Passed|Failed)!\s+-|\bTests run: [1-9]\d*/m;
const ENV_NEED_RE = /environment variable\s+['"`]?([A-Z][A-Z0-9_]{2,})/;
const ENV_PREFIX_RE = /(?:^|[\s;&(])(?:export\s+)?([A-Z][A-Z0-9_]{2,})=(['"]?)([\w.\-/:]+)\2/;
const ENV_INCODE_RE = /os\.environ(?:\.setdefault\(\s*|\[\s*)['"]([A-Z][A-Z0-9_]{2,})['"]\s*(?:,|\]\s*=)\s*['"]([\w.\-/:]+)['"]/;

const baseName = (head: string): string => head.slice(head.lastIndexOf("/") + 1);

/** The inner script of a `sh -c` wrapper, without its quotes. */
function unwrap(cmd: string): string {
  const m = WRAP_RE.exec(cmd.trim());
  if (!m) return cmd;
  const inner = (m[1] as string).trim();
  const q = inner[0];
  if (inner.length >= 2 && (q === "'" || q === '"') && inner[inner.length - 1] === q) {
    const body = inner.slice(1, -1);
    return q === '"' ? body.replace(/\\(["$\\])/g, "$1") : body;
  }
  return inner;
}

/** The simple commands of a line: split on newline, `;`, `|`, `&&` and `||` outside quotes; a single `&` stays. */
function segments(cmd: string): string[] {
  const text = cmd.replace(HEREDOC_RE, (m) => `${m.split("\n")[0]} <heredoc>`);
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\n" || c === ";" || c === "|" || (c === "&" && text[i + 1] === "&")) {
      out.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && text[i + 1] === c) i++;
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/^[()]+|[()]+$/g, "").trim()).filter(Boolean);
}

/** Where `cd target` lands, relative to the worktree, or undefined when it cannot be told. */
function cdTarget(cur: string | undefined, target: string, work: string): string | undefined {
  if (!target || /^[~$-]/.test(target)) return undefined;
  let rel: string;
  if (path.posix.isAbsolute(target)) rel = path.posix.relative(work, target);
  else if (cur === undefined) return undefined;
  else rel = path.posix.join(cur, target);
  if (rel === ".") rel = "";
  return rel === ".." || rel.startsWith("../") ? undefined : rel;
}

function probeKind(sub: string, rest: string[]): string | undefined {
  if (sub === "remote") return "remote";
  if (sub === "branch") return rest.some((a) => ["-a", "-r", "--all", "--remotes", "-ar", "-ra"].includes(a)) ? "branch" : undefined;
  if (sub === "tag") return rest.includes("--contains") ? "tag" : undefined;
  if (sub === "fsck") return "fsck";
  if (sub === "stash") return rest[0] === "list" ? "stash" : undefined;
  return sub === "show-ref" || sub === "for-each-ref" ? "refs" : undefined;
}

const hostsIn = (body: string): string[] => [...body.matchAll(HOST_RE)].map((m) => cleanHost(m[1] as string)).filter(Boolean);

/** A host as a name: no login, no characters beyond a name and a port. */
function cleanHost(raw: string): string {
  return raw.slice(raw.lastIndexOf("@") + 1).replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 120);
}

const isScript = (arg: string, script: string): boolean => arg === script || arg.endsWith(script);

/** The first row of the table that fits; undefined when the command is none of them. */
function classify(head: string, rest: string[], body: string, prefix: string): Segment | undefined {
  const base = baseName(head);
  const form = (expr: string): string => (prefix ? `${prefix} ${expr}` : expr);
  const seg = (kind: Kind, expr: string, hosts: string[] = []): Segment => ({ kind, form: form(expr), head, hosts });
  const interp = INTERPRETERS.has(base) || INTERP_VERSIONED_RE.test(base);

  if (interp) {
    if (rest.length > 0 && rest.every((a) => VERSION_FLAGS.has(a))) return seg("probe", head);
    const mi = rest.indexOf("-m");
    const mod = mi >= 0 ? rest[mi + 1] : undefined;
    if (mod !== undefined && RUNNER_MODULES.has(mod)) return seg("test", `${head} -m ${mod}`);
    if (mod !== undefined && BUILD_HEADS.has(mod)) return seg("build", `${head} -m ${mod}`);
    const arg = rest.find((a) => !a.startsWith("-"));
    const script = arg === undefined ? undefined : RUNNER_SCRIPTS.find((s) => isScript(arg, s));
    if (arg !== undefined && script !== undefined && (script !== "manage.py" || rest.includes("test"))) return seg("test", `${head} ${arg.replace(/^(?:\.\/)+/, "")}`);
    return seg("interpreter", head);
  }
  if (RUNNER_HEADS.has(base)) return seg("test", head);
  const runnerScript = RUNNER_SCRIPTS.find((s) => head === s || head.endsWith(`/${s}`));
  if (runnerScript !== undefined && (runnerScript !== "manage.py" || rest.includes("test"))) return seg("test", `python ${head.replace(/^[./]+/, "")}`);
  if (TASK_HEADS.has(base) && rest[0] === "test") return seg("test", `${base} test`);
  if (SCRIPT_HEADS.has(base) && rest[0] === "run" && rest[1] !== undefined) {
    const kind = (rest[1].split(":")[0] as string);
    if (kind === "test") return seg("test", `${base} run ${rest[1]}`);
    if (BUILD_SUBS.has(kind)) return seg("build", `${base} run ${rest[1]}`);
  }
  if (TASK_HEADS.has(base) && rest[0] !== undefined && BUILD_SUBS.has(rest[0])) return seg("build", `${base} ${rest[0]}`);
  if (BUILD_HEADS.has(base)) return seg("build", base);
  if (PROBE_HEADS.has(base)) return seg("probe", base);
  if (FETCH_HEADS.has(base)) return seg("fetch", base, hostsIn(body));
  if (base === "git") {
    const sub = rest[0];
    if (sub !== undefined && GIT_FETCH_SUBS.has(sub)) return seg("fetch", `git ${sub}`, hostsIn(body));
    if (sub !== undefined && GIT_PROBE_SUBS.has(sub) && probeKind(sub, rest.slice(1)) !== undefined) return seg("vcs", `git ${sub}`);
    return undefined;
  }
  if (PACKAGE_TOOLS.has(base)) {
    if (/^(?:pip|npm|yarn|pnpm)/.test(base) && rest[0] !== undefined && ["install", "download", "add", "ci"].includes(rest[0])) return seg("fetch", `${base} ${rest[0]}`, hostsIn(body));
    return seg("package", base);
  }
  return undefined;
}

/** The commands of one shell call, each with its intent and form. A failed `cd` is the caller's to check. */
function classifyCommand(cmd: string, work: string): Segment[] {
  const out: Segment[] = [];
  let carried = "";
  let here: string | undefined = "";
  let cd = "";
  for (const raw of segments(unwrap(cmd))) {
    let seg = raw.replace(ENV_ASSIGN_RE, "").replace(RTK_RE, "").replace(ENV_ASSIGN_RE, "").trim();
    if (!seg) continue;
    const cdm = CD_RE.exec(seg);
    if (cdm) {
      const target = cdm[2] as string;
      const there = cdTarget(here, target, work);
      if (there !== undefined) {
        here = there;
        cd = there ? `cd ${there} &&` : "";
      } else {
        here = undefined;
        cd = `cd ${target} &&`;
      }
      continue;
    }
    const act = ACTIVATE_RE.exec(seg);
    const conda = CONDA_ACTIVATE_RE.exec(seg);
    if (act) {
      carried = `source activate ${act[1]} &&`;
      continue;
    }
    if (conda) {
      carried = `conda activate ${conda[1]} &&`;
      continue;
    }
    let prefix = [cd, carried].filter(Boolean).join(" ");
    const add = (s: string): void => {
      prefix = `${prefix} ${s}`.trim();
    };
    let m: RegExpExecArray | null;
    if ((m = CONDA_RUN_RE.exec(seg))) {
      add(`conda run -n ${m[1]}`);
      seg = seg.slice(m[0].length);
    } else if ((m = TOOL_RUN_RE.exec(seg))) {
      add(`${m[1]} run`);
      seg = seg.slice(m[0].length);
    } else if ((m = NPX_RE.exec(seg))) {
      add("npx");
      seg = seg.slice(m[0].length);
    } else if ((m = TOOL_LAUNCH_RE.exec(seg))) {
      add(m[1]?.startsWith("uvx") ? "uvx" : m[1]?.startsWith("uv") ? "uvx" : "pipx run");
      seg = seg.slice(m[0].length);
    }
    const toks = seg.split(/\s+/).filter(Boolean);
    while (toks.length && (PREFIX_HEADS.has(toks[0] as string) || ASSIGN_TOKEN_RE.test(toks[0] as string))) toks.splice(0, toks[0] === "timeout" ? 2 : 1);
    if (!toks.length) continue;
    const found = classify(toks[0] as string, toks.slice(1), seg, prefix);
    if (found) out.push(found);
  }
  return out;
}

/** The segment that decided the outcome. An error names its segment when it can (the command, or for a network error the host); a failed call without one is its last target; otherwise the first target, else the first command read. */
function decide(segs: Segment[], output: string, ok: boolean, hit: ReturnType<typeof errorClassOf>): Segment | undefined {
  const targets = segs.filter((s) => s.kind !== "vcs" && s.kind !== "probe");
  if (hit) {
    let named: Segment[];
    if (NETWORK_ERRORS.has(hit.name)) {
      const fetches = targets.filter((s) => s.kind === "fetch");
      const hosted = fetches.filter((s) => s.hosts.length === 0 || s.hosts.some((h) => output.includes(h)));
      named = hosted.length ? hosted : fetches;
    } else {
      const line = hit.line ?? "";
      named = targets.filter((s) => output.includes(s.head) || line.includes(baseName(s.head)));
    }
    if (named.length) return named[0];
    if (!ok && targets.length) return targets[targets.length - 1];
  }
  return targets[0] ?? segs[0];
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function family(tool: string): "shell" | "content" | "edit" | "fetch" | "other" {
  const t = tool.toLowerCase();
  if (t === "bash" || t === "shell") return "shell";
  if (t === "read" || t === "glob" || t === "grep") return "content";
  if (["write", "edit", "multiedit", "create", "str_replace_editor", "apply_patch"].includes(t)) return "edit";
  return t === "webfetch" || t === "web_fetch" ? "fetch" : "other";
}

/** A path as repo-relative under the worktree, or undefined when it lies outside or is the worktree itself. */
function relative(p: string, work: string): string | undefined {
  const r = path.relative(work, path.resolve(work, p));
  if (!r || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return undefined;
  const rel = r.split(path.sep).join("/");
  return rel.length <= 300 ? rel : undefined;
}

const safeForm = (s: string): string => s.replace(/[^A-Za-z0-9 ._:=/@+-]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

/** One tool call's result as its class: what later code may learn from, never the text. */
export function observe(call: ObservedCall, roots: { work: string }): Observation {
  const o: Observation = {};
  const input = asRecord(call.input);
  const kind = family(call.tool);
  const output = typeof call.output === "string" ? call.output.slice(0, OUTPUT_CAP) : "";
  const cmd = kind === "shell" ? (str(input.command) ?? str(input.cmd)) : undefined;
  const failed = !call.ok;

  // A content tool's text is a file or a search result, not an outcome: it is read only when the tool failed.
  const readable = kind !== "content" || failed;
  const hit = readable && output ? errorClassOf(output) : undefined;
  if (hit) o.errorClass = hit.name;
  if (failed && output) {
    const sig = failureSignature(output, hit?.pattern);
    if (sig) o.failure = sig;
  }

  const edits: string[] = [];
  if (kind === "edit") {
    for (const p of [input.file_path, input.path, input.filePath, ...(Array.isArray(input.paths) ? input.paths : [])]) {
      const s = str(p);
      if (s) edits.push(s);
    }
  }
  if (cmd) edits.push(...shellEditTargets(unwrap(cmd)));
  const rels = [...new Set(edits.map((p) => relative(p, roots.work)).filter((p): p is string => p !== undefined))].slice(0, 20);
  if (rels.length) o.edits = rels;

  if (kind === "fetch") {
    o.intent = "fetch";
    try {
      const host = cleanHost(new URL(str(input.url) ?? "").hostname);
      if (host) o.host = host;
    } catch {
      // not a URL: a fetch with no host
    }
  }

  if (cmd) {
    const segs = CD_FAILED_RE.test(output) ? [] : classifyCommand(cmd, roots.work);
    const seg = decide(segs, output, call.ok, hit);
    if (seg) {
      if (seg.kind !== "probe") o.intent = seg.kind;
      const form = safeForm(seg.form);
      if (form) o.form = form;
      if (seg.hosts[0]) o.host = seg.hosts[0];
    }
    // Whether the tests ran is read for any test command in the call, since a build that comes first may decide the intent.
    if (segs.some((s) => s.kind === "test")) o.testsRan = LOADED_RE.test(output) || LOADED_GENERIC_RE.test(output);
    const need = ENV_NEED_RE.exec(output)?.[1];
    const set = ENV_PREFIX_RE.exec(cmd)?.[1] ?? ENV_INCODE_RE.exec(cmd)?.[1];
    const envVar = (need ?? set)?.slice(0, 60);
    if (envVar) o.envVar = envVar;
  }
  return o;
}
