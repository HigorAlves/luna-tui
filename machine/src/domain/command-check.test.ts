import { describe, expect, it } from "vitest";

import { isCommandCheck, repoCommandsOf } from "./command-check.ts";

const commands = repoCommandsOf(["board:test", "test", "typecheck"], ["pnpm test"]);

describe("isCommandCheck", () => {
  it("takes the scenario that only runs the repo's commands and expects them to pass (S13 of the split-card ticket)", () => {
    expect(isCommandCheck({ when: "pnpm board:test and pnpm board:lint run", then: "Both exit 0 with no warnings" }, commands)).toBe(true);
    expect(isCommandCheck({ when: "`cargo clippy --all-targets` runs", then: "it is clean" }, commands)).toBe(true);
  });
  it("does not take a behaviour, even one that names a command", () => {
    expect(isCommandCheck({ when: "a split card is drawn", then: "the row contains 'part 2/3'" }, commands)).toBe(false);
    expect(isCommandCheck({ when: "pnpm board:test runs", then: "the row shows the part marker" }, commands)).toBe(false);
  });
  it("does not take a command the repo does not have, or a word that only starts like one", () => {
    expect(isCommandCheck({ when: "pnpm deploy runs", then: "it exits 0" }, commands)).toBe(false);
    expect(isCommandCheck({ when: "pnpm board:tests runs", then: "it exits 0" }, commands)).toBe(false);
  });
});

describe("isCommandCheck: a workspace package's scripts", () => {
  const commands = repoCommandsOf(["typecheck"], [], [{ name: "site", dir: "site", scripts: ["typecheck", "lint", "test", "facts:check", "build"] }]);
  it("takes `pnpm --filter site …` as the repo's command (the site card's S22 and S23)", () => {
    expect(isCommandCheck({ when: "pnpm --filter site typecheck, lint, test and facts:check run", then: "each exits 0" }, commands)).toBe(true);
    expect(isCommandCheck({ when: "pnpm --filter site build runs", then: "it exits 0" }, commands)).toBe(true);
  });
  it("does not take a package or script the repo does not have", () => {
    expect(isCommandCheck({ when: "pnpm --filter web build runs", then: "it exits 0" }, commands)).toBe(false);
    expect(isCommandCheck({ when: "pnpm --filter site deploy runs", then: "it exits 0" }, commands)).toBe(false);
  });
});
