import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConversationDrafts } from "../../application/conversation-drafts.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgDraftStore } from "./slack-drafts.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate slack_drafts");
});
const drafts = () => new ConversationDrafts(new PgDraftStore(db), { expiryHours: () => 24 });
const input = (over: Record<string, unknown> = {}) => ({ thread: "C1:1.1", channel: "C1", threadTs: "1.1", kind: "reply" as const, text: "It is queued.", cardId: null, private: false, records: { assess: "rec-1" }, ...over });

describe("PgDraftStore", () => {
  it("holds one waiting draft per thread, even when two are opened at once", async () => {
    const d = drafts();
    await Promise.all([d.open(input({ text: "a" })), d.open(input({ text: "b" }))]);
    const [{ n }] = await db.query("select count(*)::int as n from slack_drafts where status = 'waiting'");
    expect(n).toBe(1);
    const [{ s }] = await db.query("select count(*)::int as s from slack_drafts where status = 'superseded'");
    expect(s).toBe(1);
  });
  it("settles once when two taps are in flight", async () => {
    const d = drafts();
    await d.open(input());
    const results = await Promise.all([d.settle("C1:1.1", "It is queued."), d.settle("C1:1.1", "It is queued.")]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });
  it("round-trips the records, expires and reads the last edits of a channel", async () => {
    const d = drafts();
    const a = await d.open(input());
    expect((await d.get(a.id))?.records).toEqual({ assess: "rec-1" });
    await d.settle("C1:1.1", "We are on it.");
    expect((await d.recentEdits("C1", false)).map((t) => t.person)).toEqual(["We are on it."]);
    await d.open(input());
    expect(await d.expire(new Date(Date.now() + 25 * 3_600_000))).toHaveLength(1);
  });
});
