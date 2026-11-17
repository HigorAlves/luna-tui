import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ClaimStore, NewClaim } from "../../application/brain-claims.ts";
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
});
