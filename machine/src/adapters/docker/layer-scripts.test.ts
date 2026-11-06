import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "runner");

/** The command words of a shell script: the first word of each line that is not a comment, an assignment, `export` or `exec`'s argument. */
const words = (file: string): string[] =>
  readFileSync(join(runner, file), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^exec\s+/, ""))
    .map((l) => l.split(/\s+/)[0]!.replace(/^"/, ""))
    .filter((w) => w && !/^(?:export|name=|[A-Za-z_][A-Za-z0-9_]*=)/.test(w));

describe("the layer's scripts run on a base they do not trust", () => {
  it("call nothing by a bare name: absolute paths in /opt/luna, or builtins", () => {
    for (const file of ["luna-stage", "layer-wrapper"]) {
      for (const word of words(file)) expect(word, `${file}: ${word}`).toMatch(/^(?:\/opt\/luna\/|export$|exec$|set$|cd$|unset$)/);
      expect(readFileSync(join(runner, file), "utf8"), file).not.toMatch(/\b(?:env|basename|dirname|sed|cat)\b(?!\s*#)(?=[^\n]*(?:\$\(|`|\|))/);
    }
  });
});
