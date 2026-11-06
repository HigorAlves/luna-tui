import type { CanonicalTicket } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../../test/database.ts";
import { PgTicketStore } from "./ticket-store.ts";

let db: DataSource;
let store: PgTicketStore;
beforeAll(async () => {
  db = await freshTestDatabase();
  store = new PgTicketStore(db);
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tickets");
});

const ticket = (over: Partial<CanonicalTicket> = {}): CanonicalTicket => ({
  tool: "jira", id: "PAY-12", key: "PAY-12", title: "Refund fails", description: "It fails.", type: "Bug", status: "To Do", priority: "High",
  reporter: { id: "u1", name: "Ana" }, assignee: "bo", labels: [], components: [], links: { blocks: [], duplicates: [], epic: null },
  comments: [], attachments: [], sprint: null, dueAt: null, createdAt: null, updatedAt: null, permalink: "https://x/browse/PAY-12", ...over,
});

describe("the ticket store", () => {
  it("keeps one object per key", async () => {
    await store.read(ticket());
    await store.read(ticket({ title: "Refund fails again" }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.canonical.title).toBe("Refund fails again");
  });

  it("a re-read never overwrites what the machine owns", async () => {
    await store.read(ticket());
    await store.setMachine("PAY-12", { status: "assessed", links: [{ kind: "card", target: "c1" }], cardId: "c1" });
    await store.appendAssessment("PAY-12", { at: "2026-11-05T00:00:00Z", outcome: "workable" });
    await store.setDrafts("PAY-12", [{ id: "d1", kind: "assessment", text: "t" }]);
    const row = await store.read(ticket({ description: "edited in Jira", reporter: { id: "u9", name: "Zed" } }));
    expect(row.canonical.description).toBe("edited in Jira");
    expect(row.canonical.reporter?.id).toBe("u9");
    expect(row.machineStatus).toBe("assessed");
    expect(row.machineLinks).toEqual([{ kind: "card", target: "c1" }]);
    expect(row.cardId).toBe("c1");
    expect(row.assessments).toHaveLength(1);
    expect(row.drafts).toHaveLength(1);
  });

  it("gets one by key and answers null for an unknown one", async () => {
    expect(await store.get("NOPE-1")).toBeNull();
    await store.read(ticket());
    expect((await store.get("PAY-12"))?.key).toBe("PAY-12");
  });

  it("keeps the last 20 assessments, newest last", async () => {
    await store.read(ticket());
    for (let i = 1; i <= 25; i++) await store.appendAssessment("PAY-12", { n: i });
    const row = (await store.get("PAY-12"))!;
    expect(row.assessments).toHaveLength(20);
    expect(row.assessments[0]).toEqual({ n: 6 });
    expect(row.assessments.at(-1)).toEqual({ n: 25 });
  });

  it("changes drafts under a row lock: a conditional change that refuses leaves them alone, and two in flight do not both win", async () => {
    await store.read(ticket());
    await store.setDrafts("PAY-12", [{ id: "d", status: "waiting" }]);
    let won = 0;
    const claim = () => store.updateDrafts("PAY-12", (ds) => (ds[0]!.status === "waiting" ? (won++, [{ ...ds[0]!, status: "posting" }]) : ds));
    await Promise.all([claim(), claim()]);
    expect(won).toBe(1);
    expect((await store.get("PAY-12"))!.drafts).toEqual([{ id: "d", status: "posting" }]);
  });

  it("keeps the clocks", async () => {
    await store.read(ticket());
    await store.setClocks("PAY-12", { acknowledgeBy: "2026-11-06T00:00:00Z" });
    expect((await store.get("PAY-12"))?.clocks).toEqual({ acknowledgeBy: "2026-11-06T00:00:00Z" });
  });
});
