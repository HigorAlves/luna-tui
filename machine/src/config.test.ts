import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_PORT,
  DEFAULT_RETENTION_DAYS,
  loadConfig,
} from "./config.ts";

describe("loadConfig", () => {
  it("uses the dev defaults", () => {
    expect(loadConfig({ HOME: "/home/me" })).toEqual({
      databaseUrl: DEFAULT_DATABASE_URL,
      port: DEFAULT_PORT,
      host: "127.0.0.1",
      agents: true,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      runnerImage: "hardness-runner:dev",
      runnerQaImage: "hardness-runner-qa:dev",
      worktreesDir: "/home/me/Developer/worktrees",
      stateDir: "/home/me/.local/state/hardness",
      githubPoll: { repos: [], intervalMs: 300_000, label: "ready-for-agent" },
      retentionDays: DEFAULT_RETENTION_DAYS,
      taskBudgetUsd: null,
      dailyBudgetUsd: null,
      restartPolicy: "requeue",
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

  it("binds to the host in MACHINE_HOST, so a container can listen on every interface", () => {
    expect(loadConfig({ HOME: "/h", MACHINE_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
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

  it("requeues running tasks on shutdown unless told to escalate them", () => {
    expect(loadConfig({ HOME: "/home/me" }).restartPolicy).toBe("requeue");
    expect(loadConfig({ HOME: "/home/me", MACHINE_RESTART_POLICY: "escalate" }).restartPolicy).toBe("escalate");
    expect(() => loadConfig({ MACHINE_RESTART_POLICY: "resume" })).toThrow(/MACHINE_RESTART_POLICY/);
  });

  it("has no spend ceilings unless you set them", () => {
    const config = loadConfig({ HOME: "/home/me" });
    expect(config.taskBudgetUsd).toBeNull();
    expect(config.dailyBudgetUsd).toBeNull();
    const set = loadConfig({ HOME: "/home/me", MACHINE_TASK_BUDGET_USD: "2.5", MACHINE_DAILY_BUDGET_USD: "40" });
    expect(set.taskBudgetUsd).toBe(2.5);
    expect(set.dailyBudgetUsd).toBe(40);
  });

  it("rejects a ceiling that is not a positive amount", () => {
    expect(() => loadConfig({ MACHINE_TASK_BUDGET_USD: "0" })).toThrow(/MACHINE_TASK_BUDGET_USD/);
    expect(() => loadConfig({ MACHINE_DAILY_BUDGET_USD: "lots" })).toThrow(/MACHINE_DAILY_BUDGET_USD/);
  });

  it("reads a custom retention window, including 0 to disable pruning", () => {
    expect(loadConfig({ HOME: "/home/me", MACHINE_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    expect(loadConfig({ HOME: "/home/me", MACHINE_RETENTION_DAYS: "0" }).retentionDays).toBe(0);
  });

  it("rejects a retention window that is not a non-negative integer", () => {
    expect(() => loadConfig({ MACHINE_RETENTION_DAYS: "-1" })).toThrow(/MACHINE_RETENTION_DAYS/);
    expect(() => loadConfig({ MACHINE_RETENTION_DAYS: "abc" })).toThrow(/MACHINE_RETENTION_DAYS/);
  });
});
