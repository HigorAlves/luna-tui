import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const githubDir = resolve(root, ".github");
const readmePath = resolve(githubDir, "README.md");
const read = (): string => (existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "");

describe(".github/README.md install guide", () => {
  // @scenario:S1
  it("S1 @scenario:S1 root README.md is absent and .github/README.md exists", () => {
    expect(existsSync(resolve(root, "README.md"))).toBe(false);
    expect(existsSync(readmePath)).toBe(true);
  });

  // @scenario:S2
  it("S2 @scenario:S2 every relative link and the logo src resolves from .github/", () => {
    const text = read();
    expect(text).not.toBe("");
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/src="([^"]+)"/g)]
      .map((m) => m[1] as string)
      .filter((t) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t))
      .map((t) => t.split("#")[0] as string)
      .filter((t) => t !== "");
    expect(targets).toContain("../board/icon.png");
    const missing = targets.filter((t) => !existsSync(resolve(githubDir, t)));
    expect(missing).toEqual([]);
  });

  // @scenario:S3
  it("S3 @scenario:S3 it has a centred div with an img of width 112, the title and the tagline", () => {
    const head = read().split("\n").slice(0, 12).join("\n");
    expect(head).toMatch(/<div align="center">/);
    expect(head).toMatch(/<img [^>]*width="112"/);
    expect(head).toContain("# Luna TUI");
    expect(head).toContain("**A board in your terminal that runs a software factory. You keep the final say.**");
  });

  // @scenario:S4
  it("S4 @scenario:S4 it mentions 0.7.0, make tools, herdr.dev, pnpm board:link, [[keys.command]], hardness.board.open and a start step", () => {
    const text = read();
    for (const term of ["0.7.0", "make tools", "herdr.dev", "pnpm board:link", "[[keys.command]]", "hardness.board.open"]) {
      expect(text, term).toContain(term);
    }
    expect(text).toMatch(/pnpm start|make up|make setup/);
  });

  // @scenario:S5
  it("S5 @scenario:S5 it has at most 90 lines, keeps the Docs table and links docs/install.md and board/README.md", () => {
    const text = read();
    expect(text).not.toBe("");
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(90);
    expect(text).toMatch(/^#+\s+Docs/m);
    expect(text).toMatch(/^\|.*\|\s*/m);
    expect(text).toContain("../docs/install.md");
    expect(text).toContain("../board/README.md");
  });
});
