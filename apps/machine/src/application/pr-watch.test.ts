import { describe, expect, it } from "vitest";

import { fakeGitHub } from "../test/github.ts";
import type { PrReview } from "./github.ts";
import { type WatchedCard, PrWatch } from "./pr-watch.ts";

const ME = "luna-bot";
const THEM = "reviewer";
const T0 = new Date("2026-11-24T10:00:00Z");
/** `minutes` after T0. */
const at = (minutes: number): string => new Date(T0.getTime() + minutes * 60_000).toISOString();
const nowAt = (minutes: number): (() => Date) => () => new Date(at(minutes));

const card = (over: Partial<WatchedCard> = {}): WatchedCard => ({ id: "t1", route: "review", repoPath: "/r/a", source: { repo: "o/a", number: 12 }, since: T0, ...over });

interface World {
  state?: "open" | "closed";
  merged?: boolean;
  head?: string | null;
  headAt?: string | null;
  checks?: "SUCCESS" | "FAILURE";
  reviews?: PrReview[];
  threads?: Array<{ id: string; comments: Array<{ author: string; at: string }> }>;
}

const review = (over: Partial<PrReview> = {}): PrReview => ({ author: ME, state: "COMMENTED", commitId: "sha1", at: at(0), association: null, ...over });

function setup(world: World = {}, options: { cards?: WatchedCard[]; policy?: { auto_rereview: "on" | "off"; quiet_minutes: number }; minutes?: number } = {}) {
  const sent: Array<{ id: string; what: string; key?: string }> = [];
  const github = fakeGitHub({
    viewer: async () => ({ login: ME, teams: [] }),
    prMerged: async () => ({ merged: world.merged ?? false, mergedSha: null, state: world.state ?? "open", mergedAt: null }),
    prFacts: async () =>
      ({
        number: 12,
        commits: { nodes: [{ commit: { oid: world.head === undefined ? "sha1" : world.head, committedDate: world.headAt === undefined ? at(0) : world.headAt, statusCheckRollup: { state: world.checks ?? "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: world.checks === "FAILURE" ? "FAILURE" : "SUCCESS", detailsUrl: null }] } } } }] },
      }) as never,
    prReviews: async () => world.reviews ?? [],
    prThreads: async () => (world.threads ?? []).map((t) => ({ id: t.id, path: null, line: null, comments: t.comments.map((c) => ({ author: c.author, body: "x", at: c.at, association: null })) })),
  });
  const watch = new PrWatch({
    github,
    watching: async () => options.cards ?? [card()],
    send: async (id, what, key) => void sent.push({ id, what, ...(key ? { key } : {}) }),
    policy: async () => options.policy ?? { auto_rereview: "on", quiet_minutes: 15 },
    now: nowAt(options.minutes ?? 60),
  });
  return { watch, sent, github };
}

describe("the PR watch", () => {
  it.each(["review", "ci_fix", "address"] as const)("%s: a merged PR ends the card, and a closed one too", async (route) => {
    const merged = setup({ state: "closed", merged: true }, { cards: [card({ route })] });
    await merged.watch.tick();
    expect(merged.sent).toEqual([{ id: "t1", what: "merged" }]);
    const closed = setup({ state: "closed", merged: false }, { cards: [card({ route })] });
    await closed.watch.tick();
    expect(closed.sent).toEqual([{ id: "t1", what: "closed" }]);
  });

  it("an open PR with nothing new sends nothing", async () => {
    const { watch, sent } = setup({ reviews: [review()] });
    await watch.tick();
    expect(sent).toEqual([]);
  });

  describe("review route", () => {
    it("a new head commit since our review loops the card back, once the PR has been quiet", async () => {
      const { watch, sent } = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 30 });
      await watch.tick();
      expect(sent).toEqual([{ id: "t1", what: "responded", key: `sha2:${at(5)}` }]);
    });

    it("waits while the PR is still moving (inside review.quiet_minutes)", async () => {
      const { watch, sent } = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 10 });
      await watch.tick();
      expect(sent).toEqual([]);
    });

    it("uses the repository's quiet window", async () => {
      const { watch, sent } = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 10, policy: { auto_rereview: "on", quiet_minutes: 3 } });
      await watch.tick();
      expect(sent).toHaveLength(1);
    });

    it("a reply from someone else in a thread we started, after our review, loops it back", async () => {
      const { watch, sent } = setup({ reviews: [review()], threads: [{ id: "th", comments: [{ author: ME, at: at(0) }, { author: THEM, at: at(4) }] }] }, { minutes: 30 });
      await watch.tick();
      expect(sent).toEqual([{ id: "t1", what: "responded", key: `sha1:${at(4)}` }]);
    });

    it("ignores a thread someone else started, a reply that came before our review, and our own replies", async () => {
      const { watch, sent } = setup(
        {
          reviews: [review({ at: at(10) })],
          threads: [
            { id: "theirs", comments: [{ author: THEM, at: at(11) }, { author: "other", at: at(12) }] },
            { id: "old", comments: [{ author: ME, at: at(0) }, { author: THEM, at: at(2) }] },
            { id: "ours", comments: [{ author: ME, at: at(0) }, { author: ME, at: at(11) }] },
          ],
        },
        { minutes: 60 },
      );
      await watch.tick();
      expect(sent).toEqual([]);
    });

    it("fires once per key: the same head and activity are not acted on again", async () => {
      const first = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 30 });
      await first.watch.tick();
      const key = first.sent[0]!.key!;
      const again = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 30, cards: [card({ watchKey: key })] });
      await again.watch.tick();
      expect(again.sent).toEqual([]);
      const newer = setup({ reviews: [review()], head: "sha3", headAt: at(8) }, { minutes: 30, cards: [card({ watchKey: key })] });
      await newer.watch.tick();
      expect(newer.sent).toHaveLength(1);
    });

    it("review.auto_rereview: off never loops a review card back by itself, but a merge still ends it", async () => {
      const off = { auto_rereview: "off" as const, quiet_minutes: 15 };
      const moved = setup({ reviews: [review()], head: "sha2", headAt: at(5) }, { minutes: 30, policy: off });
      await moved.watch.tick();
      expect(moved.sent).toEqual([]);
      const merged = setup({ state: "closed", merged: true }, { policy: off });
      await merged.watch.tick();
      expect(merged.sent).toEqual([{ id: "t1", what: "merged" }]);
    });

    it("with no review of ours on record (a dropped verdict) only a head commit after the card began watching counts", async () => {
      const before = setup({ reviews: [], head: "sha2", headAt: at(-5) }, { minutes: 30 });
      await before.watch.tick();
      expect(before.sent).toEqual([]);
      const after = setup({ reviews: [], head: "sha2", headAt: at(5) }, { minutes: 30 });
      await after.watch.tick();
      expect(after.sent).toEqual([{ id: "t1", what: "responded", key: `sha2:${at(5)}` }]);
    });

    it("takes the latest review of ours, not an earlier one, and ignores other people's reviews", async () => {
      const { watch, sent } = setup({ reviews: [review({ commitId: "old", at: at(-30) }), review({ commitId: "sha1", at: at(0) }), review({ author: THEM, commitId: "other", at: at(1) })], head: "sha1" }, { minutes: 60 });
      await watch.tick();
      expect(sent).toEqual([]);
    });
  });

  describe("ci_fix route", () => {
    it("a red head loops the card back to ci_watch after the quiet window, once per head", async () => {
      const { watch, sent } = setup({ checks: "FAILURE", head: "sha2", headAt: at(5) }, { cards: [card({ route: "ci_fix" })], minutes: 30 });
      await watch.tick();
      expect(sent).toEqual([{ id: "t1", what: "responded", key: `sha2:${at(5)}` }]);
      const again = setup({ checks: "FAILURE", head: "sha2", headAt: at(5) }, { cards: [card({ route: "ci_fix", watchKey: sent[0]!.key! })], minutes: 30 });
      await again.watch.tick();
      expect(again.sent).toEqual([]);
    });

    it("a green head sends nothing, and the review switch does not govern it", async () => {
      const green = setup({ checks: "SUCCESS" }, { cards: [card({ route: "ci_fix" })] });
      await green.watch.tick();
      expect(green.sent).toEqual([]);
      const off = setup({ checks: "FAILURE", headAt: at(0) }, { cards: [card({ route: "ci_fix" })], policy: { auto_rereview: "off", quiet_minutes: 15 } });
      await off.watch.tick();
      expect(off.sent).toHaveLength(1);
    });
  });

  describe("address route", () => {
    it("an unresolved thread with a comment from someone else after the card began watching loops it back to addressing", async () => {
      const { watch, sent } = setup({ threads: [{ id: "th", comments: [{ author: THEM, at: at(-20) }, { author: ME, at: at(-5) }, { author: THEM, at: at(6) }] }] }, { cards: [card({ route: "address" })], minutes: 30 });
      await watch.tick();
      expect(sent).toEqual([{ id: "t1", what: "responded", key: `sha1:${at(6)}` }]);
    });

    it("does nothing for comments from before the card began watching or from us", async () => {
      const { watch, sent } = setup({ threads: [{ id: "th", comments: [{ author: THEM, at: at(-20) }, { author: ME, at: at(5) }] }] }, { cards: [card({ route: "address" })], minutes: 60 });
      await watch.tick();
      expect(sent).toEqual([]);
    });

    it("waits out the quiet window", async () => {
      const { watch, sent } = setup({ threads: [{ id: "th", comments: [{ author: THEM, at: at(6) }] }] }, { cards: [card({ route: "address" })], minutes: 10 });
      await watch.tick();
      expect(sent).toEqual([]);
    });
  });

  it("one card whose GitHub read fails does not stop the others", async () => {
    const sent: string[] = [];
    const github = fakeGitHub({
      viewer: async () => ({ login: ME, teams: [] }),
      prMerged: async (_slug, number) => {
        if (number === 1) throw new Error("boom");
        return { merged: true, mergedSha: null, state: "closed", mergedAt: null };
      },
    });
    const watch = new PrWatch({
      github,
      watching: async () => [card({ id: "a", source: { repo: "o/a", number: 1 } }), card({ id: "b", source: { repo: "o/a", number: 2 } })],
      send: async (id) => void sent.push(id),
      policy: async () => ({ auto_rereview: "on", quiet_minutes: 15 }),
      now: nowAt(60),
      warn: () => {},
    });
    await watch.tick();
    expect(sent).toEqual(["b"]);
  });

  it("a card with no PR source is skipped", async () => {
    const { watch, sent, github } = setup({}, { cards: [card({ source: null })] });
    await watch.tick();
    expect(sent).toEqual([]);
    expect(github.calls).toEqual([]);
  });
});
