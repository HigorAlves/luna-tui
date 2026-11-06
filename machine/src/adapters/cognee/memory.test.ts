// The Memory port over a fake Cognee and the real memory_items table (Postgres): what a caller of the port sees, as it sees it with
// `fakeMemory`, plus what only the Cognee implementation does (pending rows, the daily cap, reconcile).
import { MEMORY_CONTEXT_MAX_BYTES, type MemoryItem } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryItemDraft } from "../../application/memory.ts";
import type { MemoryViewer } from "../../domain/memory-datasets.ts";
import { type FakeCognee, fakeCognee } from "../../test/cognee.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { PgMemoryStore } from "../persistence/memory-store.ts";
import { type MemoryService, cogneeMemory, usageOf } from "./memory.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

let cognee: FakeCognee;
let events: Array<Record<string, unknown>>;
let clock = new Date("2026-11-06T10:00:00.000Z");
beforeEach(async () => {
  await db.query("truncate memory_items, memory_cognify_days");
  cognee = fakeCognee();
  events = [];
  clock = new Date("2026-11-06T10:00:00.000Z");
});

const make = (extra: { mode?: "openai" | "local"; dailyCognifyItems?: number } = {}): MemoryService =>
  cogneeMemory({ client: cognee, store: new PgMemoryStore(db), mode: extra.mode ?? "openai", ...(extra.dailyCognifyItems !== undefined ? { dailyCognifyItems: extra.dailyCognifyItems } : {}), now: () => clock, log: (e) => events.push(e) });

const draft = (text: string, extra: Partial<MemoryItemDraft> = {}): MemoryItemDraft => ({
  kind: "finding",
  repo: "acme-app",
  source: { kind: "github", ref: null },
  anchors: { files: ["src/pay.ts"], commit: "abc123" },
  provenance: { by: "machine", card: "card-1", run: null, pack: null },
  trust: "fact",
  text,
  ...extra,
});
const github: MemoryViewer = { kind: "card", repo: "acme-app", source: { kind: "github", ref: null }, publicPost: false };
const rowOf = async (id: string): Promise<Record<string, unknown>> => ((await db.query("select * from memory_items where id = $1", [id])) as Array<Record<string, unknown>>)[0]!;

describe("write", () => {
  it("records a pending row, adds it to its dataset with a luna: first line, and comes back active with Cognee's ids", async () => {
    const memory = make();
    const [item] = await memory.write([draft("Verify found flaky tests in the payments module")]);
    expect(item).toMatchObject({ status: "active", dataset: { name: "acme-app:github" }, trust: "fact", kind: "finding" });
    expect(item!.cogneeDataId).toBeTruthy();
    expect(item!.dataset.id).toBeTruthy();
    expect(cognee.calls.add).toHaveLength(1);
    expect(cognee.calls.add[0]!.items[0]).toMatchObject({ lunaId: item!.id, text: `luna:${item!.id}\nVerify found flaky tests in the payments module` });
    expect(await memory.get(item!.id)).toEqual(item);
  });

  it("sends the items of one dataset in one add, in order, and the others to their own", async () => {
    const memory = make();
    const rows = await memory.write([draft("first"), draft("second"), draft("a slack one", { source: { kind: "slack", ref: "C1" } })]);
    expect(cognee.calls.add.map((a) => [a.dataset, a.items.length])).toEqual([["acme-app:github", 2], ["acme-app:slack:C1", 1]]);
    expect(rows.map((r) => r.text)).toEqual(["first", "second", "a slack one"]);
    expect(rows.every((r) => r.status === "active")).toBe(true);
  });

  it("returns the row it already holds for the same text in the same dataset, instead of a second one", async () => {
    const memory = make();
    const [a] = await memory.write([draft("same words")]);
    const [b] = await memory.write([draft("same words")]);
    expect(b!.id).toBe(a!.id);
    expect(await memory.list({})).toHaveLength(1);
  });

  it("keeps a row pending when Cognee is down or refuses the add, and sends it when the retry loop runs", async () => {
    const memory = make();
    cognee.down = true;
    const [lost] = await memory.write([draft("written while cognee was down")]);
    expect(lost!.status).toBe("pending");
    expect(await memory.recall({ query: "cognee down written", viewer: github })).toMatchObject({ items: [] });
    expect(await memory.retryPending()).toEqual({ sent: 0, pending: 1 });
    cognee.down = false;
    cognee.failAdds = 1;
    expect(await memory.retryPending()).toEqual({ sent: 0, pending: 1 });
    expect(await memory.retryPending()).toEqual({ sent: 1, pending: 0 });
    expect(await memory.get(lost!.id)).toMatchObject({ status: "active", cogneeDataId: expect.any(String) });
    expect((await memory.floor()).pending).toBe(0);
  });

  it("refuses text with nothing in it and a source with no repository", async () => {
    const memory = make();
    await expect(memory.write([draft("   ")])).rejects.toThrow(/needs text/);
    await expect(memory.write([draft("x", { repo: null })])).rejects.toThrow(/needs a repository/);
  });

  it("cuts text to 400 characters", async () => {
    const [item] = await make().write([draft("x".repeat(900))]);
    expect(item!.text).toHaveLength(400);
  });
});

