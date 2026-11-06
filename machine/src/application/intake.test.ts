import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { previewOn } from "../test/policies.ts";

import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeGitHub } from "../test/github.ts";
import { GitHubIntake, parseChecklist } from "./intake.ts";

let db: DataSource;
let pipeline: Pipeline;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
});

const issues = [
  { number: 7, title: "Export CSV", body: "Do it.\n- [ ] has header\n  - [x]  escapes commas \n", url: "https://github.com/o/a/issues/7" },
  { number: 8, title: "Dark mode", body: "", url: "https://github.com/o/a/issues/8" },
];

const found = (list: typeof issues) => fakeGitHub({ listReadyIssues: async () => list });

describe("parseChecklist", () => {
  it("returns trimmed checklist items and ignores other lines", () => {
    expect(parseChecklist("Intro\n- [ ] one\n* [x] two  \n- plain\n")).toEqual(["one", "two"]);
    expect(parseChecklist("")).toEqual([]);
  });
});

describe("GitHubIntake.pollOnce", () => {
  it("creates a task per new issue with source and criteria, once", async () => {
    const github = found(issues);
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "ready-for-agent", intervalMs: 1000 });

    await intake.pollOnce();
    expect(github.listReadyIssues).toHaveBeenCalledWith("o/a", "ready-for-agent");
    const tasks = await pipeline.list();
    expect(tasks.map((t) => t.title)).toEqual(["Export CSV", "Dark mode"]);
    expect(tasks[0]).toMatchObject({
      description: issues[0]!.body,
      criteria: ["has header", "escapes commas"],
      repoPath: null,
      source: { kind: "github", repo: "o/a", number: 7, url: issues[0]!.url },
    });
    expect(tasks[1]!.criteria).toEqual([]);

    await intake.pollOnce();
    expect(await pipeline.list()).toHaveLength(2);
  });

  it("sets the task's repoPath from the resolver, so an imported issue needs no hand edit", async () => {
    const github = found([issues[0]!]);
    const asked: string[] = [];
    const resolveRepo = async (repo: string) => {
      asked.push(repo);
      return repo === "o/a" ? "/repos/a" : null;
    };
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "x", intervalMs: 1000, resolveRepo });
    await intake.pollOnce();
    expect(asked).toEqual(["o/a"]);
    expect((await pipeline.list())[0]!.repoPath).toBe("/repos/a");
  });

  it("keeps polling other repos when one GitHub call fails", async () => {
    const github = fakeGitHub({
      listReadyIssues: async (repo) => {
        if (repo === "o/bad") throw new Error("Bad credentials (401)");
        return [issues[0]!];
      },
    });
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/bad", "o/good"], label: "x", intervalMs: 1000 });
    await intake.pollOnce();
    const tasks = await pipeline.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toMatchObject({ repo: "o/good", number: 7 });
  });
});

describe("Pipeline.findBySource", () => {
  it("round-trips against the database", async () => {
    const source = { kind: "github" as const, repo: "o/a", number: 42, url: "https://github.com/o/a/issues/42" };
    expect(await pipeline.findBySource("o/a", 42)).toBeNull();
    const task = await pipeline.createTask({ title: "t", source });
    expect((await pipeline.findBySource("o/a", 42))?.id).toBe(task.id);
    expect(await pipeline.findBySource("o/b", 42)).toBeNull();
    expect(await pipeline.findBySource("o/a", 43)).toBeNull();
  });
});

describe("GitHubIntake with triage_signals", () => {
  const classified = (kind: string, confidence = 0.9) => ({ kind, area: "machine", ready: kind !== "question", size: 1, confidence, at: "2026-11-03T12:00:00.000Z", model: "typesafe-ai/jev" });
  const labelled = [{ ...issues[0]!, labels: ["enhancement"] }, { ...issues[1]!, title: "How do I turn on dark mode?", labels: [] }];

  it("reads each new issue first; a question Jev is sure of becomes no task and hears why once, the rest become tasks with no classification of intake's (triage reads its own)", async () => {
    const github = fakeGitHub({ listReadyIssues: async () => labelled });
    const read: unknown[] = [];
    const classifier = { classify: async (issue: { title: string }) => (read.push(issue), classified(issue.title.startsWith("How") ? "question" : "feature")) };
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "x", intervalMs: 1000, classifier });
    await intake.pollOnce();
    expect(read).toEqual([
      { title: "Export CSV", description: issues[0]!.body, labels: ["enhancement"], source: issues[0]!.url },
      { title: "How do I turn on dark mode?", description: "", labels: [], source: issues[1]!.url },
    ]);
    const tasks = await pipeline.list();
    expect(tasks.map((t) => [t.title, t.classification])).toEqual([["Export CSV", null]]);
    // The card keeps the issue's labels: triage reads the signals again from the card, and a security label must survive that.
    expect(tasks[0]!.source).toMatchObject({ kind: "github", labels: ["enhancement"] });
    expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
    expect(github.commentOnIssue).toHaveBeenCalledWith("o/a", 8, "Not for an agent: it reads as a question, not a change (question · machine · not ready · size small · lowest confidence 0.90 (typesafe-ai/jev)).");
    await intake.pollOnce();
    expect(read).toHaveLength(2);
    expect(github.commentOnIssue).toHaveBeenCalledTimes(1);
  });

  it("makes a task of a question Jev is not sure of, and of every issue when there is no classification, exactly as without a classifier", async () => {
    const github = fakeGitHub({ listReadyIssues: async () => labelled });
    const unsure = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "x", intervalMs: 1000, classifier: { classify: async () => classified("question", 0.6) } });
    await unsure.pollOnce();
    expect((await pipeline.list()).map((t) => [t.title, t.classification])).toEqual([["Export CSV", null], ["How do I turn on dark mode?", null]]);
    await db.query("truncate tasks cascade");
    const none = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "x", intervalMs: 1000, classifier: { classify: async () => null } });
    await none.pollOnce();
    const tasks = await pipeline.list();
    expect(tasks.map((t) => ({ title: t.title, criteria: t.criteria, classification: t.classification }))).toEqual([
      { title: "Export CSV", criteria: ["has header", "escapes commas"], classification: null },
      { title: "How do I turn on dark mode?", criteria: [], classification: null },
    ]);
    expect(github.commentOnIssue).not.toHaveBeenCalled();
  });
});
