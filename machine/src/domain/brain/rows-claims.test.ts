import type { BrainClaim, BrainEdgeRow, BrainNodeRow, BrainRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { claimRows } from "./rows-claims.ts";

const repo = { slug: "luna-tui-ab12", name: "luna-tui" };
const nodes = (rows: BrainRow[]) => rows.filter((row): row is BrainNodeRow => "type" in row);
const edges = (rows: BrainRow[]) => rows.filter((row): row is BrainEdgeRow => "edge" in row);
const order = (rows: BrainRow[]) => rows.map((row) => ("type" in row ? row.type : row.edge));

const claim = (over: Partial<BrainClaim> = {}): BrainClaim => ({
  id: "c1", repo: "luna-tui-ab12", repoPath: "/r", taskId: "t1", statement: "The retro stage reads the card's diff.", quote: "the retro reads the diff",
  kind: "fact", scope: "repo", source: { kind: "card", ref: "t1", title: "Add\nretro" }, speaker: null, speakerTrust: "member", extractor: "retro",
  status: "unverified", refusal: null, tier: null, proposed: null, reasons: [], durable: null, contradicts: [], recordId: null, decidedBy: null, decidedAt: null,
  createdAt: "2026-01-02T03:04:05.000Z", ...over,
});
const context = (over: Partial<Parameters<typeof claimRows>[1]> = {}) => ({ repo, hasCard: true, knows: () => false, sourceAt: "2026-01-02T03:04:05.000Z", ...over });

describe("claimRows", () => {
  it("gives a refused claim no row", () => {
    expect(claimRows(claim({ status: "refused", refusal: "no" }), context())).toEqual([]);
  });

  it("gives an unverified claim its repo, Source, Claim and edges, and no Learning", () => {
    const rows = claimRows(claim(), context());
    expect(order(rows)).toEqual(["Repo", "Source", "SourceOfCard", "Claim", "ClaimFrom", "ClaimAboutRepo"]);
    expect(nodes(rows)[1]!.data).toEqual({ slug: "source:card/t1", kind: "card", title: "Add retro", url: null, occurred_at: "2026-01-02T03:04:05.000Z" });
    expect(edges(rows)[0]).toEqual({ edge: "SourceOfCard", from: "source:card/t1", to: "card:t1" });
    expect(nodes(rows)[2]!.data).toMatchObject({
      slug: "claim:c1", statement: "The retro stage reads the card's diff.", quote: "the retro reads the diff", kind: "fact", scope: "repo", status: "unverified",
      risk: null, decided_by: null, recorded_at: "2026-01-02T03:04:05.000Z", decided_at: null,
    });
    expect(edges(rows).map((e) => [e.edge, e.from, e.to])).toContainEqual(["ClaimFrom", "claim:c1", "source:card/t1"]);
  });

  it("gives SourceOfCard only when the card is in the graph", () => {
    expect(order(claimRows(claim(), context({ hasCard: false })))).not.toContain("SourceOfCard");
  });

  it("takes a card Source's time from the context, not from the claim, and a note's from its claim", () => {
    const card = claimRows(claim({ createdAt: "2026-01-02T10:05:00.000Z" }), context({ sourceAt: "2026-01-02T10:00:00.000Z" }));
    expect(nodes(card).find((n) => n.type === "Source")!.data.occurred_at).toBe("2026-01-02T10:00:00.000Z");
    const note = claimRows(claim({ source: { kind: "note", ref: "n1", title: "A note" }, createdAt: "2026-01-02T10:05:00.000Z" }), context({ sourceAt: "2026-01-02T10:00:00.000Z" }));
    expect(nodes(note).find((n) => n.type === "Source")!.data.occurred_at).toBe("2026-01-02T10:05:00.000Z");
  });

  it("screens the card Source's title for a secret and an address", () => {
    const rows = claimRows(claim({ source: { kind: "card", ref: "t1", title: "Mail jane.doe@client.com key AKIAIOSFODNN7EXAMPLE" } }), context());
    const title = String(nodes(rows).find((n) => n.type === "Source")!.data.title);
    expect(title).not.toContain("jane.doe@client.com");
    expect(title).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("gives a note its own Source and no repo edge without a repository", () => {
    const rows = claimRows(claim({ source: { kind: "note", ref: "n1", title: "A note" } }), context({ repo: null }));
    expect(order(rows)).toEqual(["Source", "Claim", "ClaimFrom"]);
    expect(nodes(rows)[0]!.data).toMatchObject({ slug: "source:note/c1", kind: "note", title: "A note" });
  });

  it("gives the speaker's Person and ClaimedBy, login lowercased", () => {
    const rows = claimRows(claim({ speaker: "Octo-Cat" }), context({ repo: null, hasCard: false }));
    expect(order(rows)).toEqual(["Source", "Person", "Claim", "ClaimFrom", "ClaimedBy"]);
    expect(edges(rows).at(-1)).toEqual({ edge: "ClaimedBy", from: "claim:c1", to: "person:octo-cat" });
  });

  it("gives Contradicts only to a claim it knows", () => {
    const rows = claimRows(claim({ contradicts: ["c2", "c3"] }), context({ knows: (id) => id === "c2" }));
    expect(edges(rows).filter((e) => e.edge === "Contradicts")).toEqual([{ edge: "Contradicts", from: "claim:c1", to: "claim:c2" }]);
  });

  it("adds a Learning with BasedOn for a verified durable claim", () => {
    const rows = claimRows(claim({ status: "verified", durable: true, tier: "low", decidedBy: "jev", decidedAt: "2026-02-01T00:00:00.000Z" }), context());
    expect(order(rows).slice(-3)).toEqual(["Learning", "BasedOn", "LearningAboutRepo"]);
    const learning = nodes(rows).find((n) => n.type === "Learning")!;
    expect(learning.data).toEqual({ slug: "learning:c1", title: "The retro stage reads the card's diff.", kind: "fact", scope: "repo", recorded_at: "2026-02-01T00:00:00.000Z" });
    expect(nodes(rows).find((n) => n.type === "Claim")!.data).toMatchObject({ risk: "low", decided_by: "jev", decided_at: "2026-02-01T00:00:00.000Z" });
    expect(edges(rows).find((e) => e.edge === "BasedOn")).toEqual({ edge: "BasedOn", from: "learning:c1", to: "claim:c1" });
  });

  it("uses createdAt for the Learning when decidedAt is null, and gives none when durable is false or null", () => {
    const verified = { status: "verified" as const };
    expect(nodes(claimRows(claim({ ...verified, durable: true }), context())).find((n) => n.type === "Learning")!.data.recorded_at).toBe("2026-01-02T03:04:05.000Z");
    expect(order(claimRows(claim({ ...verified, durable: false }), context()))).not.toContain("Learning");
    expect(order(claimRows(claim({ ...verified, durable: null }), context()))).not.toContain("Learning");
  });

  it("gives the same rows twice", () => {
    const c = claim({ status: "verified", durable: true, speaker: "a" });
    expect(claimRows(c, context())).toEqual(claimRows(c, context()));
  });

  it("screens a lesson's title, but keeps the whole statement length", () => {
    const statement = `Mail ops@example.com about token=abcdefghijklmnop1234. ${"x".repeat(300)}`;
    const rows = claimRows(claim({ statement, status: "verified", durable: true, decidedAt: "2026-01-03T00:00:00.000Z" }), context());
    const lesson = nodes(rows).find((row) => row.type === "Learning")!;
    expect(String(lesson.data.title)).not.toMatch(/example\.com|abcdefghijklmnop1234/);
    expect(String(lesson.data.title).length).toBeGreaterThan(200);
  });
});
