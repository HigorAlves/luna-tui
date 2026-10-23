import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectTestCommand } from "./verify.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hardness-verify-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("detectTestCommand", () => {
  it("picks npm test for a package.json with a test script and no lockfile", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectTestCommand(dir)).toEqual(["npm", "test"]);
  });

  it("picks pnpm test when a pnpm-lock.yaml is present", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(detectTestCommand(dir)).toEqual(["pnpm", "test"]);
  });

  it("picks yarn test when a yarn.lock is present", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
    writeFileSync(join(dir, "yarn.lock"), "");
    expect(detectTestCommand(dir)).toEqual(["yarn", "test"]);
  });

  it("falls back to cargo test when there's a Cargo.toml and no package.json", () => {
    writeFileSync(join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
    expect(detectTestCommand(dir)).toEqual(["cargo", "test"]);
  });

  it("returns null when package.json has no test script", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(detectTestCommand(dir)).toBeNull();
  });

  it("returns null when nothing recognizable is there", () => {
    expect(detectTestCommand(dir)).toBeNull();
  });
});
