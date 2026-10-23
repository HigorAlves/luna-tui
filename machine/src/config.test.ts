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
      githubPoll: { repos: [], intervalMs: 300_000, label: "ready-for-agent" },
    });
  });

  it("reads the GitHub poll settings", () => {
    expect(
      loadConfig({
        HOME: "/h",
        MACHINE_GITHUB_POLL: "a/b, c/d,",
        MACHINE_GITHUB_POLL_INTERVAL: "60",
        MACHINE_GITHUB_LABEL: "go",
      }).githubPoll,
    ).toEqual({ repos: ["a/b", "c/d"], intervalMs: 60_000, label: "go" });
  });

  it("rejects a bad poll interval or repo", () => {
    expect(() => loadConfig({ MACHINE_GITHUB_POLL_INTERVAL: "0" })).toThrow(/MACHINE_GITHUB_POLL_INTERVAL/);
    expect(() => loadConfig({ MACHINE_GITHUB_POLL_INTERVAL: "x" })).toThrow(/MACHINE_GITHUB_POLL_INTERVAL/);
    expect(() => loadConfig({ MACHINE_GITHUB_POLL: "nope" })).toThrow(/MACHINE_GITHUB_POLL/);
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
