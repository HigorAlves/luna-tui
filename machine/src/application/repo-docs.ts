// The claiming repository's docs, for the reply draft: README.md and docs/**/*.md of its checkout, regular files only (no symlink is followed, to
// a file or a directory), at most 200 files and 256 KB of each, cut into sections by heading; the three that best match the text, 1500 characters each.
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { similarity } from "../domain/similarity.ts";

const MAX_FILES = 200;
const MAX_BYTES = 256 * 1024;
const SECTION_CAP = 1500;
const TOP = 3;

async function mdFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (found.length >= MAX_FILES) return;
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && name.toLowerCase().endsWith(".md") && info.size <= MAX_BYTES) found.push(path);
    }
  };
  const readme = join(root, "README.md");
  const top = await lstat(readme).catch(() => null);
  if (top?.isFile() && top.size <= MAX_BYTES) found.push(readme);
  await walk(join(root, "docs"));
  return found;
}

export async function repoDocs(repoPath: string, text: string): Promise<string[]> {
  const sections: Array<{ name: string; body: string }> = [];
  for (const file of await mdFiles(repoPath)) {
    const handle = await open(file, "r").catch(() => null);
    if (!handle) continue;
    const content = await handle.readFile({ encoding: "utf8" }).catch(() => "");
    await handle.close();
    const name = file.slice(repoPath.length + 1);
    let current: string[] = [];
    const flush = (): void => {
      if (current.join("").trim() !== "") sections.push({ name, body: current.join("\n") });
      current = [];
    };
    for (const line of content.split("\n")) {
      if (/^#{1,6}\s/.test(line)) flush();
      current.push(line);
    }
    flush();
  }
  return sections
    .map((s) => ({ ...s, score: similarity(text, s.body) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, TOP)
    .map((s) => `${s.name}: ${s.body.replace(/\s+/g, " ").trim()}`.slice(0, SECTION_CAP));
}