describe("recall", () => {
  it("finds an item by its words, mapped back to its row by luna_id, with the row's text and anchors", async () => {
    const memory = make();
    const [item] = await memory.write([draft("Verify found flaky tests in the payments module")]);
    const result = await memory.recall({ query: "flaky payments tests", viewer: github });
    expect(result.note).toBeNull();
    expect(result.items).toEqual([{ id: item!.id, kind: "finding", text: item!.text, source: "github", anchors: item!.anchors, stale: false, score: expect.any(Number) }]);
  });

  it("applies the visibility rule: a GitHub card never sees Slack items, a public post never sees the company folder", async () => {
    const memory = make();
    await memory.write([draft("payments retries need a cap", { source: { kind: "slack", ref: "C1" } })]);
    await memory.write([draft("payments rule from github")]);
    await memory.ingestDoc({ repo: null, path: "handbook.md", name: "handbook.md", content: Buffer.from("payments policy of the company") });
    const q = { query: "payments", scope: "all" as const };
    const kinds = async (viewer: MemoryViewer) => (await memory.recall({ ...q, viewer })).items.map((i) => i.source).sort();
    expect(await kinds(github)).toEqual(["doc", "github"]);
    expect(await kinds({ ...github, publicPost: true })).toEqual(["github"]);
    expect(await kinds({ kind: "slack", repo: "acme-app", channel: "C1" })).toEqual(["doc", "slack"]);
    expect(await kinds({ kind: "slack", repo: "acme-app", channel: "C2" })).toEqual(["doc"]);
    expect(await kinds({ kind: "card", repo: "acme-app", source: { kind: "tui", ref: null }, publicPost: false })).toEqual(["doc", "github", "slack"]);
    expect(await kinds({ kind: "card", repo: "other-app", source: { kind: "github", ref: null }, publicPost: false })).toEqual(["doc"]);
  });

  it("leaves out retired items and items found outside Luna, unless asked, and marks a stale item stale", async () => {
    const memory = make();
    const [old, stale, kept] = await memory.write([draft("alpha lesson about timeouts"), draft("beta lesson about timeouts"), draft("gamma lesson about timeouts")]);
    await memory.setStatus(old!.id, "retired", "contradicted");
    await memory.setStatus(stale!.id, "stale");
    cognee.uploadOutside("acme-app:github", "pasted.md", "delta lesson about timeouts");
    await memory.reconcile();
    const ids = async (extra = {}) => (await memory.recall({ query: "lesson timeouts", viewer: github, ...extra })).items;
    const plain = await ids();
    expect(plain.map((i) => i.id).sort()).toEqual([stale!.id, kept!.id].sort());
    expect(plain.find((i) => i.id === stale!.id)!.stale).toBe(true);
    expect(await ids({ includeOutside: true })).toHaveLength(3);
  });

  it("filters by kind and by scope", async () => {
    const memory = make();
    await memory.write([draft("escalation about caching", { kind: "escalation" }), draft("finding about caching")]);
    await memory.ingestDoc({ repo: "acme-app", path: "docs/cache.md", name: "cache.md", content: Buffer.from("caching guide for the app") });
    expect((await memory.recall({ query: "caching", viewer: github, kinds: ["escalation"] })).items.map((i) => i.kind)).toEqual(["escalation"]);
    expect((await memory.recall({ query: "caching", viewer: github })).items.map((i) => i.kind).sort()).toEqual(["escalation", "finding"]);
    expect((await memory.recall({ query: "caching", viewer: github, scope: "docs" })).items.map((i) => i.kind)).toEqual(["doc"]);
  });

  it("caps the list at 12 items and 4 KB of text, and says it cut", async () => {
    const memory = make();
    await memory.write(Array.from({ length: 20 }, (_, i) => draft(`retry budget rule number ${i}`)));
    const twelve = await memory.recall({ query: "retry budget rule", viewer: github, limit: 50 });
    expect(twelve.items).toHaveLength(12);
    expect(twelve.note).toMatch(/cut to the cap/);
    await memory.write(Array.from({ length: 12 }, (_, i) => draft(`bytes ${"w".repeat(380)} ${i} bytes`)));
    const big = await memory.recall({ query: "bytes", viewer: github });
    expect(big.items.reduce((n, i) => n + Buffer.byteLength(i.text), 0)).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_BYTES);
    expect(big.items.length).toBeLessThan(12);
    expect(big.note).toMatch(/cut to the cap/);
  });

  it("never throws: Cognee down is an empty list with a note, and nothing recorded is a note too", async () => {
    const memory = make();
    expect(await memory.recall({ query: "anything", viewer: github })).toEqual({ items: [], note: "nothing recorded for this viewer yet" });
    await memory.write([draft("something about queues")]);
    cognee.down = true;
    const down = await memory.recall({ query: "queues", viewer: github });
    expect(down.items).toEqual([]);
    expect(down.note).toMatch(/^memory is unavailable: /);
    cognee.down = false;
    expect((await memory.recall({ query: "   ", viewer: github })).note).toBe("no query");
  });

  it("answers inside its 2 s budget by naming the viewer's datasets only, never one the viewer may not read", async () => {
    const memory = make();
    await memory.write([draft("slack only", { source: { kind: "slack", ref: "C9" } })]);
    await memory.write([draft("github thing")]);
    await memory.recall({ query: "thing", viewer: github });
    expect(cognee.calls.search.at(-1)!.datasets).toEqual(["acme-app:github"]);
  });
});

