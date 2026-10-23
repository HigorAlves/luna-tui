import { describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_URL, DEFAULT_MAX_CONCURRENT_TASKS, DEFAULT_PORT, loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("uses the dev defaults", () => {
    expect(loadConfig({ HOME: "/home/me" })).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      port: DEFAULT_PORT,
      agents: true,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      runnerImage: "hardness-runner:dev",
      worktreesDir: "/home/me/Developer/worktrees",
      stateDir: "/home/me/.local/state/hardness",
      herdrBin: "herdr",
    });
  });

  it("rejects a port that is not a number", () => {
    expect(() => loadConfig({ MACHINE_PORT: "abc" })).toThrow(/MACHINE_PORT/);
  });

  it("reads a custom concurrency limit", () => {
    expect(loadConfig({ HOME: "/home/me", MACHINE_MAX_CONCURRENT: "8" }).maxConcurrentTasks).toBe(8);
  });

  it("rejects a concurrency limit that is not a positive integer", () => {
    expect(() => loadConfig({ MACHINE_MAX_CONCURRENT: "0" })).toThrow(/MACHINE_MAX_CONCURRENT/);
    expect(() => loadConfig({ MACHINE_MAX_CONCURRENT: "abc" })).toThrow(/MACHINE_MAX_CONCURRENT/);
  });
});
