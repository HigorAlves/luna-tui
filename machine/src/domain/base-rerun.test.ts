import { describe, expect, it } from "vitest";

import { failingTestFiles, narrowedArgv } from "./base-rerun.ts";

describe("failingTestFiles", () => {
  it("names each test file of a FAIL line once, stripping colour and a project label", () => {
    const text = [
      " \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/a.test.ts > one > two",
      " FAIL  |unit| src/b.spec.tsx > case",
      " FAIL  src/a.test.ts > another case",
      "AssertionError: nope",
    ].join("\n");
    expect(failingTestFiles(text)).toEqual(["src/a.test.ts", "src/b.spec.tsx"]);
  });

  it("is empty when the output names no test file, and when too many files failed to name them (an environment fault fails them all)", () => {
    expect(failingTestFiles("error TS2304: Cannot find name 'x'")).toEqual([]);
    const many = Array.from({ length: 40 }, (_, n) => `FAIL src/f${n}.test.ts > x`).join("\n");
    expect(failingTestFiles(many)).toEqual([]);
  });
});

describe("narrowedArgv", () => {
  it("appends the files to a package manager's test script, quoted, inside the sh -c line a luna.yaml check runs as", () => {
    expect(narrowedArgv(["sh", "-c", "pnpm run test"], ["src/a.test.ts"])).toEqual(["sh", "-c", "pnpm run test 'src/a.test.ts'"]);
    expect(narrowedArgv(["sh", "-c", "cd 'machine' && pnpm --filter x test"], ["a b.test.ts", "c.test.ts"])).toEqual(["sh", "-c", "cd 'machine' && pnpm --filter x test 'a b.test.ts' 'c.test.ts'"]);
  });

  it("appends the files to a detected command, and puts npm's after --", () => {
    expect(narrowedArgv(["pnpm", "run", "test"], ["a.test.ts"])).toEqual(["pnpm", "run", "test", "a.test.ts"]);
    expect(narrowedArgv(["npm", "test"], ["a.test.ts"])).toEqual(["npm", "test", "--", "a.test.ts"]);
    expect(narrowedArgv(["sh", "-c", "npm run test"], ["a.test.ts"])).toEqual(["sh", "-c", "npm run test -- 'a.test.ts'"]);
  });

  it("gives up (null, so the whole check runs) for a line it cannot narrow safely, and for a quote in a file name", () => {
    expect(narrowedArgv(["sh", "-c", "pnpm run build && pnpm run test"], ["a.test.ts"])).toBeNull();
    expect(narrowedArgv(["sh", "-c", "pnpm run test | tee out"], ["a.test.ts"])).toBeNull();
    expect(narrowedArgv(["sh", "-c", "cargo test"], ["a.test.ts"])).toBeNull();
    expect(narrowedArgv(["pnpm", "run", "test"], [])).toBeNull();
    expect(narrowedArgv(["pnpm", "run", "test"], ["it's.test.ts"])).toBeNull();
    expect(narrowedArgv(["pnpm", "run", "test"], ["--config=evil.test.ts"])).toBeNull();
  });
});