describe("cognify", () => {
  it("builds the graph of the datasets with items not yet built, once, and counts them", async () => {
    const memory = make();
    await memory.write([draft("one"), draft("two")]);
    await memory.cognify(["acme-app:github"]);
    await memory.cognify(["acme-app:github"]);
    expect(cognee.calls.cognify).toEqual([["acme-app:github"]]);
    expect((await memory.usage())!.cognifiedToday).toBe(2);
    expect(events.find((e) => e.event === "memory.cognify")).toMatchObject({ datasets: ["acme-app:github"], items: 2 });
  });

  it("stops asking past the day's cap, and asks again the next day", async () => {
    const memory = make({ dailyCognifyItems: 2 });
    await memory.write([draft("one"), draft("two")]);
    await memory.cognify(["acme-app:github"]);
    await memory.write([draft("three")]);
    await memory.cognify(["acme-app:github"]);
    expect(cognee.calls.cognify).toHaveLength(1);
    expect((await memory.floor()).note).toMatch(/daily cap of 2/);
    clock = new Date("2026-11-07T00:30:00.000Z");
    await memory.cognify(["acme-app:github"]);
    expect(cognee.calls.cognify).toHaveLength(2);
    expect((await memory.usage())!.cognifiedToday).toBe(1);
  });

  it("never throws, keeps the items for a later try, and shows the error on the Floor", async () => {
    const memory = make();
    await memory.write([draft("one")]);
    cognee.cognify = async () => {
      throw new Error("OpenAI refused the key");
    };
    await expect(memory.cognify(["acme-app:github"])).resolves.toBeUndefined();
    expect((await memory.floor()).note).toBe("OpenAI refused the key");
    cognee.cognify = async (datasets) => void cognee.calls.cognify.push(datasets);
    await memory.cognify(["acme-app:github"]);
    expect(cognee.calls.cognify).toHaveLength(1);
    expect((await memory.floor()).note).toBeNull();
  });
});

