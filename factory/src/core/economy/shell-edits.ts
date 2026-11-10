// The files a shell command writes, so a `sed -i` or a `> file` counts as an edit like an Edit tool
// call does. Ported from TokenEconomizer's loop guard (RFC 0007), with these differences: it returns
// the paths as written, not their base names (the caller makes them repo-relative); a `#` comment
// ends at its newline, which stays an operator; a run of operator characters is split into the
// operators it holds (`;\n` is two); and `bash -lc '<script>'` is read through.

const OPS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "\n", "(", ")"]);
const OUT = new Set([">", ">>", ">|", "&>", "&>>"]); // redirects that write their operand
const SKIP_OPERAND = new Set(["<", "<<", "<<<", "<&", ">&", "<>"]); // input, heredoc tags, fd duplication
const OPS3 = ["&>>", "<<<"];
const OPS2 = ["&&", "||", ";;", "|&", ">>", ">|", "&>", "<<", "<&", ">&", "<>"];
const PUNCT = new Set(["(", ")", ";", "<", ">", "|", "&", "\n"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Redirect and `tee` targets count only when they look like source, so `> out.log` is not mistaken for an edit. */
const SOURCE_FILE =
  /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|rb|php|cs|swift|m|mm|sh|bash|zsh|lua|jl|ex|exs|erl|hs|ml|clj|sql|toml|ya?ml|json|cfg|ini|conf|md|rst|html?|css|scss|vue|svelte|xml|gradle|properties|in)$/i;
const HEREDOC_START = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_]\w*)\1/;
const PYTHON = /(?:^|[\s/;&|(])python\d?(?:\.\d+)?\b/;
const PY_OPEN_LIT = /open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"]*)\3/g;
const PY_OPEN_VAR = /open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])([^'"]*)\2/g;
const PY_WRITE_PATH_LIT = /(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g;
const PY_WRITE_PATH_VAR = /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g;
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm;

const basename = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
const notScratch = (p: string): boolean => p !== "" && !/^\/(?:dev|proc|tmp)\//.test(p);
const unquote = (t: string): string => (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0] ? t.slice(1, -1) : t);

/** The shell text without heredoc bodies, and the bodies. An unterminated body still counts. */
function splitHeredocs(cmd: string): { shell: string; bodies: string[] } {
  const shell: string[] = [];
  const bodies: string[] = [];
  let tag: string | undefined;
  let body: string[] = [];
  for (const line of cmd.split(/\r\n|\n|\r/)) {
    if (tag !== undefined) {
      if (line.trim() === tag) {
        bodies.push(body.join("\n"));
        tag = undefined;
        body = [];
      } else body.push(line);
      continue;
    }
    shell.push(line);
    tag = HEREDOC_START.exec(line)?.[2];
  }
  if (tag !== undefined) bodies.push(body.join("\n"));
  return { shell: shell.join("\n"), bodies };
}

/** A non-POSIX shlex with operator characters: a quote only opens a word, stays on it and ends it; an operator is its own token. */
function tokenize(text: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\r") i++;
    else if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (PUNCT.has(c)) {
      const op = OPS3.find((o) => text.startsWith(o, i)) ?? OPS2.find((o) => text.startsWith(o, i)) ?? c;
      out.push(op);
      i += op.length;
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return undefined;
      out.push(text.slice(i, end + 1));
      i = end + 1;
    } else {
      let j = i;
      while (j < text.length && !" \t\r#".includes(text[j] as string) && !PUNCT.has(text[j] as string)) j++;
      out.push(text.slice(i, j));
      i = j;
    }
  }
  return out;
}

/** Tokens of a shell text; on an unbalanced quote each line is read alone and a bad line is skipped. */
function tokens(shell: string): string[] {
  const whole = tokenize(shell);
  if (whole) return whole;
  const out: string[] = [];
  for (const line of shell.split("\n")) {
    const t = tokenize(line);
    if (t) out.push(...t, "\n");
  }
  return out;
}

/** The simple commands of a shell text, and the files its redirects write. */
function commands(shell: string): { commands: string[][]; redirects: string[] } {
  const toks = tokens(shell);
  const cmds: string[][] = [];
  const redirects: string[] = [];
  let cur: string[] = [];
  const flush = (): void => {
    if (cur.length) cmds.push(cur);
    cur = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as string;
    if (OPS.has(t)) {
      flush();
      continue;
    }
    if (OUT.has(t) || SKIP_OPERAND.has(t)) {
      if (cur.length && /^\d+$/.test(cur[cur.length - 1] as string)) cur.pop();
      const operand = toks[i + 1];
      if (operand !== undefined && !OPS.has(operand)) {
        if (OUT.has(t)) redirects.push(unquote(operand));
        i++;
      }
      continue;
    }
    cur.push(unquote(t));
  }
  flush();
  return { commands: cmds, redirects };
}

/** Drops `sudo`, `command`, `env`, `time`, `nohup` and `NAME=value` words from the front. */
function bare(cmd: string[]): string[] {
  let i = 0;
  while (i < cmd.length && (["sudo", "command", "env", "time", "nohup"].includes(cmd[i] as string) || /^[A-Za-z_]\w*=/.test(cmd[i] as string))) i++;
  return cmd.slice(i);
}

type ScriptFlag = "next" | "inline" | undefined;

/** For a short cluster like `-ne` or `-i.bak`: a stop letter takes the rest as its value; a script letter takes the script from the rest, or from the next token. */
function shortScriptFlag(t: string, script: string, stop: string): ScriptFlag {
  for (let j = 1; j < t.length; j++) {
    const c = t[j] as string;
    if (stop.includes(c)) return undefined;
    if (script.includes(c)) return j + 1 < t.length ? "inline" : "next";
  }
  return undefined;
}

function sedScriptFlag(t: string): ScriptFlag {
  if (t === "--expression" || t === "--file") return "next";
  if (t.startsWith("--expression=") || t.startsWith("--file=")) return "inline";
  return t.startsWith("-") && !t.startsWith("--") ? shortScriptFlag(t, "ef", "i") : undefined;
}

function perlScriptFlag(t: string): ScriptFlag {
  return t.startsWith("-") && !t.startsWith("--") ? shortScriptFlag(t, "eE", "iIMmxdDC") : undefined;
}

/** The file operands of an in-place editor: everything after the script, which is the first operand unless a flag gave it. */
function inplaceFiles(toks: string[], scriptFlag: (t: string) => ScriptFlag): string[] {
  const files: string[] = [];
  let known = false;
  let skip = false;
  for (const t of toks.slice(1)) {
    if (skip) {
      skip = false;
      known = true;
    } else if (t.startsWith("-") && t.length > 1) {
      const f = scriptFlag(t);
      if (f === "next") skip = true;
      else if (f === "inline") known = true;
    } else if (!known) known = true;
    else files.push(t);
  }
  return files;
}

/** Paths an inline Python script opens for writing; a variable resolves through its assignment or `for` loop, else the pseudo-name `(script)`. */
function pyWrites(text: string): string[] {
  const out: string[] = [];
  const resolve = (name: string): string[] => {
    const found: string[] = [];
    const assign = new RegExp(`\\b${name}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(['"])([^'"\\n]+)\\1`, "g");
    for (const m of text.matchAll(assign)) found.push(m[2] as string);
    const loop = new RegExp(`for\\s+${name}\\s+in\\s+[\\[(]([^\\])]*)[\\])]`);
    const items = loop.exec(text)?.[1];
    if (items) for (const m of items.matchAll(/(['"])([^'"\n]+)\1/g)) found.push(m[2] as string);
    return found.length ? found : ["(script)"];
  };
  for (const m of text.matchAll(PY_OPEN_LIT)) if (/[waxX+]/.test(m[4] as string)) out.push(m[2] as string);
  for (const m of text.matchAll(PY_WRITE_PATH_LIT)) out.push(m[2] as string);
  for (const m of text.matchAll(PY_OPEN_VAR)) if (/[waxX+]/.test(m[3] as string)) out.push(...resolve(m[1] as string));
  for (const m of text.matchAll(PY_WRITE_PATH_VAR)) out.push(...resolve(m[1] as string));
  return out;
}

/** The script handed to `bash -lc`, when the command is one. */
function wrapped(toks: string[]): string | undefined {
  const [a, b, c] = toks;
  return a !== undefined && b !== undefined && c !== undefined && SHELLS.has(basename(a)) && b.startsWith("-") && b.includes("c") ? c : undefined;
}

function targets(cmd: string, depth: number): string[] {
  if (!cmd.trim()) return [];
  const { shell, bodies } = splitHeredocs(cmd);
  const { commands: cmds, redirects } = commands(shell);
  const found: string[] = redirects.filter((p) => SOURCE_FILE.test(p));
  for (const c of cmds) {
    const toks = bare(c);
    if (!toks.length) continue;
    const head = basename(toks[0] as string);
    const rest = toks.slice(1);
    const inner = depth < 3 ? wrapped(toks) : undefined;
    if (inner !== undefined) found.push(...targets(inner, depth + 1));
    else if (head === "sed" && rest.some((t) => /^(?:-[a-zA-Z]*i|--in-place)/.test(t))) found.push(...inplaceFiles(toks, sedScriptFlag));
    else if (head === "perl" && rest.some((t) => /^-[a-zA-Z]*i/.test(t))) found.push(...inplaceFiles(toks, perlScriptFlag));
    else if (head === "tee") found.push(...rest.filter((t) => !t.startsWith("-") && SOURCE_FILE.test(t)));
    else if (head === "apply_patch") {
      const named = [...`${bodies.join("\n")}\n${rest.join(" ")}`.matchAll(PATCH_FILE)].map((m) => m[1] as string);
      found.push(...(named.length ? named : ["(patch)"]));
    } else if (head === "patch" || (head === "git" && toks[1] === "apply")) found.push("(patch)");
  }
  if (PYTHON.test(shell)) found.push(...pyWrites(`${shell}\n${bodies.join("\n")}`));
  return found;
}

/** Paths a command writes by `sed -i`, `perl -pi`, `tee`, `apply_patch`, an output redirect or inline Python: scratch paths and pseudo-names dropped, in order, without repeats. */
export function shellEditTargets(cmd: string): string[] {
  if (typeof cmd !== "string") return [];
  return [...new Set(targets(cmd, 0).filter((p) => !p.startsWith("(") && notScratch(p)))];
}

/** Paths a command puts back with `git checkout -- <paths>` or `git restore <paths>`. */
export function shellRevertTargets(cmd: string): string[] {
  if (typeof cmd !== "string" || !cmd.trim()) return [];
  const out: string[] = [];
  for (const c of commands(splitHeredocs(cmd).shell).commands) {
    const toks = bare(c);
    if (basename(toks[0] ?? "") !== "git") continue;
    const sub = toks[1];
    const rest = toks.slice(2);
    const dash = rest.indexOf("--");
    const paths = dash >= 0 ? rest.slice(dash + 1) : sub === "restore" ? rest : [];
    if (sub === "checkout" || sub === "restore") out.push(...paths.filter((t) => !t.startsWith("-")));
  }
  return [...new Set(out.filter(notScratch))];
}
