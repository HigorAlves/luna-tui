import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

/** A folder name for a repo: its name, lowercased and safe, and 8 hex of its real path's sha1,
 *  so two repos called `api` never share a graph. */
export function repoSlug(repoPath: string): string {
  let real: string;
  try {
    real = realpathSync(repoPath);
  } catch {
    real = resolve(repoPath);
  }
  const name = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${name}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
}