describe("documents", () => {
  it("uploads a file to the dataset its repository and kind give: the company folder, or the repository's docs", async () => {
    const memory = make();
    const company = await memory.ingestDoc({ repo: null, path: "policies/leave.md", name: "leave.md", content: Buffer.from("Leave policy of the company") });
    const docs = await memory.ingestDoc({ repo: "acme-app", path: "docs/arch.md", name: "arch.md", content: Buffer.from("# Architecture") });
    expect(company).toMatchObject({ kind: "doc", dataset: { name: "company" }, repo: null, source: { kind: "doc", ref: "policies/leave.md" }, status: "active" });
    expect(docs).toMatchObject({ dataset: { name: "acme-app:docs" }, repo: "acme-app" });
    expect(cognee.calls.add[0]!.items[0]!.file).toMatchObject({ name: "leave.md", type: "text/markdown" });
  });

  it("replaces a changed document by its path, and takes an unchanged one as is", async () => {
    const memory = make();
    const v1 = await memory.ingestDoc({ repo: "acme-app", path: "docs/a.md", name: "a.md", content: Buffer.from("version one") });
    expect((await memory.ingestDoc({ repo: "acme-app", path: "docs/a.md", name: "a.md", content: Buffer.from("version one") }))!.id).toBe(v1!.id);
    expect(cognee.calls.add).toHaveLength(1);
    const v2 = await memory.ingestDoc({ repo: "acme-app", path: "docs/a.md", name: "a.md", content: Buffer.from("version two") });
    expect(v2!.id).not.toBe(v1!.id);
    expect(await memory.get(v1!.id)).toMatchObject({ status: "retired" });
    expect(cognee.calls.deleted).toEqual([v1!.cogneeDataId]);
    expect((await memory.list({ kinds: ["doc"], status: ["active"] })).map((r) => r.id)).toEqual([v2!.id]);
  });

  it("retires a removed document and deletes its Cognee data", async () => {
    const memory = make();
    const doc = await memory.ingestDoc({ repo: "acme-app", path: "docs/gone.md", name: "gone.md", content: Buffer.from("soon gone") });
    await memory.removeDoc({ repo: "acme-app", path: "docs/gone.md" });
    expect(await memory.get(doc!.id)).toMatchObject({ status: "retired" });
    expect(String((await rowOf(doc!.id)).status_note)).toMatch(/deleted or moved/);
    expect(cognee.calls.deleted).toEqual([doc!.cogneeDataId]);
  });

  it("answers null and leaves no row behind when the upload fails", async () => {
    const memory = make();
    cognee.down = true;
    expect(await memory.ingestDoc({ repo: "acme-app", path: "docs/x.md", name: "x.md", content: Buffer.from("x") })).toBeNull();
    expect(await memory.list({})).toEqual([]);
  });
});

