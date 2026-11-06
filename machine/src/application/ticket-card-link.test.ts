// A card made from a ticket is linked only to its own source: a Jira key a stranger wrote into a GitHub issue's title is not a link.
import { FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgTicketStore } from "../adapters/persistence/ticket-store.ts";
import { freshTestDatabase } from "../test/database.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";
import { TicketMachine } from "./ticket-machine.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  await db.query("truncate tickets");
});

const s = { score: 1, confidence: 0.9 };
const f = { value: false, p: 0.05 };
const y = { value: true, p: 0.95 };
const base = { description: "d", type: "Task", status: "open", priority: null, reporter: { id: "u" }, assignee: null, labels: [], components: [], links: { blocks: [], duplicates: [], epic: null }, comments: [], attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: "t" };

function wire() {
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, jiraSite: "https://acme.atlassian.net" });
  const machine = new TicketMachine({
    store: new PgTicketStore(db),
    port: () => ({ listInScope: async () => [], create: async () => { throw new Error("no create"); }, read: async () => { throw new Error("no"); }, comment: async () => {}, transition: async () => {}, link: async () => {} }),
    candidates: async () => [], config: async () => FACTORY_DEFAULTS, createCard: (input) => pipeline.createTask(input),
    validity: { decide: async () => ({ goal: y, criteria: y, scope: y, duplicate: { choice: "none", confidence: 0.9 }, project: y, reporter: y }) },
    assess: { decide: async () => Object.fromEntries([...["who", "what", "impact", "time", "demand", "files", "unknowns", "cross_team", "new_infra", "dependents", "traffic", "data_sensitivity", "reversibility", "regression", "compounding"].map((k) => [k, s]), ...["production_down", "data_loss", "security", "incident", "compliance_deadline"].map((k) => [k, f])]) as never },
    recommend: { decide: async () => ({ action: { choice: "schedule", confidence: 0.9 } }) }, reply: { write: async () => ({ reply: "no", confidence: 1 }) },
  });
  return { pipeline, machine };
}

describe("card()", () => {
  it("links no Jira issue for a GitHub ticket whose text names one", async () => {
    const { pipeline, machine } = wire();
    await machine.ingest({ ...base, tool: "github", id: "o/a#3", key: "o/a#3", title: "Crash, see FIN-1234", description: "also FIN-99", permalink: "https://github.com/o/a/issues/3" } as never, { repoPath: null, question: false });
    const card = await machine.card("o/a#3");
    const task = await pipeline.get(card.id);
    expect(task.jira ?? null).toBeNull();
    expect(JSON.stringify(task)).not.toContain('"key":"FIN-1234"');
  });

  it("links a Jira ticket to its own key and no other", async () => {
    const { pipeline, machine } = wire();
    await machine.ingest({ ...base, tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails, like FIN-1234", permalink: "https://acme.atlassian.net/browse/PAY-12" } as never, { repoPath: null, question: false });
    const task = await pipeline.get((await machine.card("PAY-12")).id);
    expect(task.jira?.key).toBe("PAY-12");
  });
});
