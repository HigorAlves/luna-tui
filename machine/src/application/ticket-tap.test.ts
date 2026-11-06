// The rule of wave 16: nothing leaves the machine without a person's tap. The real intake loops are driven with a ticket of each kind,
// with `tickets.auto` off (the default); every outward write is recorded and there must be none, and no card either.
import type { CanonicalTicket } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type JiraPolicy } from "../domain/policy.ts";
import { fakeGitHub } from "../test/github.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeJira } from "../test/jira.ts";
import { GitHubIntake } from "./intake.ts";
import { JiraIntake } from "./jira-intake.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const policy: JiraPolicy = { project: "PLAT", intake: { jql: "project = PLAT", everySecs: 300 }, on: {}, comments: "milestones", fields: {}, branch: "{type}/{key}" };
const ingested: Array<{ key: string; question: boolean }> = [];
const tickets = { ingest: async (t: CanonicalTicket, ctx: { question: boolean }) => void ingested.push({ key: t.key, question: ctx.question }) };
const question = { kind: "question", area: "machine", ready: false, size: 1, confidence: 0.99, at: "2026-11-05T12:00:00.000Z", model: "typesafe-ai/jev" };
const classifier = { classify: async (i: { title: string }) => (i.title === "How does X work" ? (question as never) : null) };

describe("the intakes, with tickets.auto off", () => {
  it("Jira: a ticket of every kind is read and held, and nothing is posted, transitioned or made into a card", async () => {
    ingested.length = 0;
    const jira = fakeJira({ issues: [{ key: "PLAT-1", summary: "Workable" }, { key: "PLAT-2", summary: "Vague" }, { key: "PLAT-3", summary: "How does X work" }, { key: "PLAT-4", summary: "Duplicate" }] });
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: "https://acme.atlassian.net" });
    const triager = { triage: async () => ({ verdict: "ready" as const, reason: "r", title: "t" }) };
    const intake = new JiraIntake({ pipeline, jira, policies: { for: async () => ({ ...DEFAULT_POLICY, jira: policy }) }, repos: async () => ["/r/a"], triager, classifier, tickets, now: () => new Date("2026-11-05T12:00:00Z"), log: () => {} } as never);
    await intake.tick();
    expect(jira.writes).toEqual([]);
    expect(await pipeline.list()).toHaveLength(0);
    expect([...new Set(ingested.map((i) => i.key))].sort()).toEqual(["PLAT-1", "PLAT-2", "PLAT-3", "PLAT-4"]);
    expect(ingested.find((i) => i.key === "PLAT-3")?.question).toBe(true);
  });

  it("GitHub: the same, and no comment on the issue and no card", async () => {
    ingested.length = 0;
    const issues = [{ number: 1, title: "Workable", body: "b", url: "https://github.com/o/a/issues/1", labels: ["ready"], author: "ana" }, { number: 2, title: "How does X work", body: "b", url: "https://github.com/o/a/issues/2", labels: ["ready"], author: "bo" }];
    const github = fakeGitHub({ listReadyIssues: async () => issues, commentOnIssue: async () => {} });
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "ready", intervalMs: 60_000, resolveRepo: async () => "/r/a", classifier, tickets, ticketsAuto: async () => false } as never);
    await intake.pollOnce();
    expect(github.commentOnIssue).not.toHaveBeenCalled();
    expect(await pipeline.list()).toHaveLength(0);
    expect(ingested.map((i) => i.key).sort()).toEqual(["o/a#1", "o/a#2"]);
  });

  it("Jira with tickets.auto on keeps today's behaviour: the card is made and the issue is told", async () => {
    const jira = fakeJira({ issues: [{ key: "PLAT-1", summary: "Workable" }] });
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: "https://acme.atlassian.net" });
    const factory = { ...DEFAULT_POLICY.factory, tickets: { ...DEFAULT_POLICY.factory.tickets, auto: "on" as const } };
    const intake = new JiraIntake({ pipeline, jira, policies: { for: async () => ({ ...DEFAULT_POLICY, factory, jira: policy }) }, repos: async () => ["/r/a"], triager: null, tickets, now: () => new Date(), log: () => {} } as never);
    await intake.tick();
    expect(await pipeline.list()).toHaveLength(1);
  });
});
