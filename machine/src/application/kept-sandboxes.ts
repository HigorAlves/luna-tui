// A sandbox kept after an escalation: the clone as the agent left it, what it left uncommitted also
// saved as a commit on `refs/luna/kept/<run>`, and the run's extra folders (a fresh clone of Verify or
// a fix) for `sandbox.keep_hours`. The saved commit lives in the card's own repository, never in the folder.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { at } from "../adapters/git/machine-repo.ts";
import { HOST_GIT } from "../adapters/git/worktree.ts";
import { exec } from "../adapters/process/exec.ts";

const HOUR_MS = 3_600_000;
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
/** The only folders the machine removes when a kept sandbox expires: the ones it made for Verify and for fixes. */
const EXTRA_FOLDER = /\.verify-[A-Za-z0-9_-]+$/;

interface KeptRecord {
  taskId: string;
  runId: string;
  keptAt: string;
  /** How long this run is kept; absent, the caller's default. */
  keepHours?: number;
  /** Folders removed when the keep ends. */
  extra: string[];
}

const dirOf = (stateDir: string): string => join(stateDir, "kept");

function write(stateDir: string, record: KeptRecord): void {
  mkdirSync(dirOf(stateDir), { recursive: true });
  writeFileSync(join(dirOf(stateDir), `${record.runId}.json`), JSON.stringify(record));
}

function read(stateDir: string, runId: string): KeptRecord | null {
  try {
    return JSON.parse(readFileSync(join(dirOf(stateDir), `${runId}.json`), "utf8")) as KeptRecord;
  } catch {
    return null;
  }
}

/**
 * Saves what an escalated run left in `path`: a commit of the whole working tree (tracked changes and untracked files,
 * built in a temporary index) on `refs/luna/kept/<run>`, on top of HEAD. The tree, the index and HEAD are not touched.
 */
export async function saveKept(input: { stateDir: string; taskId: string; runId: string; path: string; keepHours: number; now?: Date }): Promise<{ ok: true; ref: string; path: string; until: string } | { ok: false; reason: string }> {
  const { stateDir, taskId, runId, path } = input;
  const now = input.now ?? new Date();
  if (!PLAIN.test(runId)) return { ok: false, reason: "the run id is not a plain name" };
  const scratch = mkdtempSync(join(tmpdir(), "kept-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index"), GIT_AUTHOR_NAME: "luna", GIT_AUTHOR_EMAIL: "luna@localhost", GIT_COMMITTER_NAME: "luna", GIT_COMMITTER_EMAIL: "luna@localhost" };
    const git = (args: string[]) => exec("git", [...HOST_GIT, ...at(path), ...args], { env });
    const added = await git(["add", "-A"]);
    if (added.code !== 0) return { ok: false, reason: `git add failed: ${(added.stderr || added.stdout).trim()}` };
    const tree = await git(["write-tree"]);
    const head = await git(["rev-parse", "--verify", "HEAD"]);
    if (tree.code !== 0 || head.code !== 0) return { ok: false, reason: "the working tree could not be read" };
    const commit = await git(["commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", `luna: what run ${runId} left uncommitted`]);
    if (commit.code !== 0) return { ok: false, reason: `git commit-tree failed: ${(commit.stderr || commit.stdout).trim()}` };
    const ref = `refs/luna/kept/${runId}`;
    const updated = await git(["update-ref", ref, commit.stdout.trim()]);
    if (updated.code !== 0) return { ok: false, reason: `git update-ref failed: ${(updated.stderr || updated.stdout).trim()}` };
    if (!read(stateDir, runId)) write(stateDir, { taskId, runId, keptAt: now.toISOString(), keepHours: input.keepHours, extra: [] });
    return { ok: true, ref, path, until: new Date(now.getTime() + input.keepHours * HOUR_MS).toISOString() };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Registers an extra folder of a run (a fresh clone of Verify or a fix) to be removed when the keep ends. */
export async function keepFolder(input: { stateDir: string; taskId: string; runId: string; path: string; keepHours?: number; now?: Date }): Promise<void> {
  if (!PLAIN.test(input.runId)) return;
  const record = read(input.stateDir, input.runId) ?? { taskId: input.taskId, runId: input.runId, keptAt: (input.now ?? new Date()).toISOString(), keepHours: input.keepHours, extra: [] };
  if (!record.extra.includes(input.path)) record.extra.push(input.path);
  write(input.stateDir, record);
}

/** Removes the extra folders of every kept sandbox older than `keepHours`, or of `taskId` (resumed or closed) at once. The kept refs stay in the clone. Answers the folders removed. */
export async function expireKept(input: { stateDir: string; keepHours: number; now?: Date; taskId?: string }): Promise<string[]> {
  const now = (input.now ?? new Date()).getTime();
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dirOf(input.stateDir));
  } catch {
    return removed;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const record = read(input.stateDir, name.slice(0, -5));
    if (!record) continue;
    const due = input.taskId ? record.taskId === input.taskId : now - Date.parse(record.keptAt) >= (record.keepHours ?? input.keepHours) * HOUR_MS;
    if (!due) continue;
    for (const folder of record.extra) {
      if (!EXTRA_FOLDER.test(basename(folder))) continue;
      rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
    }
    rmSync(join(dirOf(input.stateDir), name), { force: true });
  }
  return removed;
}
