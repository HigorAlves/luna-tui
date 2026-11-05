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
    for (const option of ["core.hooksPath=/dev/null", "core.fsmonitor=", "diff.external=", "submodule.recurse=false", "protocol.ext.allow=never", "--no-optional-locks"]) expect(args).toContain(option);
  });

  // Two callers read a path the user chose (a repository map, a pull request's folder), never a card's workspace.
  const NOT_A_WORKSPACE = new Set(["application/repo-map.ts", "application/pulls.ts"]);

  it("is the only way the machine's sources call git: every call carries HOST_GIT", () => {
    const bypass: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (NOT_A_WORKSPACE.has(rel)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/\b(?:exec|execOrThrow|run|execFileSync|spawn)\(\s*"git",/.test(line) && !line.includes("HOST_GIT") && !/"git", git\(/.test(line)) bypass.push(`${rel}:${i + 1}`);
      });
    }
    expect(bypass).toEqual([]);
  });

  it("builds the rebase's own git calls from HOST_GIT, not a copy of its options", () => {
    expect(readFileSync(join(SRC, "adapters/git/worktree.ts"), "utf8")).not.toMatch(/\["-c", "core\.hooksPath=\/dev\/null"/);
  });
});
