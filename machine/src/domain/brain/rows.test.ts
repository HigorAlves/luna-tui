import type { BrainEdgeRow, BrainNodeRow, BrainRow } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../task.ts";
import { cardRows, prRows, repoRows, ticketRows, type BrainPull, type RetroFacts } from "./rows.ts";

const repo = { slug: "luna-tui-ab12", name: "luna-tui" };

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t-1",
    title: "Export reports",
    description: "plain description",
    criteria: [],
    repoPath: "/work/luna-tui",
    source: null,
    route: "feature",
    state: "implementing",
    retries: { verify: 0, e2e: 0, ci: 0, total: 0, stronger: 0 },
    diffAdded: null,
    diffRemoved: null,
    jira: null,
    stateSince: null,
    createdAt: new Date("2026-01-02T03:04:05.678Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    ...over,
  } as TaskRow;
}

const retro: RetroFacts = {
  predicted: { size: "M", risk: "Low", estLoc: 120 },
  actual: { added: 100, removed: 20, retries: { verify: 1, e2e: 0, ci: 1, total: 4 }, escalations: 2, format: null, durationMin: null },
  runs: 3,
};

const nodes = (rows: BrainRow[]) => rows.filter((row): row is BrainNodeRow => "type" in row);
const edges = (rows: BrainRow[]) => rows.filter((row): row is BrainEdgeRow => "edge" in row);
const card = (rows: BrainRow[]) => nodes(rows).find((row) => row.type === "Card")!;

describe("repoRows", () => {
  it("is one Repo node keyed by the machine's slug", () => {
    expect(repoRows(repo)).toEqual([{ type: "Repo", data: { slug: "repo:luna-tui-ab12", name: "luna-tui" } }]);
  });
});

describe("cardRows", () => {
  it("keeps every key, null where nothing is known, with no retro and no diff", () => {
    const row = card(cardRows(task(), { repo: null, retro: null }));
    expect(row.data).toEqual({
      slug: "card:t-1",
      title: "Export reports",
      state: "open",
      route: "feature",
      size: null,
      risk: null,
      est_loc: null,
      actual_loc: null,
      retries: 0,
      escalations: null,
      opened_at: "2026-01-02T03:04:05.678Z",
      closed_at: null,
    });
  });

  it("is null for retries when the task keeps no total", () => {
    const row = card(cardRows(task({ retries: {} as TaskRow["retries"] }), { repo: null, retro: null }));
    expect(row.data.retries).toBeNull();
  });

  it("reads the prediction and the outcome from the retro", () => {
    const row = card(cardRows(task(), { repo: null, retro }));
    expect(row.data).toMatchObject({ size: "M", risk: "Low", est_loc: 120, actual_loc: 120, retries: 4, escalations: 2 });
  });

  it("prefers the task's own diff over the retro's", () => {
    const row = card(cardRows(task({ diffAdded: 7, diffRemoved: 3 }), { repo: null, retro }));
    expect(row.data.actual_loc).toBe(10);
  });

  // `total` is its own count (implementer runs and test change requests), so adding the loops' counters to it would count twice.
  it("takes the task's total without a retro, never the sum of its counters", () => {
    const retries = { verify: 1, e2e: 2, ci: 0, total: 3, stronger: 1, strongerNext: true, failures: {} } as unknown as TaskRow["retries"];
    expect(card(cardRows(task({ retries }), { repo: null, retro: null })).data.retries).toBe(3);
  });

  it("closes a closed or archived card at the time it entered that state", () => {
    const closed = card(cardRows(task({ state: "closed", stateSince: new Date("2026-02-01T00:00:00Z") }), { repo: null, retro: null }));
    expect(closed.data).toMatchObject({ state: "closed", closed_at: "2026-02-01T00:00:00.000Z" });
    const archived = card(cardRows(task({ state: "archived", stateSince: null }), { repo: null, retro: null }));
    expect(archived.data).toMatchObject({ state: "archived", closed_at: "2026-01-03T00:00:00.000Z" });
  });

  it("puts the CardInRepo edge after the Card row, and gives the same rows twice", () => {
    const first = cardRows(task(), { repo, retro });
    expect(first).toEqual(cardRows(task(), { repo, retro }));
    expect(first.map((row) => ("type" in row ? row.type : row.edge))).toEqual(["Card", "CardInRepo"]);
    expect(edges(first)[0]).toEqual({ edge: "CardInRepo", from: "card:t-1", to: "repo:luna-tui-ab12" });
  });

  it("flattens a title to one line of 200 characters", () => {
    const row = card(cardRows(task({ title: `  first\nsecond\u0007${"x".repeat(300)}` }), { repo: null, retro: null }));
    const title = row.data.title as string;
    expect(title).toHaveLength(200);
    expect(title.startsWith("first second x")).toBe(true);
    expect(title).not.toMatch(/[\u0000-\u001f]/);
  });

  it("never carries the description, criteria, reason or archive reason", () => {
    const rows = [
      ...cardRows(task({ description: "SECRET-TEXT", criteria: ["SECRET-TEXT"], reason: "SECRET-TEXT" }), { repo, retro }),
      ...ticketRows(task({ description: "SECRET-TEXT", jira: { key: "PLAT-1", url: "https://j/PLAT-1" } as TaskRow["jira"] })),
    ];
    expect(JSON.stringify(rows)).not.toContain("SECRET-TEXT");
  });
});

