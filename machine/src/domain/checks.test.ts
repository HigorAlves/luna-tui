import { describe, expect, it } from "vitest";

import { checkCommand, selectChecks } from "./checks.ts";

const board = { name: "board tests", run: "cargo test", cwd: "board", paths: ["board/**"] };
const machine = { name: "machine tests", run: "pnpm test", cwd: "machine", paths: ["machine/**", "contracts/**"] };
const always = { name: "lint", run: "pnpm lint" };

describe("selectChecks", () => {
  it("keeps a check whose paths the change touches, and one with no paths always", () => {
    expect(selectChecks([board, machine, always], ["board/src/ui.rs"])).toEqual([board, always]);
    expect(selectChecks([board, machine, always], ["contracts/src/stage.ts", "docs/api.md"])).toEqual([machine, always]);
  });

  it("runs everything when the change is unknown, so an empty diff never skips a check by accident", () => {
    expect(selectChecks([board, machine, always], null)).toEqual([board, machine, always]);
  });

  it("matches a glob the way .gitignore readers expect: ** spans directories, * stays inside one", () => {
    const deep = { name: "d", run: "x", paths: ["src/**/*.test.ts"] };
    const shallow = { name: "s", run: "x", paths: ["src/*.ts"] };
    expect(selectChecks([deep, shallow], ["src/a/b/c.test.ts"])).toEqual([deep]);
    expect(selectChecks([deep, shallow], ["src/c.ts"])).toEqual([shallow]);
  });
});

describe("checkCommand", () => {
  it("runs the line through sh in its cwd, so a check can be any shell line a person would type", () => {
    expect(checkCommand(board)).toEqual({ name: "board tests", cmd: "cargo test (in board)", argv: ["sh", "-c", "cd 'board' && cargo test"] });
    expect(checkCommand(always)).toEqual({ name: "lint", cmd: "pnpm lint", argv: ["sh", "-c", "pnpm lint"] });
  });
});