describe("code", () => {
  it("adds the repository copy under /repos to code:<slug>, builds the graph, and retires the previous commit's row", async () => {
    const memory = make();
    await memory.ingestCode({ repo: "acme-app", dir: "/state/memory/code/acme-app/c1", commit: "c1" });
    expect(cognee.calls.add[0]).toMatchObject({ dataset: "code:acme-app", items: [{ text: "/repos/acme-app/c1" }] });
    expect(cognee.calls.cognify).toEqual([["code:acme-app"]]);
    await memory.ingestCode({ repo: "acme-app", dir: "/state/memory/code/acme-app/c2", commit: "c2" });
    const rows = await memory.list({ kinds: ["code"] });
    expect(rows.map((r) => [r.anchors.commit, r.status]).sort()).toEqual([["c1", "retired"], ["c2", "active"]]);
    // The same commit again builds nothing new.
    await memory.ingestCode({ repo: "acme-app", dir: "/state/memory/code/acme-app/c2", commit: "c2" });
    expect(cognee.calls.add).toHaveLength(2);
  });

  it("throws when Cognee's add or cognify fails, leaving no row for a failed add, and takes the container path from dir", async () => {
    const memory = make();
    cognee.down = true;
    await expect(memory.ingestCode({ repo: "acme-app", dir: "/repos/acme-app/c1", commit: "c1" })).rejects.toThrow();
    expect(await memory.list({})).toEqual([]);
    cognee.down = false;
    await memory.ingestCode({ repo: "acme-app", dir: "/repos/acme-app/c1", commit: "c1" });
    expect(cognee.calls.add[0]!.items[0]!.text).toBe("/repos/acme-app/c1");
    cognee.cognify = async () => {
      throw new Error("graph build failed");
    };
    await expect(memory.ingestCode({ repo: "acme-app", dir: "/repos/acme-app/c2", commit: "c2" })).rejects.toThrow(/graph build failed/);
  });

  it("gives company items ids of the co_ shape and repository items mem_", async () => {
    const memory = make();
    const doc = await memory.ingestDoc({ repo: null, path: "a.md", name: "a.md", content: Buffer.from("company text") });
    const [item] = await memory.write([draft("repo text")]);
    expect(doc!.id).toMatch(/^co_[0-9a-f]{16}$/);
    expect(item!.id).toMatch(/^mem_/);
  });

  it("answers a code read for the repository's viewers only, and null for a repository with no graph", async () => {
    const memory = make();
    await memory.ingestCode({ repo: "acme-app", dir: "/x/acme-app/c1", commit: "c1" });
    expect(await memory.code({ viewer: github, repo: "acme-app", operation: "neighbors", args: { symbol: "main" } })).toEqual([{ symbol: "main", file: "src/main.ts" }]);
    expect(cognee.calls.code.at(-1)).toEqual({ dataset: "code:acme-app", operation: "neighbors" });
    expect(await memory.code({ viewer: { kind: "card", repo: "other-app", source: { kind: "github", ref: null }, publicPost: false }, repo: "acme-app", operation: "search", args: {} })).toBeNull();
    expect(await memory.code({ viewer: github, repo: "nothing", operation: "search", args: {} })).toBeNull();
  });

  it("returns code graph hits from a recall with scope code", async () => {
    const memory = make();
    await memory.ingestCode({ repo: "acme-app", dir: "/x/acme-app/c1", commit: "c1" });
    const result = await memory.recall({ query: "main entry", viewer: github, scope: "code" });
    expect(result.items).toEqual([expect.objectContaining({ kind: "code", source: "code", anchors: { files: ["src/main.ts"], commit: null } })]);
  });
});

describe("answer", () => {
  it("is null without Cognee's own key (local mode), and written by Cognee over the viewer's datasets with the sources recall finds, with it", async () => {
    await make({ mode: "local" }).write([draft("retries are capped at three")]);
    expect(await make({ mode: "local" }).answer({ query: "retries", viewer: github })).toBeNull();
    const memory = make({ mode: "openai" });
    const answer = await memory.answer({ query: "how many retries", viewer: github });
    expect(answer!.text).toBe("An answer.");
    expect(answer!.citations).toEqual([expect.objectContaining({ kind: "item" })]);
    cognee.down = true;
    expect(await memory.answer({ query: "x", viewer: github })).toBeNull();
  });
});

