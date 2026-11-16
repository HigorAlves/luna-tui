// A repo-relative path, resolved to a real path that must stay inside the repository's checkout. The path comes from repo-controlled
// text (a devcontainer.json), so `..`, an absolute path and a symlink that leads out are refused: both ends go through realpath.
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type InsideRepo = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

export async function insideRepo(repoPath: string, rel: string): Promise<InsideRepo> {
  if (isAbsolute(rel)) return { ok: false, reason: "the path is absolute, not relative to the repository" };
  let root: string;
  let real: string;
  try {
    root = await realpath(repoPath);
    real = await realpath(join(root, rel));
  } catch {
    return { ok: false, reason: "the path does not exist in the repository" };
  }
  const inner = relative(root, real);
  if (inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner)) return { ok: false, reason: "the path leaves the repository (through .. or a link)" };
  return { ok: true, abs: real, rel: inner === "" ? "." : inner.split(sep).join("/") };
}
