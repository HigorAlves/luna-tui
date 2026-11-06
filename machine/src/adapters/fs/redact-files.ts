// The files a run left in its `out/files` can hold a secret a tool typed or a request carried (a HAR, a steps log). The walk follows no link, reads
// each regular text file within its cap through the bounded reader, and replaces it by rename only when the text changed.
import { lstat, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { readRegularFile } from "./bounded.ts";

const TEXT = /\.(json|jsonl|har|log|txt|md|html)$/i;
const CAP = 20 * 1024 * 1024;

/** The paths (relative to `dir`) of the files whose text changed. */
export async function redactFiles(dir: string, redact: (text: string) => string): Promise<string[]> {
  const changed: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && TEXT.test(name) && info.size <= CAP) {
        const text = await readRegularFile(path, CAP).catch(() => null);
        if (text === null) continue;
        const out = redact(text);
        if (out === text) continue;
        const temp = `${path}.redacting`;
        await writeFile(temp, out, { mode: info.mode & 0o777 });
        await rename(temp, path);
        changed.push(relative(dir, path));
      }
    }
  };
  await walk(dir);
  return changed;
}
