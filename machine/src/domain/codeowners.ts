// GitHub's CODEOWNERS, read by the machine so a shipped PR is not merged without the owners of
// every path it changes. Pure: the syntax is GitHub's (gitignore globs, the last matching rule
// wins, a rule with no owners clears ownership); nothing here reads a file or calls GitHub.

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

export interface RequiredOwners {
  path: string;
  owners: string[];
}

/** A pattern longer than this, or with more wildcards, is not matched: the rule is dropped and reported. */
export const MAX_PATTERN_CHARS = 512;
export const MAX_WILDCARDS = 16;

/** The rules of a CODEOWNERS file in order, and the lines the machine will not match (too long, too many wildcards). */
export function parseCodeownersChecked(text: string): { rules: CodeownersRule[]; problems: string[] } {
  const rules: CodeownersRule[] = [];
  const problems: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    const wildcards = (pattern.match(/[*?]/g) ?? []).length;
    if (pattern.length > MAX_PATTERN_CHARS || wildcards > MAX_WILDCARDS) {
      problems.push(`a CODEOWNERS pattern is too complex to match (${pattern.slice(0, 40)}${pattern.length > 40 ? "…" : ""})`);
      continue;
    }
    rules.push({ pattern, owners });
  }
  return { rules, problems };
}

/** The rules of a CODEOWNERS file in order; comments, inline comments and blank lines dropped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  return parseCodeownersChecked(text).rules;
}

/** `*` and `?` within one path segment, by the two-pointer wildcard walk: O(pattern x text), no backtracking blowup. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Whether a CODEOWNERS pattern covers a repo-relative path, without building a regular expression.
 *  Segments: `**` as a whole segment is zero or more of them. A trailing slash means a directory (something must be below it);
 *  a wildcard in the last segment matches files only; a literal last segment matches the file or the directory of that name. */
function covers(pattern: string, path: string): boolean {
  const anchored = pattern.startsWith("/") || pattern.slice(0, -1).includes("/");
  const directory = pattern.endsWith("/");
  const core = pattern.replace(/^\//, "").replace(/\/$/, "");
  const segs = [...(anchored ? [] : ["**"]), ...core.split("/")];
  const parts = path.split("/").filter((x) => x !== "");
  const last = segs[segs.length - 1] ?? "";
  // reach[i][j]: the first i pattern segments can cover the first j path segments.
  let row = Array.from({ length: parts.length + 1 }, (_, j) => j === 0);
  for (const seg of segs) {
    const next = new Array<boolean>(parts.length + 1).fill(false);
    if (seg === "**") {
      next[0] = row[0]!;
      for (let j = 1; j <= parts.length; j++) next[j] = row[j]! || next[j - 1]!;
    } else {
      for (let j = 1; j <= parts.length; j++) next[j] = row[j - 1]! && segmentMatches(seg, parts[j - 1]!);
    }
    row = next;
  }
  const wildcard = /[*?]/.test(last);
  for (let j = 0; j <= parts.length; j++) {
    if (!row[j]) continue;
    const rest = parts.length - j;
    if (directory ? rest >= 1 : wildcard ? rest === 0 : true) return true;
  }
  return false;
}

/** Owners of one path: the last rule that matches, or none. */
export function ownersOf(path: string, rules: CodeownersRule[]): string[] {
  const clean = path.replace(/^\//, "");
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (covers(rule.pattern, clean)) return rule.owners;
  }
  return [];
}

/** The changed paths that have owners, each with them. */
export function requiredOwners(paths: string[], rules: CodeownersRule[]): RequiredOwners[] {
  const out: RequiredOwners[] = [];
  for (const path of paths) {
    const owners = ownersOf(path, rules);
    if (owners.length > 0) out.push({ path, owners });
  }
  return out;
}

const lower = (s: string) => s.toLowerCase();

/** Which required paths an owner approved, which are still missing one, and which owners the machine cannot resolve:
 *  `@user` by login, `@org/team` by its members (absent from `members`: unresolved), an email always unresolved. */
export function ownerApprovals(
  required: RequiredOwners[],
  approvals: { approvers: string[]; members: Record<string, string[]> },
): { satisfied: { path: string; by: string }[]; missing: RequiredOwners[]; unresolved: string[] } {
  const approved = new Set(approvals.approvers.map(lower));
  const members = new Map(Object.entries(approvals.members).map(([team, who]) => [lower(team), who.map(lower)]));
  const satisfied: { path: string; by: string }[] = [];
  const missing: RequiredOwners[] = [];
  const unresolved: string[] = [];
  for (const { path, owners } of required) {
    let by: string | null = null;
    for (const owner of owners) {
      if (!owner.startsWith("@")) {
        if (!unresolved.includes(owner)) unresolved.push(owner);
        continue;
      }
      const name = lower(owner.slice(1));
      if (name.includes("/")) {
        const team = members.get(name);
        if (!team) {
          if (!unresolved.includes(owner)) unresolved.push(owner);
          continue;
        }
        const hit = team.find((m) => approved.has(m));
        if (hit && by === null) by = hit;
      } else if (approved.has(name) && by === null) by = name;
    }
    if (by === null) missing.push({ path, owners });
    else satisfied.push({ path, by });
  }
  return { satisfied, missing, unresolved };
}
