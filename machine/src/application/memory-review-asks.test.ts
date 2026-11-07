import { MEMORY_CONTEXT_MAX_BYTES, MEMORY_CONTEXT_MAX_ITEMS, type RecalledMemory } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { noMemory } from "./memory.ts";
import { viewerOfCard } from "./memory-similar.ts";
import { type ReviewAskFact, excerptOf, mergeReviewAsks, planFilesOf, recallReviewAsks, reviewAskDrafts, reviewAsksQuery, writeReviewAsks } from "./memory-review-asks.ts";

const source = { kind: "github" as const, repo: "o/a", number: 4, url: "https://github.com/o/a/pull/4" };
const card = { id: "card-1", repo: "r", source };
const fact = (over: Partial<ReviewAskFact> = {}): ReviewAskFact => ({ thread: "t1", reviewer: "alice", kind: "change_request", path: "src/pay/charge.ts", excerpt: "please wrap this in a transaction", ...over });
const team = (path: string) => (path.startsWith("src/pay/") ? "@acme/payments" : null);
const recalled = (id: string, text = "ask", over: Partial<RecalledMemory> = {}): RecalledMemory => ({ id, kind: "review_ask", text, source: "github", anchors: { files: [], commit: null }, stale: false, score: 0.5, ...over });

describe("the items written when a PR merges", () => {
  it("one per thread, from a template: reviewer, team, kind, file and a short excerpt, on the card's source", () => {
    const [item, ...rest] = reviewAskDrafts(card, [fact(), fact({ thread: "t1" })], team);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ kind: "review_ask", repo: "r", source: { kind: "github", ref: "o/a" }, anchors: { files: ["src/pay/charge.ts"], commit: null }, provenance: { by: "machine", card: "card-1" }, trust: "fact" });
    expect(item!.text).toBe('Reviewer alice (team acme/payments) asked for a change in src/pay/charge.ts on a merged PR: "please wrap this in a transaction".');
  });

  it("keeps no more of a comment than 150 flattened characters, and none that holds a token", () => {
    const long = `# heading\n<b>${"x".repeat(400)}</b> @everyone #12`;
    const ex = excerptOf(long);
    expect(ex.length).toBeLessThanOrEqual(150);
    expect(ex).not.toMatch(/[\n<>]|@everyone|#12/);
    const token = `ghp_${"a1".repeat(18)}`;
    expect(excerptOf(`use ${token} here`)).toBe("");
    const [item] = reviewAskDrafts(card, [fact({ excerpt: "y".repeat(500) })], team);
    expect(item!.text.length).toBeLessThanOrEqual(400);
    expect(item!.text).not.toContain("y".repeat(151));
  });

  it("a nit, a thread with no file, and a card with no source (the operator's own) read right", () => {
    const [item] = reviewAskDrafts({ id: "c", repo: "r", source: null }, [fact({ kind: "nit", path: null, excerpt: "" })], team);
    expect(item!.text).toBe("Reviewer alice asked for a nit on a merged PR.");
    expect(item!.source).toEqual({ kind: "tui", ref: null });
    expect(item!.anchors.files).toEqual([]);
  });

  it("writes through the port, and is nothing with memory off or a failing write", async () => {
    const memory = fakeMemory();
    expect(await writeReviewAsks(memory, card, [fact(), fact({ thread: "t2", reviewer: "bob" })], team)).toBe(2);
    expect(memory.items.map((i) => i.kind)).toEqual(["review_ask", "review_ask"]);
    expect(await writeReviewAsks(noMemory(), card, [fact()], team)).toBe(0);
    const broken = {
      ...fakeMemory(),
      write: async () => {
        throw new Error("down");
      },
    };
    expect(await writeReviewAsks(broken, card, [fact()], team)).toBe(0);
  });
});

describe("the recall before the implementing run", () => {
  it("the query names the files and their owners and asks for review asks only", () => {
    const q = reviewAsksQuery(["src/pay/charge.ts", "src/pay/charge.ts", "src/a.ts"], ["@acme/payments", "@alice"]);
    expect(q.kinds).toEqual(["review_ask"]);
    expect(q.query).toContain("src/pay/charge.ts, src/a.ts");
    expect(q.query).toContain("acme/payments, alice");
    expect(reviewAsksQuery([], []).query.length).toBeLessThanOrEqual(2000);
  });

  it("reads the plan's files from its slices and its map", () => {
    expect(planFilesOf({ slices: [{ touchpoints: ["a.ts", "b.ts"] }, { touchpoints: ["a.ts"] }], map: { files: [{ path: "c.ts" }] } })).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(planFilesOf(null)).toEqual([]);
    expect(planFilesOf({ slices: "no" })).toEqual([]);
  });

  it("recalls the asks about those files, for the card's source only", async () => {
    const memory = fakeMemory();
    await writeReviewAsks(memory, card, [fact()], team);
    await writeReviewAsks(memory, { id: "c2", repo: "r", source: { kind: "slack", channel: "C9", ts: "1", permalink: "p" } }, [fact({ thread: "s" })], team);
    const mine = await recallReviewAsks(memory, { files: ["src/pay/charge.ts"], owners: ["@acme/payments"], viewer: viewerOfCard({ repoSlug: "r", source }) });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("review_ask");
    expect(await recallReviewAsks(memory, { files: [], owners: [], viewer: viewerOfCard({ repoSlug: "r", source }) })).toEqual([]);
    expect(await recallReviewAsks(noMemory(), { files: ["a"], owners: [], viewer: viewerOfCard({ repoSlug: "r", source }) })).toEqual([]);
  });
});

describe("the one call site: the asks join context.memory", () => {
  it("creates the block when absent and changes nothing with no asks", () => {
    expect(mergeReviewAsks(undefined, [])).toBeNull();
    expect(mergeReviewAsks(undefined, [recalled("a")])).toEqual({ items: [recalled("a")], note: null });
  });

  it("keeps what is there, skips an id already present, and changes nothing when nothing was added", () => {
    const existing = { items: [recalled("a", "lesson", { kind: "lesson" })], note: "kept" };
    expect(mergeReviewAsks(existing, [recalled("a")])).toBeNull();
    const out = mergeReviewAsks(existing, [recalled("b")])!;
    expect(out.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(out.note).toBe("kept");
  });

  it("never passes 12 items or 4 KB", () => {
    const full = { items: Array.from({ length: MEMORY_CONTEXT_MAX_ITEMS - 1 }, (_, i) => recalled(`e${i}`)), note: null };
    const out = mergeReviewAsks(full, [recalled("n1"), recalled("n2")])!;
    expect(out.items).toHaveLength(MEMORY_CONTEXT_MAX_ITEMS);
    expect(out.note).toMatch(/1 review ask left out/);
    const fat = { items: [recalled("big", "z".repeat(1700)), recalled("big2", "z".repeat(1500))], note: null };
    const bytes = mergeReviewAsks(fat, [recalled("n3", "q".repeat(1500))])!;
    expect(Buffer.byteLength(JSON.stringify(bytes.items))).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_BYTES);
    expect(bytes.items.map((i) => i.id)).not.toContain("n3");
  });
});
