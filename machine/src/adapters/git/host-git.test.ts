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

  /** The forms a git call may take with no exemption: on a workspace, pinned to the machine's repository (`at`, or the card repository's git dir named outright); on the user's own repository, by its path. */
  const PINNED = [/\.\.\.at\(/, /\.\.\.inMachine\(/, /"--git-dir=/, /"-C", (?:repoPath|repo|row\.repo_path|task\.repoPath)\b/];

  /**
   * The only calls that are neither: a fixed list of file and function pairs, each with why. Nothing else is exempt, and a comment never is.
   * A path the user chose (never a card's workspace); a folder the machine has just made itself and no container has seen; a read-only
   * checkout of the repository the machine made (no container can write it); a helper the caller pins.
   */
  const EXEMPT: Array<[file: string, fn: string]> = [
    ["application/repo-map.ts", "for"],
    ["application/pulls.ts", "clone"],
    ["application/pulls.ts", "isCheckoutRoot"],
    ["adapters/git/worktree.ts", "ensureCleanCheckout"],
    ["adapters/git/worktree.ts", "git"], // rebaseOntoDefault's helper: pinned inside
    ["adapters/git/worktree.ts", "originSlugOf"], // pinned for a workspace, fails closed under the workspaces directory, else a repository's own path
    ["adapters/git/clone.ts", "seedMachineRepo"],
    ["adapters/git/clone.ts", "refreshScratch"],
    ["adapters/git/clone.ts", "moveToClone"],
    ["adapters/git/clone.ts", "copiedSettings"],
  ];

  /** The name of the function a position is inside: the nearest declaration above it. */
  function enclosing(text: string, index: number): string {
    const lines = text.slice(0, index).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(lines[i]!) ?? /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/.exec(lines[i]!) ?? /^\s{2,}(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/.exec(lines[i]!);
      if (m) return m[1]!;
    }
    return "";
  }

  /** Every call of git in a source, across lines: its position and the whole text of the call. */
  function gitCalls(text: string): Array<{ index: number; call: string }> {
    const found: Array<{ index: number; call: string }> = [];
    const start = /\b(?:exec|execOrThrow|run|execFileSync|execFile|spawn|spawnSync|deps\.exec|this\.exec)\(\s*"git"\s*,/g;
    for (let m = start.exec(text); m; m = start.exec(text)) {
      let depth = 0;
      let end = m.index + m[0].indexOf("(");
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) break;
      }
      found.push({ index: m.index, call: text.slice(m.index, end + 1) });
    }
    return found;
  }

  it("is the only way the machine's sources call git: every call carries HOST_GIT, and one on a workspace is pinned to the machine's repository (calls read across lines)", () => {
    const bypass: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      const text = readFileSync(file, "utf8");
      for (const { index, call } of gitCalls(text)) {
        const fn = enclosing(text, index);
        const line = text.slice(0, index).split("\n").length;
        if (EXEMPT.some(([f, name]) => f === rel && name === fn)) continue;
        if (!call.includes("HOST_GIT") && !/"git",\s*git\(/.test(call)) bypass.push(`${rel}:${line} in ${fn || "(top level)"}: no HOST_GIT`);
        else if (!PINNED.some((re) => re.test(call))) bypass.push(`${rel}:${line} in ${fn || "(top level)"}: not pinned`);
      }
    }
    expect(bypass).toEqual([]);
  });

  it("finds a call that spans lines, and takes no comment as an exemption", () => {
    const text = 'await exec(\n  "git",\n  [...HOST_GIT, "status"],\n); // read-only checkout\n';
    expect(gitCalls(text)).toHaveLength(1);
    expect(PINNED.some((re) => re.test(gitCalls(text)[0]!.call))).toBe(false);
  });

  it("builds the rebase's own git calls from HOST_GIT, not a copy of its options", () => {
    expect(readFileSync(join(SRC, "adapters/git/worktree.ts"), "utf8")).not.toMatch(/\["-c", "core\.hooksPath=\/dev\/null"/);
  });
});