describe("forget, status, adopt", () => {
  it("forgets an item: deletes its Cognee data, retires the row with who and why, and says false for an unknown id", async () => {
    const memory = make();
    const [item] = await memory.write([draft("wrong lesson")]);
    expect(await memory.forget(item!.id, "higor", "not true any more")).toBe(true);
    expect(cognee.calls.deleted).toEqual([item!.cogneeDataId]);
    expect(await memory.get(item!.id)).toMatchObject({ status: "retired" });
    expect(String((await rowOf(item!.id)).status_note)).toBe("forgotten by higor: not true any more");
    expect(await memory.forget("mem_nothing", "higor")).toBe(false);
    expect(await memory.forget(item!.id, "higor")).toBe(true);
  });

  it("retires the row even when Cognee cannot delete now, and reconcile finishes the delete", async () => {
    const memory = make();
    const [item] = await memory.write([draft("another wrong lesson")]);
    cognee.down = true;
    expect(await memory.forget(item!.id, "higor")).toBe(true);
    expect(await memory.get(item!.id)).toMatchObject({ status: "retired" });
    expect((await rowOf(item!.id)).forget_pending).toBe(true);
    cognee.down = false;
    await memory.reconcile();
    expect(cognee.calls.deleted).toEqual([item!.cogneeDataId]);
    expect((await rowOf(item!.id)).forget_pending).toBe(false);
  });

  it("moves a status, lists with filters and pages, and adopts only an outside item", async () => {
    const memory = make();
    const [a, b, c] = await memory.write([draft("a"), draft("b", { kind: "outcome", provenance: { by: "machine", card: "card-2", run: null, pack: null } }), draft("c", { repo: "other-app" })]);
    await memory.setStatus(a!.id, "stale", "files moved on");
    expect((await memory.list({ status: ["stale"] })).map((r) => r.id)).toEqual([a!.id]);
    expect((await memory.list({ repo: "acme-app", kinds: ["outcome"] })).map((r) => r.id)).toEqual([b!.id]);
    expect((await memory.list({ card: "card-2" })).map((r) => r.id)).toEqual([b!.id]);
    expect((await memory.list({ repo: "other-app" })).map((r) => r.id)).toEqual([c!.id]);
    expect(await memory.list({ limit: 2 })).toHaveLength(2);
    expect(await memory.list({ limit: 2, offset: 2 })).toHaveLength(1);
    expect(await memory.adopt(a!.id, "higor")).toBe(false);
    cognee.uploadOutside("acme-app:github", "note.md", "an uploaded note");
    await memory.reconcile();
    const [outside] = await memory.list({ trust: ["outside"] });
    expect(await memory.adopt(outside!.id, "higor")).toBe(true);
    expect(await memory.get(outside!.id)).toMatchObject({ trust: "lesson", provenance: { by: "person" } });
    expect(await memory.adopt(outside!.id, "higor")).toBe(false);
  });
});

