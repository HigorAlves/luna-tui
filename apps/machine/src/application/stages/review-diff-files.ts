// A big PR's diff as files, for the passes: one `<path>.diff` per file and `all.diff`, in a folder of the machine's own
// under its state directory (`<stateDir>/runs/<runId>-prdiff`), mounted read-only at /pr-diff in a pass's container. The
// passes read the files they need instead of carrying the whole diff in a prompt.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DiffFile } from "./review-diff.ts";

/** Where the folder is in a pass's container. */
export const PR_DIFF_MOUNT = "/pr-diff";

/** A path from the diff as a safe relative path: no empty, `.` or `..` segments. */
const safeRel = (path: string): string => path.split("/").filter((p) => p !== "" && p !== "." && p !== "..").join("/");

export async function writeDiffFiles(stateDir: string, runId: string, files: readonly DiffFile[], whole: string): Promise<{ host: string }> {
  const host = join(stateDir, "runs", `${runId}-prdiff`);
  await rm(host, { recursive: true, force: true });
  await mkdir(host, { recursive: true, mode: 0o755 });
  await writeFile(join(host, "all.diff"), whole, { mode: 0o644 });
  for (const f of files) {
    const rel = safeRel(f.path);
    if (rel === "" || rel === "all.diff") continue;
    const target = join(host, `${rel}.diff`);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, f.text, { mode: 0o644 });
  }
  return { host };
}

export const removeDiffFiles = (host: string): Promise<void> => rm(host, { recursive: true, force: true });
