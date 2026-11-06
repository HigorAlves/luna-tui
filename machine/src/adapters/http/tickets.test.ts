// The tap routes of the Ticket Machine: /tickets, /tickets/:key/approve|edit|ignore|card.
import { FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgTicketStore } from "../persistence/ticket-store.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { TicketMachine } from "../../application/ticket-machine.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tickets");
});

const s = { score: 1, confidence: 0.9 };
const f = { value: false, p: 0.05 };
const y = { value: true, p: 0.95 };
const writes: unknown[][] = [];
const mk = () => {
  writes.length = 0;
  const machine = new TicketMachine({
    store: new PgTicketStore(db),
    port: () => ({ listInScope: async () => [], create: async () => { throw new Error("no create"); }, read: async () => { throw new Error("no"); }, comment: async (k, t) => void writes.push(["comment", k, t]), transition: async (k, t) => void writes.push(["transition", k, t]), link: async () => {} }),
    candidates: async () => [], config: async () => FACTORY_DEFAULTS, createCard: async () => ({ id: "card-1" }),
    validity: { decide: async () => ({ goal: y, criteria: y, scope: y, duplicate: { choice: "none", confidence: 0.9 }, project: y, reporter: y }) },
    assess: { decide: async () => Object.fromEntries([...["who", "what", "impact", "time", "demand", "files", "unknowns", "cross_team", "new_infra", "dependents", "traffic", "data_sensitivity", "reversibility", "regression", "compounding"].map((k) => [k, s]), ...["production_down", "data_loss", "security", "incident", "compliance_deadline"].map((k) => [k, f])]) as never },
    recommend: { decide: async () => ({ action: { choice: "schedule", confidence: 0.9 } }) }, reply: { write: async () => ({ reply: "no", confidence: 1 }) },
    backlog: { upsertFromSource: async () => ({ id: "b1", created: true }) },
  });
  const app = createApp({ db, pipeline: new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true }), bus: new Bus(), tickets: machine, access: { host: "127.0.0.1", port: 1, token: "tok" } });
  return { machine, app };
};
const auth = { authorization: "Bearer tok", "content-type": "application/json" };
const ticket = (key: string, tool: "jira" | "github") => ({ tool, id: key, key, title: "Refund fails", description: "d", type: "Task", status: "To Do", priority: null, reporter: { id: "u" }, assignee: null, labels: [], components: [], links: { blocks: [], duplicates: [], epic: null }, comments: [], attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: "t", permalink: "https://x" });

describe("the ticket routes", () => {
  it("sit behind the API token like the others", async () => {
    const { app } = mk();
    expect((await app.request("/tickets")).status).toBe(401);
    expect((await app.request("/tickets", { headers: auth })).status).toBe(200);
  });

  it("list the tickets with their drafts and the hash to send back with a tap", async () => {
    const { app, machine } = mk();
    await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
    const list = (await (await app.request("/tickets", { headers: auth })).json()) as Array<{ key: string; drafts: Array<{ id: string; hash: string }> }>;
    expect(list[0]!.key).toBe("PAY-12");
    expect(list[0]!.drafts[0]!.hash).toHaveLength(16);
  });

  it("approve posts only with the current hash, refuses a stale one with a 409 and a bad key with a 404", async () => {
    const { app, machine } = mk();
    await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
    const d = (await machine.view("PAY-12")).drafts[0]!;
    const post = (key: string, path: string, body: unknown) => app.request(`/tickets/${encodeURIComponent(key)}/${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect((await post("PAY-12", "approve", { draft: d.id, hash: "stale" })).status).toBe(409);
    expect(writes).toEqual([]);
    expect((await post("PAY-12", "approve", { draft: d.id, hash: d.hash })).status).toBe(200);
    expect(writes).toHaveLength(1);
    expect((await post("../etc", "approve", { draft: "x", hash: "y" })).status).toBe(404);
    expect((await post("PAY-12", "approve", { nope: 1 })).status).toBe(400);
  });

  it("answers a GitHub approve that needs a transition with a clear 409, not a 500", async () => {
    const { app, machine } = mk();
    await machine.ingest(ticket("o/a#3", "github") as never, { repoPath: null, question: false });
    const d = (await machine.view("o/a#3")).drafts[0]!;
    const r = await app.request(`/tickets/${encodeURIComponent("o/a#3")}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ draft: d.id, hash: d.hash, transition: "Done" }) });
    expect(r.status).toBe(409);
    expect(writes).toEqual([]);
  });

  it("make a card on /card, once", async () => {
    const { app, machine } = mk();
    await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
    const card = () => app.request("/tickets/PAY-12/card", { method: "POST", headers: auth });
    expect((await card()).status).toBe(201);
    expect((await card()).status).toBe(409);
  });

  it("send an assessed ticket to the backlog on /backlog, and refuse one that is not assessed", async () => {
    const { app, machine } = mk();
    await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
    expect((await app.request("/tickets/PAY-12/backlog", { method: "POST", headers: auth })).status).toBe(201);
    expect((await app.request("/tickets/PAY-99/backlog", { method: "POST", headers: auth })).status).toBe(404);
  });
});
