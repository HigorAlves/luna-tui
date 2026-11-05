import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { HOST_GIT } from "./worktree.ts";

const SRC = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("host-side git on a workspace", () => {
  it("runs with hooks, the file-system monitor, external diff, submodule recursion and ext transports off", () => {
    const args = HOST_GIT.join(" ");
    for (const option of ["core.hooksPath=/dev/null", "core.fsmonitor=", "diff.external=", "submodule.recurse=false", "protocol.ext.allow=never", "--no-optional-locks", "--no-replace-objects"]) expect(args).toContain(option);
  });

  // Two callers read a path the user chose (a repository map, a pull request's folder), never a card's workspace.
  const NOT_A_WORKSPACE = new Set(["application/repo-map.ts", "application/pulls.ts"]);

  /** The forms a git call may take: on a workspace, pinned to the machine's repository (`at`, or the repository's git dir named outright); on the user's own repository, by its path; or on a folder the machine has just made itself and no container has seen. */
  const ALLOWED = [/\.\.\.at\(/, /\.\.\.inMachine\(/, /"--git-dir=/, /"-C", (?:repoPath|repo|row\.repo_path|task\.repoPath|staging|old)\b/, /HOST_GIT, "(?:init|clone)"/, /\/\/ (?:read-only checkout|legacy worktree|scratch staging)/, /"git", git\(/, /\.\.\.gitArgs/, /existsSync\(machineGitDir\(/];

  it("is the only way the machine's sources call git: every call carries HOST_GIT, and one on a workspace is pinned to the machine's repository", () => {
    const bypass: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (NOT_A_WORKSPACE.has(rel)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (!/\b(?:exec|execOrThrow|run|execFileSync|spawn)\(\s*"git",|deps\.exec\(\s*"git",/.test(line)) return;
        if (!line.includes("HOST_GIT") && !/"git", git\(/.test(line)) bypass.push(`${rel}:${i + 1}`);
        else if (!ALLOWED.some((re) => re.test(line))) bypass.push(`${rel}:${i + 1} (not pinned)`);
      });
    }
    expect(bypass).toEqual([]);
  });

  it("builds the rebase's own git calls from HOST_GIT, not a copy of its options", () => {
    expect(readFileSync(join(SRC, "adapters/git/worktree.ts"), "utf8")).not.toMatch(/\["-c", "core\.hooksPath=\/dev\/null"/);
  });
});
