// The rule of wave 16: nothing leaves the machine without a person's tap. The real intake loops are driven with a ticket of each kind,
// with `tickets.auto` off (the default); every outward write is recorded and there must be none, and no card either.
import { type CanonicalTicket, FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type JiraPolicy } from "../domain/policy.ts";
import { fakeGitHub } from "../test/github.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeJira } from "../test/jira.ts";
import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { GitHubIntake } from "./intake.ts";
import { TicketMachine } from "./ticket-machine.ts";
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

describe("a split proposal for a ticket, with the real Ticket Machine behind the real intake", () => {
  it("a split proposal for a ticket writes nothing before the tap: no create, no comment, no card, only a draft", async () => {
    await db.query("truncate tickets");
    const writes: unknown[][] = [];
    const yes = { value: true, p: 0.95 };
    const sc = { score: 1, confidence: 0.9 };
    const no = { value: false, p: 0.05 };
    const kid = (title: string, over: Record<string, unknown> = {}) => ({ title, goal: `do ${title} in the refund service and keep the existing behaviour for every other payment path`, acceptance_criteria: [`${title} works`], covers: [], files_hint: ["src/a.ts"], est_loc: 800, depends_on: [], order: 1, ...over });
    const store = new PgTicketStore(db);
    const port = {
      listInScope: async () => [], read: async () => { throw new Error("no"); },
      comment: async (k: string, t: string) => void writes.push(["comment", k, t]), transition: async (k: string, t: string) => void writes.push(["transition", k, t]), link: async (k: string, u: string) => void writes.push(["link", k, u]),
      create: async (o: { key: string }, c: { title: string }) => (writes.push(["create", o.key, c.title]), { key: "o/a#99", permalink: "https://github.com/o/a/issues/99" }),
    };
    const machine = new TicketMachine({
      store, port: () => port as never, candidates: async () => [], config: async () => FACTORY_DEFAULTS, createCard: async (input) => (writes.push(["card", input]), { id: "c1" }),
      validity: { decide: async () => ({ goal: yes, criteria: yes, scope: yes, duplicate: { choice: "none", confidence: 0.9 }, project: yes, reporter: yes }) as never },
      assess: { decide: async () => ({ who: sc, what: sc, impact: sc, time: sc, demand: sc, files: sc, unknowns: sc, cross_team: sc, new_infra: sc, dependents: sc, traffic: sc, data_sensitivity: sc, reversibility: sc, regression: sc, compounding: sc, production_down: no, data_loss: no, security: no, incident: no, compliance_deadline: no }) as never },
      recommend: { decide: async () => ({ action: { choice: "schedule", confidence: 0.9 } }) },
      reply: { write: async () => ({ reply: "no", confidence: 0.9 }) },
      size: { decide: async () => ({ est_loc: { score: 6, confidence: 0.95 }, est_files: { score: 1, confidence: 0.95 }, reviewable: { value: true, p: 0.95 } }) },
      split: { decompose: async () => ({ children: [kid("Part A"), kid("Part B", { depends_on: [1], order: 2 })] }), check: null },
    });
    const issues = [{ number: 1, title: "A huge change", body: "b", url: "https://github.com/o/a/issues/1", labels: ["ready"], author: "ana" }];
    const github = fakeGitHub({ listReadyIssues: async () => issues, commentOnIssue: async () => {} });
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true });
    const intake = new GitHubIntake({ pipeline, github, repos: ["o/a"], label: "ready", intervalMs: 60_000, resolveRepo: async () => "/r/a", classifier: null, tickets: machine, ticketsAuto: async () => false } as never);
    await intake.pollOnce();
    const row = (await store.get("o/a#1"))!;
    expect(row.machineStatus).toBe("split_proposed");
    expect((row.drafts as Array<{ kind: string }>).some((d) => d.kind === "split")).toBe(true);
    expect(writes).toEqual([]);
    expect(github.commentOnIssue).not.toHaveBeenCalled();
    expect(await pipeline.list()).toHaveLength(0);
  });
});
