// What memory (RFC 0007) reads of a repository's default branch: its tree and blobs at a commit, and a clean copy of the commit's files.
// Everything comes from the repository's object database (the user's own repository, named by its path, never a card's workspace, and
// never a folder a container writes), through a temporary index, so the user's index and checkout are untouched.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { exec, execOrThrow } from "../process/exec.ts";
import { HOST_GIT } from "./worktree.ts";

export interface TreeEntry {
  path: string;
  /** The blob's id: equal blobs have equal ids, so it is the content hash a sync compares. */
  sha: string;
  size: number;
}

const COMMIT = /^[0-9a-f]{40,64}$/;

/** The regular files (not links, not submodules) of `commit`'s tree. */
export async function treeAt(repoPath: string, commit: string): Promise<TreeEntry[]> {
  if (!COMMIT.test(commit)) throw new Error("not a commit id");
  const listed = await exec("git", [...HOST_GIT, "-C", repoPath, "ls-tree", "-r", "-z", "--long", commit], { maxBytes: 64 * 1024 * 1024 });
  if (listed.code !== 0) throw new Error(`cannot list ${commit.slice(0, 8)}: ${listed.stderr.trim().slice(0, 200)}`);
  const entries: TreeEntry[] = [];
  for (const record of listed.stdout.split("\0")) {
    const m = /^(\d{6}) blob ([0-9a-f]{40,64}) +(\d+)\t([\s\S]+)$/.exec(record);
    if (!m || (m[1] !== "100644" && m[1] !== "100755")) continue;
    entries.push({ path: m[4]!, sha: m[2]!, size: Number(m[3]) });
  }
  return entries;
}

/** One blob's bytes (read as text: the files memory reads are documents). */
export async function blobAt(repoPath: string, sha: string): Promise<Buffer> {
  if (!COMMIT.test(sha)) throw new Error("not an object id");
  const out = await exec("git", [...HOST_GIT, "-C", repoPath, "cat-file", "blob", sha], { maxBytes: 8 * 1024 * 1024 });
  if (out.code !== 0) throw new Error(`cannot read ${sha}: ${out.stderr.trim().slice(0, 200)}`);
  return Buffer.from(out.stdout);
}

/**
 * A clean copy of `commit`'s files in a new folder `dest`, with no `.git`: `exportCommit`'s way (a temporary index) on the user's own repository.
 * Links are removed afterwards (the code graph reads files, and a link out of the folder is a way to read what is not there) and the folder is
 * made readable and writable by everyone, because the Cognee container runs as another user and writes beside what it reads.
 */
export async function exportRepoCommit(repoPath: string, commit: string, dest: string): Promise<void> {
  if (!COMMIT.test(commit)) throw new Error("not a commit id");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "luna-main-export-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "read-tree", commit], { env });
    await execOrThrow("git", [...HOST_GIT, "-C", repoPath, "checkout-index", "--all", "--force", `--prefix=${resolve(dest)}/`], { env });
    openUp(dest);
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Removes every link below `dir` and opens the rest to the container's user (a+rwX). Nothing is followed. */
export function openUp(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) unlinkSync(path);
    else if (stat.isDirectory()) openUp(path);
    else if (stat.isFile()) chmodSync(path, 0o666);
  }
  chmodSync(dir, 0o777);
}
