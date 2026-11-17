import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { admission } from "../../application/brain-admission.ts";
import type { ClaimStore, NewClaim } from "../../application/brain-claims.ts";
import { noBrain } from "../../application/brain.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgClaimStore } from "./brain-claim-store.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate brain_claims");
});

const store = () => new PgClaimStore(db);
let n = 0;
const draft = (over: Partial<NewClaim> = {}): NewClaim => ({
  repoPath: "/r/a", repo: "a-1234", taskId: null, statement: `The queue drains in order ${++n}.`, quote: "drains in order", kind: "fact", scope: "repo",
  source: { kind: "card", ref: "card-1", title: "A card" }, speaker: null, speakerTrust: "member", extractor: "retro", status: "unverified", refusal: null, reasons: [], ...over,
});

describe("PgClaimStore", () => {
  it("adds a claim and keeps one row for the same source and statement", async () => {
    const s = store();
    const a = draft();
    const first = await s.add(a);
    expect(first).toMatchObject({ statement: a.statement, status: "unverified", repo: "a-1234", repoPath: "/r/a", durable: null, contradicts: [], reasons: [], decidedAt: null, source: { kind: "card", ref: "card-1", title: "A card" } });
    expect(first!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.add(a)).toBeNull();
    expect(await s.add({ ...a, source: { kind: "card", ref: "card-2", title: "B" } })).not.toBeNull();
  });

  it("gets a claim, and null for an unknown or malformed id", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    expect(await s.get(a.id)).toEqual(a);
    expect(await s.get("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await s.get("not-a-uuid")).toBeNull();
    expect(await s.update("not-a-uuid", { status: "verified" })).toBeNull();
  });

  it("finds the claim a source already handed over", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    expect(await s.findBySource(a.source, a.statement)).toEqual(a);
    expect(await s.findBySource({ kind: "note", ref: "card-1" }, a.statement)).toBeNull();
  });

  it("updates, moves updated_at forward and lists it since a time", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    await db.query("update brain_claims set updated_at = now() - interval '1 hour'");
    const cutoff = new Date(Date.now() - 60_000);
    expect(await s.list({ since: cutoff })).toHaveLength(0);
    const decidedAt = "2026-03-01T00:00:00.000Z";
    const changed = await s.update(a.id, { status: "verified", tier: "low", proposed: "verify", durable: true, contradicts: ["x"], recordId: "rec-1", decidedBy: "jev", decidedAt, reasons: ["r"] });
    expect(changed).toMatchObject({ status: "verified", tier: "low", proposed: "verify", durable: true, contradicts: ["x"], recordId: "rec-1", decidedBy: "jev", decidedAt, reasons: ["r"] });
    expect((await s.list({ since: cutoff })).map((c) => c.id)).toEqual([a.id]);
    expect(await s.update("00000000-0000-4000-8000-000000000000", { status: "rejected" })).toBeNull();
  });

  it("updates only a claim in the status it was read in, and answers null for one that moved on", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    await s.update(a.id, { status: "verified", decidedBy: "person" });
    expect(await s.update(a.id, { status: "rejected", decidedBy: "jev" }, { ifStatus: "unverified" })).toBeNull();
    expect(await s.get(a.id)).toMatchObject({ status: "verified", decidedBy: "person" });
    expect(await s.update(a.id, { status: "rejected", decidedBy: "person" }, { ifStatus: "verified" })).toMatchObject({ status: "rejected" });
  });

  it("gives the claim's own updated_at, which moves with every update", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    const [stored] = (await db.query("select updated_at from brain_claims where id = $1", [a.id])) as Array<{ updated_at: Date }>;
    expect(a.updatedAt).toBe(stored!.updated_at.toISOString());
    await db.query("update brain_claims set updated_at = now() - interval '1 hour' where id = $1", [a.id]);
    const old = (await s.get(a.id))!;
    expect(Date.parse(old.updatedAt!)).toBeLessThan(Date.now() - 3_000_000);
    const changed = (await s.update(a.id, { status: "verified" }))!;
    expect(Date.parse(changed.updatedAt!)).toBeGreaterThan(Date.parse(old.updatedAt!));
    expect((await s.list({ order: "updated_asc" }))[0]!.updatedAt).toBe(changed.updatedAt);
  });

  it("keeps a stored durable when asked to, and sets it when the claim has none", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    expect((await s.update(a.id, { durable: false }))!.durable).toBe(false);
    expect((await s.update(a.id, { status: "verified", durable: true }, { keepDurable: true }))).toMatchObject({ status: "verified", durable: false });
    expect((await s.update(a.id, { durable: true }))!.durable).toBe(true);
    const b = (await s.add(draft()))!;
    expect((await s.update(b.id, { status: "verified", durable: true }, { keepDurable: true }))).toMatchObject({ status: "verified", durable: true });
    // with no durable in the patch it changes nothing
    expect((await s.update(b.id, { status: "rejected" }, { keepDurable: true }))).toMatchObject({ status: "rejected", durable: true });
  });

  it("stores a 2000-character refused note in a 4-byte script, cut to 300 characters", async () => {
    const s = store();
    const a = admission({ store: s, brain: noBrain(), decide: null, mode: async () => "off", repoSlug: () => "a-1234" });
    // Varied characters: Postgres compresses a repeated one below the index's row limit.
    const note = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x20000 + ((i * 7919) % 40000))).join("");
    const claim = await a.remember(note, { repoPath: "/r/a", speaker: null });
    expect(claim.status).toBe("refused");
    expect([...claim.statement]).toHaveLength(300);
    expect(claim.statement.endsWith("\u2026")).toBe(true);
    // the same note again is the same claim
    expect((await a.remember(note, { repoPath: "/r/a", speaker: null })).id).toBe(claim.id);
    expect(await db.query("select count(*)::int as n from brain_claims")).toEqual([{ n: 1 }]);
  });

  it("lists newest first, filters by status and repo, and caps the limit", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    const b = (await s.add(draft({ repoPath: "/r/b", status: "refused", refusal: "no" })))!;
    const c = (await s.add(draft()))!;
    await db.query("update brain_claims set created_at = now() - interval '2 hours' where id = $1", [a.id]);
    expect((await s.list()).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect((await s.list({ status: "refused" })).map((x) => x.id)).toEqual([b.id]);
    expect((await s.list({ repoPath: "/r/a" })).map((x) => x.id)).toEqual([c.id, a.id]);
    expect(await s.list({ limit: 1 })).toHaveLength(1);
    for (let i = 0; i < 3; i++) await s.add(draft());
    expect(await s.list({ limit: 100000 })).toHaveLength(6);
  });

  it("lists oldest-updated first without a status, so the projector pages by its cursor", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    const b = (await s.add(draft({ status: "refused", refusal: "no quote" })))!;
    const c = (await s.add(draft()))!;
    await db.query("update brain_claims set updated_at = now() - interval '3 hours' where id = $1", [c.id]);
    await db.query("update brain_claims set updated_at = now() - interval '2 hours' where id = $1", [a.id]);
    await db.query("update brain_claims set updated_at = now() - interval '1 hour' where id = $1", [b.id]);
    expect((await s.list({ order: "updated_asc" })).map((claim) => claim.id)).toEqual([c.id, a.id, b.id]);
    expect((await s.list({ order: "updated_asc", except: "refused" })).map((claim) => claim.id)).toEqual([c.id, a.id]);
    expect((await s.list({ order: "updated_asc", except: "refused", limit: 1 })).map((claim) => claim.id)).toEqual([c.id]);
  });

  it("counts waiting, decided, agreed and missed", async () => {
    const s = store();
    const make = async (status: "unverified" | "verified" | "rejected", proposed: "verify" | "flag" | "ask" | "reject" | null, by: "person" | "jev" | null) => {
      const c = (await s.add(draft()))!;
      await s.update(c.id, { status, proposed, decidedBy: by, decidedAt: by ? "2026-03-01T00:00:00.000Z" : null });
    };
    await make("unverified", null, null);
    await make("unverified", "ask", null);
    await make("verified", "verify", "person"); // agreed
    await make("verified", "flag", "person"); // agreed
    await make("rejected", "reject", "person"); // agreed
    await make("rejected", "verify", "person"); // missed
    await make("rejected", "flag", "person"); // missed
    await make("verified", "reject", "person"); // decided, neither
    await make("verified", "ask", "person"); // not counted: Jev proposed no side
    await make("verified", "verify", "jev"); // not a person's
    expect(await s.stats()).toEqual({ waiting: 2, decided: 6, agreed: 3, missed: 2, ready: false });
    const other = (await s.add(draft({ repoPath: "/r/other" })))!;
    expect(await s.stats("/r/other")).toEqual({ waiting: 1, decided: 0, agreed: 0, missed: 0, ready: false });
    expect(other.id).toBeTruthy();
  });

  it("is ready once 50 decided claims agree and none were missed", async () => {
    const s = store();
    for (let i = 0; i < 50; i++) {
      const c = (await s.add(draft()))!;
      await s.update(c.id, { status: "verified", proposed: "verify", decidedBy: "person", decidedAt: "2026-03-01T00:00:00.000Z" });
    }
    expect(await s.stats()).toEqual({ waiting: 0, decided: 50, agreed: 50, missed: 0, ready: true });
    const late = (await s.add(draft()))!;
    await s.update(late.id, { status: "rejected", proposed: "flag", decidedBy: "person", decidedAt: "2026-03-01T00:00:00.000Z" });
    expect(await s.stats()).toMatchObject({ decided: 51, missed: 1, ready: false });
  });

  it("counts a claim Jev decided alone and a person changed later by the person's decision", async () => {
    const s = store();
    const at = "2026-03-01T00:00:00.000Z";
    const verifiedByJev = (await s.add(draft()))!;
    await s.update(verifiedByJev.id, { status: "verified", proposed: "verify", decidedBy: "jev", decidedAt: at });
    const rejectedByJev = (await s.add(draft()))!;
    await s.update(rejectedByJev.id, { status: "rejected", proposed: "reject", decidedBy: "jev", decidedAt: at });
    expect(await s.stats()).toMatchObject({ decided: 0, agreed: 0, missed: 0 });
    await s.update(verifiedByJev.id, { status: "rejected", decidedBy: "person", decidedAt: at });
    expect(await s.stats()).toMatchObject({ decided: 1, agreed: 0, missed: 1 });
    await s.update(rejectedByJev.id, { status: "verified", decidedBy: "person", decidedAt: at });
    expect(await s.stats()).toMatchObject({ decided: 2, agreed: 0, missed: 1 });
  });

  it("lists by who decided and since when", async () => {
    const s = store();
    const make = async (decidedBy: "code" | "jev" | "person" | null, decidedAt: string | null) => {
      const c = (await s.add(draft()))!;
      await s.update(c.id, { status: "verified", decidedBy, decidedAt });
      return c.id;
    };
    const old = await make("jev", "2026-01-01T00:00:00.000Z");
    const recent = await make("jev", "2026-03-02T00:00:00.000Z");
    const edge = await make("jev", "2026-03-01T00:00:00.000Z");
    const person = await make("person", "2026-03-02T00:00:00.000Z");
    await make(null, null);
    const ids = async (filter: Parameters<ClaimStore["list"]>[0]) => (await s.list(filter)).map((c) => c.id).sort();
    expect(await ids({ decidedBy: "jev" })).toEqual([old, recent, edge].sort());
    expect(await ids({ decidedBy: "jev", decidedSince: new Date("2026-03-01T00:00:00.000Z") })).toEqual([recent, edge].sort());
    expect(await ids({ decidedSince: new Date("2026-03-02T00:00:00.000Z") })).toEqual([recent, person].sort());
    expect(await ids({ decidedBy: "person" })).toEqual([person]);
  });

  it("deletes a claim's row, and says false for an unknown or malformed id", async () => {
    const s = store();
    const a = (await s.add(draft()))!;
    const b = (await s.add(draft()))!;
    expect(await s.delete(a.id)).toBe(true);
    expect(await s.get(a.id)).toBeNull();
    expect(await s.get(b.id)).not.toBeNull();
    expect(await s.delete(a.id)).toBe(false);
    expect(await s.delete("not-a-uuid")).toBe(false);
  });

  it("blanks the speaker of every claim that names a login, however it is cased, and moves updated_at", async () => {
    const s = store();
    const octo = (await s.add(draft({ speaker: "octo" })))!;
    const loud = (await s.add(draft({ speaker: " OcTo " })))!;
    const other = (await s.add(draft({ speaker: "octopus" })))!;
    const nobody = (await s.add(draft()))!;
    expect(await s.forgetSpeaker("octo")).toBe(2);
    expect((await s.get(octo.id))!.speaker).toBeNull();
    expect((await s.get(loud.id))!.speaker).toBeNull();
    expect((await s.get(other.id))!.speaker).toBe("octopus");
    expect((await s.get(nobody.id))!.speaker).toBeNull();
    expect(Date.parse((await s.get(octo.id))!.updatedAt!)).toBeGreaterThan(Date.parse(octo.updatedAt!));
    expect(await s.forgetSpeaker("octo")).toBe(0);
  });
});
