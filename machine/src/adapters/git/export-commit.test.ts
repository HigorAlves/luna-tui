import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensureClone } from "./clone.ts";
import { machineGitDir } from "./machine-repo.ts";
import { exportCommit, workspaceFor } from "./worktree.ts";

const base = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const plain = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...base, ...args], { encoding: "utf8" }).trim();

describe("exportCommit", () => {
  it("writes a commit's files from the card's machine-owned repository, not from what the work folder holds now, and leaves the folder alone", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "export-")));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    plain(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    plain(repo, "add", "-A");
    plain(repo, "commit", "-q", "-m", "init");
    const workspace = workspaceFor({ id: "11111111-2222-3333-4444-555555555555", title: "Fix it" } as never, repo, join(root, "cards"));
    await ensureClone(repo, workspace);
    const commit = execFileSync("git", [`--git-dir=${machineGitDir(workspace.path)}`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    // The folder drifts after the commit: an untracked file and an edit. Neither may reach the export.
    writeFileSync(join(workspace.path, "src", "a.ts"), "tampered\n");
    writeFileSync(join(workspace.path, "extra.txt"), "x\n");

    const dest = join(root, "export");
    await exportCommit(workspace.path, commit, dest);
    expect(readFileSync(join(dest, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(dest, "extra.txt"))).toBe(false);
    expect(readdirSync(dest).sort()).toEqual(["src"]);
    expect(readFileSync(join(workspace.path, "src", "a.ts"), "utf8")).toBe("tampered\n");
  });

  it("refuses a name that is not a commit id", async () => {
    await expect(exportCommit("/nowhere", "main", join(tmpdir(), "never"))).rejects.toThrow("not a commit id");
  });
});