describe("ticketRows", () => {
  it("is empty for a task with no tracker item", () => {
    expect(ticketRows(task())).toEqual([]);
    expect(ticketRows(task({ source: { kind: "github_pr", repo: "o/r", number: 1, url: "u", headRef: "h", baseRef: "b" } }))).toEqual([]);
    expect(ticketRows(task({ source: { kind: "slack", channel: "C1", ts: "1.2", permalink: "p" } }))).toEqual([]);
  });

  it("gives exactly one Ticket, the Jira one, when a task has both", () => {
    const rows = ticketRows(
      task({
        jira: { key: "PLAT-9", url: "https://j/PLAT-9" } as TaskRow["jira"],
        source: { kind: "github", repo: "o/r", number: 4, url: "https://g/4" },
      }),
    );
    expect(nodes(rows)).toEqual([{ type: "Ticket", data: { slug: "ticket:jira/PLAT-9", tracker: "jira", key: "PLAT-9", title: "Export reports", url: "https://j/PLAT-9" } }]);
    expect(edges(rows)).toEqual([{ edge: "CardForTicket", from: "card:t-1", to: "ticket:jira/PLAT-9" }]);
  });

  it("falls back to a GitHub issue source", () => {
    const rows = ticketRows(task({ source: { kind: "github", repo: "o/r", number: 4, url: "https://g/4" } }));
    expect(nodes(rows)[0]!.data).toMatchObject({ slug: "ticket:github/o/r#4", tracker: "github", key: "o/r#4", url: "https://g/4" });
    expect(rows).toHaveLength(2);
  });

  it("takes a Jira source when the task has no link", () => {
    const rows = ticketRows(task({ source: { kind: "jira", key: "PLAT-2", url: "https://j/PLAT-2", issueType: null } }));
    expect(nodes(rows)[0]!.data).toMatchObject({ slug: "ticket:jira/PLAT-2", tracker: "jira" });
  });
});

describe("prRows", () => {
  const pull: BrainPull = { repo: "o/r", number: 12, title: "Add\nexport", state: "merged", url: "https://g/pull/12", mergedAt: "2026-03-01T10:00:00Z", author: "Octo-Cat" };

  it("lists Person, PR, PrAuthoredBy and PrForCard in that order", () => {
    const rows = prRows(pull, "t-1");
    expect(rows.map((row) => ("type" in row ? row.type : row.edge))).toEqual(["Person", "PR", "PrAuthoredBy", "PrForCard"]);
    expect(nodes(rows)[0]!.data).toEqual({ slug: "person:octo-cat", login: "octo-cat", slack: null, active: true });
    expect(nodes(rows)[1]!.data).toEqual({ slug: "pr:o/r#12", number: 12, title: "Add export", state: "merged", url: "https://g/pull/12", merged_at: "2026-03-01T10:00:00.000Z" });
    expect(edges(rows)).toEqual([
      { edge: "PrAuthoredBy", from: "pr:o/r#12", to: "person:octo-cat" },
      { edge: "PrForCard", from: "pr:o/r#12", to: "card:t-1" },
    ]);
  });

  it("leaves out the person and the card edge when neither is known, and merged_at null when open", () => {
    const rows = prRows({ ...pull, state: "open", mergedAt: null, author: null }, null);
    expect(rows).toHaveLength(1);
    expect(nodes(rows)[0]!.data.merged_at).toBeNull();
  });
});
