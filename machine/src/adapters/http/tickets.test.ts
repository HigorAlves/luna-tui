// The tap routes of the Ticket Machine: /tickets, /tickets/:key/approve|edit|ignore|card.
import { FACTORY_DEFAULTS } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PgTicketStore } from "../persistence/ticket-store.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { TicketMachine } from "../../application/ticket-machine.ts";
import { createTicketScreen } from "../../application/ticket-screen.ts";
import { trustOf } from "../../domain/trust.ts";
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
const learned: Array<Record<string, unknown>> = [];
const cards: Array<Record<string, unknown>> = [];
const safe = { addresses_agent: f, seeks_secrets: f, off_task_actions: f, overrides_rules: f, hidden_content: f };
const mk = (over: { screen?: Record<string, { value: boolean; p: number }>; recordId?: string } = {}) => {
  writes.length = 0;
  learned.length = 0;
  cards.length = 0;
  const machine = new TicketMachine({
    store: new PgTicketStore(db),
    ...(over.screen ? { screen: createTicketScreen({ decide: async () => ({ answer: over.screen!, ...(over.recordId ? { recordId: over.recordId } : {}) }) as never }) } : {}),
    truth: { learned: async (fact) => (learned.push(fact), true), draft: async () => {} },
    port: () => ({ listInScope: async () => [], create: async () => { throw new Error("no create"); }, read: async () => { throw new Error("no"); }, comment: async (k, t) => void writes.push(["comment", k, t]), transition: async (k, t) => void writes.push(["transition", k, t]), link: async () => {} }),
    candidates: async () => [], config: async () => FACTORY_DEFAULTS, createCard: async (input) => (cards.push(input as never), { id: "card-1" }),
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

  describe("a held ticket", () => {
    const injected = { ...safe, addresses_agent: y, hidden_content: y };
    const post = (app: ReturnType<typeof mk>["app"], key: string, path: string) => app.request(`/tickets/${encodeURIComponent(key)}/safety/${path}`, { method: "POST", headers: auth });

    it("release answers the view, labels the record, and a later card is untrusted", async () => {
      const { app, machine } = mk({ screen: injected, recordId: "rec-1" });
      await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: "/r/a", question: false });
      expect((await machine.view("PAY-12")).status).toBe("held_safety");
      const r = await post(app, "PAY-12", "release");
      expect(r.status).toBe(200);
      const view = (await r.json()) as { status: string; safety: unknown; drafts: unknown[] };
      expect(view.status).toBe("assessed");
      expect(view.safety).toBeNull();
      expect(view.drafts.length).toBeGreaterThan(0);
      expect(learned).toEqual([{ pack: "ticket_safety", recordId: "rec-1", label: { addresses_agent: { value: false }, hidden_content: { value: false } }, kind: "person", source: "safety_release", repoPath: "/r/a" }]);
      expect(writes).toEqual([]);
      expect((await app.request("/tickets/PAY-12/card", { method: "POST", headers: auth })).status).toBe(201);
      const source = (cards[0] as { source: Parameters<typeof trustOf>[0]["source"] }).source;
      expect(trustOf({ source })).toBe("untrusted");
    });

    it("release with no record still releases, and labels nothing", async () => {
      const { app, machine } = mk({ screen: injected });
      await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
      expect((await post(app, "PAY-12", "release")).status).toBe(200);
      expect(learned).toEqual([]);
      expect((await machine.view("PAY-12")).status).toBe("assessed");
    });

    it("archive posts nothing, writes no truth, and the ticket stays archived on the next poll", async () => {
      const { app, machine } = mk({ screen: injected, recordId: "rec-1" });
      await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
      const r = await post(app, "PAY-12", "archive");
      expect(r.status).toBe(200);
      expect(((await r.json()) as { status: string }).status).toBe("archived");
      expect(writes).toEqual([]);
      expect(learned).toEqual([]);
      await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
      expect((await machine.view("PAY-12")).status).toBe("archived");
      expect((await machine.screenAndHold(ticket("PAY-12", "jira") as never, { repoPath: null })).held).toBe(true);
    });

    it("refuses both on a ticket that is not held with 409 not_held, and an unknown one with 404", async () => {
      const { app, machine } = mk({ screen: safe });
      await machine.ingest(ticket("PAY-12", "jira") as never, { repoPath: null, question: false });
      for (const path of ["release", "archive"]) {
        const r = await post(app, "PAY-12", path);
        expect(r.status).toBe(409);
        expect(((await r.json()) as { error: string }).error).toBe("not_held");
      }
      expect((await post(app, "PAY-99", "release")).status).toBe(404);
      expect((await app.request("/tickets/PAY-12/safety/release", { method: "POST" })).status).toBe(401);
    });
  });
});