describe("reconcile", () => {
  it("gives an item Cognee holds with no row of ours an outside row, once", async () => {
    const memory = make();
    await memory.write([draft("ours")]);
    cognee.uploadOutside("acme-app:github", "pasted.md", "uploaded in the UI");
    cognee.uploadOutside("company", "handbook.pdf", "company pdf");
    expect(await memory.reconcile()).toEqual({ added: 2, retired: 0 });
    expect(await memory.reconcile()).toEqual({ added: 0, retired: 0 });
    const outside = await memory.list({ trust: ["outside"] });
    expect(outside.map((r) => [r.dataset.name, r.repo, r.kind, r.status]).sort()).toEqual([["acme-app:github", "acme-app", "doc", "active"], ["company", null, "doc", "active"]]);
    expect(outside.every((r) => r.provenance.by === "person" && r.cogneeDataId !== null)).toBe(true);
  });

  it("retires a row whose data was deleted in Cognee, with the note 'deleted outside Luna', and a row whose whole dataset went", async () => {
    const memory = make();
    const [a] = await memory.write([draft("will vanish")]);
    const [b] = await memory.write([draft("dataset will vanish", { source: { kind: "tui", ref: null } })]);
    cognee.removeOutside("acme-app:github", a!.cogneeDataId!);
    cognee.store.delete("acme-app:tui");
    expect(await memory.reconcile()).toEqual({ added: 0, retired: 2 });
    expect(await memory.get(a!.id)).toMatchObject({ status: "retired" });
    expect(await memory.get(b!.id)).toMatchObject({ status: "retired" });
    expect(String((await rowOf(a!.id)).status_note)).toBe("deleted outside Luna");
  });

  it("leaves pending rows alone, links a pending row whose add answer was lost, and does nothing when Cognee is down", async () => {
    const memory = make();
    cognee.down = true;
    const [lost] = await memory.write([draft("answer lost")]);
    cognee.down = false;
    // Cognee did get it, but the machine never heard.
    const dataId = cognee.uploadOutside("acme-app:github", "text_x", "luna:" + lost!.id + "\nanswer lost");
    const target = [...cognee.store.values()][0]!.items.find((i) => i.dataId === dataId)!;
    target.lunaId = lost!.id;
    expect(await memory.reconcile()).toEqual({ added: 0, retired: 0 });
    expect(await memory.get(lost!.id)).toMatchObject({ status: "active", cogneeDataId: dataId });
    cognee.down = true;
    expect(await memory.reconcile()).toEqual({ added: 0, retired: 0 });
    expect(await memory.get(lost!.id)).toMatchObject({ status: "active" });
  });
});

describe("usage", () => {
  it("reads tokens and cost from whatever rows Cognee reports, null when it reports none, and nothing in local mode", async () => {
    expect(usageOf([{ model: "m", total_tokens: 100, total_cost: 0.5 }, { model: "n", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.25 }])).toEqual({ tokens: 115, costUsd: 0.75 });
    expect(usageOf({ models: { a: { tokens: 7 } } })).toEqual({ tokens: 7, costUsd: null });
    expect(usageOf({ message: "no sessions" })).toEqual({ tokens: null, costUsd: null });
    expect(usageOf(null)).toEqual({ tokens: null, costUsd: null });
    const memory = make();
    cognee.cost = async () => [{ total_tokens: 42, total_cost: 0.01 }];
    expect(await memory.usage()).toEqual({ tokensToday: 42, costUsdToday: 0.01, cognifiedToday: 0 });
    expect(await make({ mode: "local" }).usage()).toEqual({ tokensToday: null, costUsdToday: null, cognifiedToday: 0 });
  });

  it("gives the Floor the mode, the counts and the cap", async () => {
    const memory = make({ dailyCognifyItems: 50 });
    await memory.write([draft("one")]);
    expect(await memory.floor()).toEqual({ enabled: true, mode: "openai", cognifiedToday: 0, dailyCognifyItems: 50, tokensToday: null, costUsdToday: null, pending: 0, items: 1, note: null });
  });
});

describe("the table", () => {
  it("has the indexes the lookups need", async () => {
    const names = ((await db.query("select indexname from pg_indexes where tablename = 'memory_items'")) as Array<{ indexname: string }>).map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(["IDX_memory_items_repo", "IDX_memory_items_status", "IDX_memory_items_card", "IDX_memory_items_dataset", "IDX_memory_items_hash"]));
  });

  it("round-trips a MemoryItem exactly", async () => {
    const [item] = await make().write([draft("round trip", { anchors: { files: ["a.ts", "b.ts"], commit: null }, provenance: { by: "pack", card: "c", run: "r", pack: "memory_extract" } })]);
    const read = (await make().get(item!.id)) as MemoryItem;
    expect(read).toEqual(item);
    expect(read.createdAt).toBe("2026-11-06T10:00:00.000Z");
  });
});
