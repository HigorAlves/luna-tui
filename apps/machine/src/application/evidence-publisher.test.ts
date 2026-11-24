// One publisher: the pack check, the head check and the media gate live in `publishAndReady`. A fourth path that calls the storage
// or the GitHub publish directly would skip them, so no source file outside `evidence-publish.ts` may.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["application/evidence-publish.ts", "domain/evidence-markdown.ts"]);
// A call of the publish function (`publish({ github` or `deps.publish(`), the storage's `put`, the storage constructors, the Evidence section's writers.
const FORBIDDEN: Array<[string, RegExp]> = [
  ["publishEvidence", /\bpublishEvidence\b/],
  ["a call of publish", /(?:^|[^.\w])publish\(\s*\{\s*github|\b(?:deps|evidence)\.publish\(/],
  ["a storage put", /\bstorage\.put\(|\.put\(\{\s*slug/],
  ["a storage constructor", /\b(?:releaseAssetStorage|localStorage)\(/],
  ["the Evidence section's merge", /\bmergeSection\(/],
];

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });

describe("the Evidence Pack has one publisher", () => {
  it("no source file outside evidence-publish.ts and the storage adapters publishes a pack itself", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel) || rel.startsWith("adapters/evidence-storage/") || rel === "application/evidence-storage.ts") continue;
      const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const [what, re] of FORBIDDEN) if (re.test(text)) hits.push(`${rel}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it("the scan itself sees a call it should refuse", () => {
    const [, re] = FORBIDDEN[1]!;
    expect(re.test("const done = await publish({ github: deps.github, slug })")).toBe(true);
    expect(re.test("const x = await deps.publish(input)")).toBe(true);
    expect(re.test("this.bus.publish(message)")).toBe(false);
  });
});
