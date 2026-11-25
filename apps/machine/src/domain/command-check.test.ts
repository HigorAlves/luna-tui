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

describe("isCommandCheck: a big monorepo's scenarios (DISC-53's S30, S34, S36)", () => {
  const commands = repoCommandsOf(["lint", "check-types", "test:unit"], ["yarn lint"], [{ name: "@discover/domain", dir: "packages/domain", scripts: ["test:unit", "check-types"] }], ["scripts/cycle-inventory.mts", "scripts/deploy/release.sh"]);
  it("takes a script file of the repo run through tsx, node or a shell, when it only has to pass (S36)", () => {
    expect(isCommandCheck({ when: "yarn tsx scripts/cycle-inventory.mts --check is run", then: "it exits 0" }, commands)).toBe(true);
    expect(isCommandCheck({ when: "bash scripts/deploy/release.sh runs", then: "it succeeds" }, commands)).toBe(true);
  });
  it("takes a script named bare in the sentence when its name is one only a script has (S30)", () => {
    expect(isCommandCheck({ when: "unsharded test:unit runs in @discover/domain and @discover/application", then: "it exits 0 with at least 85% on all four metrics for the three globs" }, commands)).toBe(true);
  });
  it("still asks for a test when a command must report a failure (S34), and never takes a file the repo does not have", () => {
    expect(isCommandCheck({ when: "lint runs", then: "lambdaBoundary reports an error" }, commands)).toBe(false);
    expect(isCommandCheck({ when: "yarn tsx scripts/not-here.mts runs", then: "it exits 0" }, commands)).toBe(false);
    // A plain word is not taken bare: "the test runs" is prose, not the `test` script.
    expect(isCommandCheck({ when: "the lint runs", then: "it passes" }, repoCommandsOf(["lint"], []))).toBe(false);
  });
  it("knows a workspace two folders down by its name", () => {
    expect(isCommandCheck({ when: "yarn workspace @discover/domain check-types runs", then: "it exits 0" }, commands)).toBe(true);
  });
});
