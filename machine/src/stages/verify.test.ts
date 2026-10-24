import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import { NO_RETRIES } from "../engine/transition.ts";
import { detectTestCommand, verifyRunner } from "./verify.ts";

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

describe("verifyRunner", () => {
  it("passes without running anything when the task has no worktree (a stub-only run)", async () => {
    const task: TaskRow = {
      id: "t1",
      title: "x",
      description: "",
      criteria: [],
      repoPath: null,
      branch: null,
      worktreePath: null,
      state: "verifying",
      retries: { ...NO_RETRIES },
      resumeTo: null,
      reason: null,
      queued: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await verifyRunner({
      task,
      stage: "verifying",
      attempt: 1,
      runId: "r1",
      approvals: [],
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ outcome: "pass" });
  });
});
