import { describe, expect, it } from "vitest";

import { exitStatusCovers, runnerVerdict, statusOfTests } from "./test-status.ts";

describe("statusOfTests", () => {
  it.each([
    ["pytest", "own"],
    ["cd app && pytest -q", "own"],
    ["pytest && echo ok", "own"],
    ["npm test | tail -20", "hidden"],
    ["npm test 2>&1 | tail -n 8", "hidden"],
    ["npm test || true", "hidden"],
    ['python -m unittest; echo "exit=$?"', "hidden"],
    ["set -o pipefail; pytest | tail", "own"],
    ["pytest; git diff", "mixed"],
    ["FOO=1 timeout 60 uv run pytest | tee out.txt", "hidden"],
    ["bash -lc 'pytest | tail'", undefined],
    ["pytest --collect-only | tail", undefined],
    ["pytest --help", undefined],
    ["ls | tail", undefined],
    ['echo "pytest | tail"', undefined],
  ] as const)("reads %j as %s", (cmd, status) => {
    expect(statusOfTests(cmd)).toBe(status);
  });

  it("takes the strongest status over the test runs of a line", () => {
    expect(statusOfTests("pytest | tail; npm test; git status")).toBe("mixed");
  });

  it("does not read a heredoc's lines as commands", () => {
    expect(statusOfTests("cat <<EOF\npytest | tail\nEOF")).toBeUndefined();
  });
});

describe("exitStatusCovers", () => {
  it.each([
    ["pytest", true],
    ["cd web; npx vitest run", true],
    ["grep -rn Error src | head", true],
    ["python repro.py 2>&1 | tail -20", false],
    ["pytest || true", false],
    ["sed -i s/a/b/ f; echo done", false],
    ["set -o pipefail; pytest | tail", true],
    ["", false],
  ] as const)("reads %j as %s", (cmd, covers) => {
    expect(exitStatusCovers(cmd)).toBe(covers);
  });
});

describe("runnerVerdict", () => {
  it("is true for a failing summary, false for a passing one, undefined without one", () => {
    expect(runnerVerdict("1 failed, 2 passed in 0.4s")).toBe(true);
    expect(runnerVerdict("3 passed in 0.2s")).toBe(false);
    expect(runnerVerdict("collecting ...")).toBeUndefined();
    expect(runnerVerdict("")).toBeUndefined();
    expect(runnerVerdict("3 passed in 0.2s\nFAIL\tpkg")).toBe(true);
  });
});
