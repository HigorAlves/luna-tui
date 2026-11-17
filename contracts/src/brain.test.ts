import { describe, expect, it } from "vitest";

import { BRAIN_APPEND_ONLY, BRAIN_EDGES, BRAIN_NODE_TYPES, BRAIN_QUERIES, brainEdge, brainNode, brainSlug, brainTime } from "./index.ts";

describe("a brain slug", () => {
  it("is <system>:<native id>, the same for the same input", () => {
    expect(brainSlug("card", "6f1c2a9e")).toBe("card:6f1c2a9e");
    expect(brainSlug("pr", "HigorAlves/luna-tui#228")).toBe("pr:HigorAlves/luna-tui#228");
    expect(brainSlug("card", "6f1c2a9e")).toBe(brainSlug("card", "6f1c2a9e"));
  });

  it("refuses an id that is empty or holds a space, a line break or a control character", () => {
    for (const id of ["", " ", "a b", "a\nb", "a\tb", "a\u0000b"]) {
      expect(() => brainSlug("card", id), JSON.stringify(id)).toThrow(/slug/);
    }
  });
});

describe("a brain row", () => {
  // A merge load replaces the whole row and nulls what it leaves out (RFC 0010, the spike), so a row
  // always carries every key of its type.
  it("carries every nullable key, as null when the caller left it out", () => {
    const row = brainNode("Card", { slug: brainSlug("card", "6f1c2a9e"), title: "Jira intake", state: "open", route: "feature", opened_at: "2026-11-16T12:00:00.000Z" });
    expect(row).toEqual({
      type: "Card",
      data: { slug: "card:6f1c2a9e", title: "Jira intake", state: "open", route: "feature", size: null, risk: null, est_loc: null, actual_loc: null, retries: null, escalations: null, opened_at: "2026-11-16T12:00:00.000Z", closed_at: null },
    });
  });

  it("refuses a row with a required field missing, or a value outside an enum", () => {
    expect(() => brainNode("Card", { slug: "card:1", state: "open", route: "feature", opened_at: "2026-11-16T12:00:00.000Z" })).toThrow(/title/);
    expect(() => brainNode("Card", { slug: "card:1", title: "x", state: "done", route: "feature", opened_at: "2026-11-16T12:00:00.000Z" })).toThrow(/state/);
    expect(() => brainNode("Card", { slug: "pr:1", title: "x", state: "open", route: "feature", opened_at: "2026-11-16T12:00:00.000Z" })).toThrow(/card slug/);
    // omnigraph refuses a time finer than a millisecond, and a load needs the zone
    expect(() => brainNode("Card", { slug: "card:1", title: "x", state: "open", route: "feature", opened_at: "2026-11-16T12:00:00" })).toThrow(/opened_at/);
    expect(brainTime("2026-11-16T12:00:00Z")).toBe("2026-11-16T12:00:00.000Z");
  });

  it("keeps a person to a login and a Slack member id: an email never reaches the graph", () => {
    const row = brainNode("Person", { slug: brainSlug("person", "higoralves"), login: "higoralves", email: "someone@example.com" });
    expect(row.data).toEqual({ slug: "person:higoralves", login: "higoralves", slack: null, active: true });
  });

  it("makes an edge only between two slugs, under a known edge name", () => {
    expect(brainEdge("CardInRepo", "card:1", "repo:luna-tui")).toEqual({ edge: "CardInRepo", from: "card:1", to: "repo:luna-tui" });
    expect(() => brainEdge("CardInRepo", "card:1", "")).toThrow(/slug/);
    expect(() => brainEdge("NoSuchEdge" as never, "card:1", "repo:luna-tui")).toThrow(/edge/);
  });
});

describe("the brain's types", () => {
  it("names the work, code, people, verdict, evidence and fact layers", () => {
    expect([...BRAIN_NODE_TYPES].sort()).toEqual(["Actor", "Card", "Claim", "Component", "Learning", "PR", "Person", "Principle", "Repo", "Source", "Ticket", "Verdict"]);
  });

  it("has every edge join two known node types", () => {
    expect(Object.keys(BRAIN_EDGES).length).toBeGreaterThan(0);
    for (const [name, edge] of Object.entries(BRAIN_EDGES)) {
      expect(BRAIN_NODE_TYPES, name).toContain(edge.from);
      expect(BRAIN_NODE_TYPES, name).toContain(edge.to);
    }
  });

  // A verdict's truth arrives after its answer, and a claim's status changes, so both rows are written again. A lesson never is.
  it("never rewrites a lesson: it is the one append-only type", () => {
    expect([...BRAIN_APPEND_ONLY]).toEqual(["Learning"]);
  });

  it("gives a claim its words once and a status that moves", () => {
    const row = brainNode("Claim", { slug: "claim:1", statement: "The board lint must be clean before a commit.", quote: "cargo clippy must be clean before every commit", kind: "fact", scope: "repo", status: "unverified", recorded_at: "2026-11-16T12:00:00.000Z" });
    expect(row.data).toMatchObject({ status: "unverified", risk: null, decided_by: null, decided_at: null, locator: null });
    expect(() => brainNode("Claim", { ...row.data, status: "maybe" })).toThrow(/status/);
  });

  it("bounds every edge: a minimum, and a maximum or none", () => {
    for (const [name, edge] of Object.entries(BRAIN_EDGES)) {
      expect(edge.min, name).toBeGreaterThanOrEqual(0);
      if (edge.max !== null) expect(edge.max, name).toBeGreaterThanOrEqual(Math.max(edge.min, 1));
    }
  });
});

describe("the brain's named queries", () => {
  it("lists each name once, in snake case, and says whether an agent may run it", () => {
    const names = BRAIN_QUERIES.map((q) => q.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    for (const q of BRAIN_QUERIES) {
      expect(q.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(typeof q.agent, q.name).toBe("boolean");
      expect(q.description.length, q.name).toBeGreaterThan(0);
    }
  });

  it("keeps the hygiene queries away from agents", () => {
    const hygiene = BRAIN_QUERIES.filter((q) => q.hygiene);
    expect(hygiene.length).toBeGreaterThan(0);
    expect(hygiene.every((q) => !q.agent)).toBe(true);
  });
});
