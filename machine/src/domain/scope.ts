// The facts about a change's scope, computed from git and never asked of a model: which files it
// changed outside the plan, which tests it removed, what it added to a dependency manifest, which
// TODOs and secret-looking lines it added. scope_check judges the declared reasons against these. Pure.
import picomatch from "picomatch";

import { lockedFilesRemoved } from "./locked-files.ts";

/** A line a diff added, with its file and, in a toml file, the `[section]` it sits under. */
export interface AddedLine {
  path: string;
  line: string;
  section?: string;
}

export interface ScopeFacts {
  /** Every file the change touched (the new path of a rename). */
  changed: string[];
  /** Changed, not planned and not declared; empty when the plan names no files at all. */
  undeclared: string[];
  removedTests: string[];
  newDependencies: string[];
  todos: string[];
  secrets: string[];
}

const TOML = /\.toml$/;
const HEADER = /^\[+([^\]]+)\]+\s*$/;
const TOKEN = /xox[abposr]-|ghp_|github_pat_|\bsk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12}|eyJ[A-Za-z0-9_-]{20,}/;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|[^/]+\.pem|[^/]+\.key)$/;

/** The added lines of a unified diff (`git diff <from> <to>`). */
export function addedLinesOf(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let path = "";
  let section: string | undefined;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      path = raw.slice(4).replace(/^b\//, "");
      section = undefined;
    } else if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      continue;
    } else if (raw.startsWith("@@")) {
      section = undefined;
    } else if (path && (raw.startsWith("+") || raw.startsWith(" "))) {
      const line = raw.slice(1);
      const header = TOML.test(path) ? HEADER.exec(line.trim()) : null;
      if (header) section = header[1];
      if (raw.startsWith("+")) added.push({ path, line, ...(section && TOML.test(path) ? { section } : {}) });
    }
  }
  return added;
}

/** The changed paths of `git diff --name-status`: a rename or copy counts under its new path. */
function changedOf(nameStatus: string): string[] {
  return nameStatus
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [, ...paths] = line.split("\t");
      return paths.at(-1) ?? "";
    })
    .filter(Boolean);
}

const GLOB = /[*?[\]{}!]/;
function isPlanned(path: string, planned: string[]): boolean {
  return planned.some((entry) => {
    const bare = entry.replace(/^\.\//, "");
    if (bare === path) return true;
    if (GLOB.test(bare)) return picomatch.isMatch(path, bare, { dot: true });
    return path.startsWith(`${bare.replace(/\/$/, "")}/`);
  });
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function dependencyOf({ path, line, section }: AddedLine): string | null {
  const file = base(path);
  const text = line.trim();
  if (file === "package.json") {
    const m = /^"([^"]+)"\s*:\s*"([^"]+)"\s*,?$/.exec(text);
    if (!m || ["version", "node", "npm", "pnpm", "yarn"].includes(m[1]!)) return null;
    return /^([~^<>=]*\d|workspace:|npm:|latest$|\*$|git|file:|link:)/.test(m[2]!) ? `${path}: ${m[1]} ${m[2]}` : null;
  }
  if (file === "go.mod") {
    const m = /^(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+(v\d\S*)/.exec(text);
    return m ? `${path}: ${m[1]} ${m[2]}` : null;
  }
  if (file === "Cargo.toml") {
    const m = /^([\w-]+)\s*=\s*("|\{)/.exec(text);
    return m && section?.endsWith("dependencies") ? `${path}: ${m[1]}` : null;
  }
  if (file === "pyproject.toml") {
    const m = /^"([A-Za-z0-9_.-]+(?:\[[^\]]*\])?\s*(?:[<>=!~;].*)?)"\s*,?$/.exec(text);
    return m && (section === undefined || /dependencies/.test(section)) && /^[A-Za-z]/.test(m[1]!) && !/^(name|version)\b/.test(m[1]!) ? `${path}: ${m[1]}` : null;
  }
  if (/^requirements.*\.txt$/.test(file)) {
    const m = /^([A-Za-z0-9_.-]+(?:\[[^\]]*\])?\s*(?:[<>=!~].*)?)$/.exec(text);
    return m && !text.startsWith("#") ? `${path}: ${m[1]}` : null;
  }
  return null;
}

export function scopeFacts(input: { nameStatus: string; addedLines: AddedLine[]; planned: string[]; declared: { path: string; reason?: string }[] }): ScopeFacts {
  const changed = changedOf(input.nameStatus);
  const declared = new Set(input.declared.map((d) => d.path));
  const deleted = new Set(input.nameStatus.split("\n").filter((l) => l.startsWith("D\t")).map((l) => l.slice(2)));
  return {
    changed,
    undeclared: input.planned.length === 0 ? [] : changed.filter((p) => !isPlanned(p, input.planned) && !declared.has(p)),
    removedTests: lockedFilesRemoved(input.nameStatus),
    newDependencies: input.addedLines.flatMap((l) => dependencyOf(l) ?? []),
    todos: input.addedLines.filter((l) => /\b(TODO|FIXME|XXX)\b/.test(l.line)).map((l) => `${l.path}: ${l.line.trim()}`),
    secrets: [
      ...changed.filter((p) => !deleted.has(p) && SECRET_FILE.test(p)),
      ...input.addedLines.filter((l) => TOKEN.test(l.line)).map((l) => `${l.path}: ${l.line.trim()}`),
    ],
  };
}
