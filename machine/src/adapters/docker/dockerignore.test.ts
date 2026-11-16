// The runner image's build context is the repository root, and .dockerignore keeps `machine/runner/*` out except what it
// names again: a file the Dockerfile copies from machine/runner/ must be named there, or `docker build` fails on a fresh clone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe(".dockerignore", () => {
  it("lets in every file the runner image copies from machine/runner/", () => {
    const allowed = readFileSync(join(root, ".dockerignore"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("!machine/runner/"))
      .map((line) => line.slice(1).trim());
    const copied = [...readFileSync(join(root, "machine", "runner", "Dockerfile"), "utf8").matchAll(/^COPY (machine\/runner\/\S+)/gm)].map((m) => m[1]!);
    expect(copied.length).toBeGreaterThan(0);
    for (const path of copied) expect(allowed.some((entry) => path === entry || path.startsWith(`${entry}/`)), path).toBe(true);
  });
});
