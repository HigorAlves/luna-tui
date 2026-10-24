import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { freshTestDatabase } from "../test/database.ts";
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
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true });
});

const issues = [
  { number: 7, title: "Export CSV", body: "Do it.\n- [ ] has header\n  - [x]  escapes commas \n", url: "https://github.com/o/a/issues/7" },
  { number: 8, title: "Dark mode", body: "", url: "https://github.com/o/a/issues/8" },
];

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });

describe("parseChecklist", () => {
  it("returns trimmed checklist items and ignores other lines", () => {
    expect(parseChecklist("Intro\n- [ ] one\n* [x] two  \n- plain\n")).toEqual(["one", "two"]);
    expect(parseChecklist("")).toEqual([]);
  });
});

describe("GitHubIntake.pollOnce", () => {
  it("creates a task per new issue with source and criteria, once", async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return ok(JSON.stringify(issues));
    };
    const intake = new GitHubIntake({ pipeline, repos: ["o/a"], label: "ready-for-agent", intervalMs: 1000, gh });

    await intake.pollOnce();
    expect(calls[0]).toEqual([
      "issue", "list", "--repo", "o/a", "--label", "ready-for-agent", "--state", "open",
      "--json", "number,title,body,url", "--limit", "50",
    ]);
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

  it("keeps polling other repos when one gh call fails", async () => {
    const gh = async (args: string[]) =>
      args[3] === "o/bad" ? { code: 1, stdout: "", stderr: "gh: auth required" } : ok(JSON.stringify([issues[0]]));
    const intake = new GitHubIntake({ pipeline, repos: ["o/bad", "o/good"], label: "x", intervalMs: 1000, gh });
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
