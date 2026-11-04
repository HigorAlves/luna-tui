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

/** The rules of a CODEOWNERS file in order; comments, inline comments and blank lines dropped. */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({ pattern, owners });
  }
  return rules;
}

const escape = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** The regular expression a CODEOWNERS pattern means, against a repo-relative path without a leading slash. */
function regexOf(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  const directory = p.endsWith("/");
  p = p.replace(/^\//, "").replace(/\/$/, "");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        const leading = i === 0 && p[i + 2] === "/";
        const trailing = i + 2 === p.length;
        const middle = p[i - 1] === "/" && p[i + 2] === "/";
        if (leading) {
          out += "(?:.*/)?";
          i += 2;
        } else if (middle) {
          out += "(?:.*/)?";
          i += 2;
        } else if (trailing) {
          out += ".*";
          i += 1;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += escape(c);
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A directory (trailing slash) owns everything below it; a literal name matches the file or the directory of that name;
  // a wildcard in the last segment matches files only (GitHub: `docs/*` is not `docs/**`).
  const last = p.split("/").pop() ?? "";
  const tail = directory ? "/.*" : /[*?]/.test(last) ? "" : "(?:/.*)?";
  return new RegExp(`${prefix}${out}${tail}$`);
}

/** Owners of one path: the last rule that matches, or none. */
export function ownersOf(path: string, rules: CodeownersRule[]): string[] {
  const clean = path.replace(/^\//, "");
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (regexOf(rule.pattern).test(clean)) return rule.owners;
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
