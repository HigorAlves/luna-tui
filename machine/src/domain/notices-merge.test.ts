import { describe, expect, it } from "vitest";

import { canSeeKept, mergedNotice } from "./notices.ts";

const gh = (repo: string) => ({ kind: "github", repo, number: 1, url: "u" }) as const;
const slack = (channel: string) => ({ kind: "slack", channel, ts: "1", permalink: "p" }) as const;
const jira = (key: string) => ({ kind: "jira", key, url: "u", issueType: null }) as const;
const card = (repoPath: string | null, ...sources: unknown[]) => ({ repoPath, sources: sources as never[] });

describe("what a merged duplicate's reporter may be told: it fails closed", () => {
  it("a GitHub kept card is visible only to a report from that GitHub repository", () => {
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", gh("o/a")))).toBe(true);
    expect(canSeeKept(card(null, slack("C1"), gh("o/a")), card("/r/b", gh("o/a")))).toBe(true);
    expect(canSeeKept(card("/r/a", gh("o/b")), card("/r/a", gh("o/a")))).toBe(false);
    // The same checkout is not the same audience: a Slack or Jira report on it does not see a GitHub card.
    expect(canSeeKept(card("/r/a", slack("C1")), card("/r/a", gh("o/a")))).toBe(false);
  });
  it("a card with no source, or a source in the diagram's shape, is never visible to a stranger", () => {
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a"))).toBe(false);
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", { type: "github", permalink: "https://github.com/o/a/issues/1" }))).toBe(false);
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", { kind: "notch", ref: "LUNA-1", id: "x" }))).toBe(false);
  });
  it("a Slack kept card needs the same channel, a Jira one the same project", () => {
    expect(canSeeKept(card("/r/a", slack("C1")), card("/r/a", slack("C1")))).toBe(true);
    expect(canSeeKept(card("/r/a", slack("C2")), card("/r/a", slack("C1")))).toBe(false);
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", slack("C1")))).toBe(false);
    expect(canSeeKept(card("/r/a", jira("PAY-1")), card("/r/a", jira("PAY-9")))).toBe(true);
    expect(canSeeKept(card("/r/a", jira("OPS-1")), card("/r/a", jira("PAY-9")))).toBe(false);
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", jira("PAY-9")))).toBe(false);
  });
  it("names the card by its short id only, and links it only when a link is given", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(mergedNotice(id, null)).toContain("11111111");
    expect(mergedNotice(id, null)).not.toContain("22222222");
    expect(mergedNotice(id, "https://board.example/tasks/" + id)).toContain("https://board.example/tasks/");
    // The machine's own link stays whole and clickable; a "link" that is not a plain web address is not printed.
    expect(mergedNotice(id, "https://board.example/tasks/" + id)).toContain(": https://board.example/tasks/" + id + ". Follow");
    expect(mergedNotice(id, "javascript:alert(1)")).not.toContain("javascript");
    expect(mergedNotice(id, "https://x.example/ <b>hi</b>")).not.toContain("x.example");
    const hidden = mergedNotice(null, null);
    expect(hidden).toContain("tracked");
    expect(hidden).not.toMatch(/[0-9a-f]{8}/);
  });
});

describe("the notice a split card's source hears", () => {
  it("is one fixed line and carries nothing of a child", async () => {
    const { archivedNotice } = await import("./notices.ts");
    expect(archivedNotice("split")).toBe("This was split into smaller changes; each one ships on its own.");
  });
});
