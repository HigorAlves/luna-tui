import { describe, expect, it } from "vitest";

import { canSeeKept, mergedNotice } from "./notices.ts";

const gh = (repo: string) => ({ kind: "github", repo, number: 1, url: "u" }) as const;
const slack = (channel: string) => ({ kind: "slack", channel, ts: "1", permalink: "p" }) as const;
const jira = (key: string) => ({ kind: "jira", key, url: "u", issueType: null }) as const;
const card = (repoPath: string | null, ...sources: unknown[]) => ({ repoPath, sources: sources as never[] });

describe("what a merged duplicate's reporter may be told", () => {
  it("a GitHub or plain kept card is shown to a report of the same repository, by path or by GitHub slug", () => {
    expect(canSeeKept(card("/r/a", slack("C9")), card("/r/a", gh("o/a")))).toBe(true);
    expect(canSeeKept(card(null, gh("o/a")), card("/r/b", gh("o/a")))).toBe(true);
    expect(canSeeKept(card("/r/a"), card("/r/b", gh("o/b")))).toBe(false);
    expect(canSeeKept(card("/r/a"), card(null))).toBe(false);
  });
  it("a private Slack or Jira kept card needs the same channel or project as well", () => {
    expect(canSeeKept(card("/r/a", gh("o/a")), card("/r/a", slack("C1")))).toBe(false);
    expect(canSeeKept(card("/r/a", slack("C1")), card("/r/a", slack("C1")))).toBe(true);
    expect(canSeeKept(card("/r/a", slack("C2")), card("/r/a", slack("C1")))).toBe(false);
    expect(canSeeKept(card("/r/a", jira("PAY-1")), card("/r/a", jira("PAY-9")))).toBe(true);
    expect(canSeeKept(card("/r/a", jira("OPS-1")), card("/r/a", jira("PAY-9")))).toBe(false);
  });
  it("names the card and links it only when it may, else says only that the report is tracked", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(mergedNotice(id, "http://b/tasks/" + id)).toContain("11111111");
    expect(mergedNotice(id, "http://b/tasks/" + id)).toContain("http://b/tasks/");
    const hidden = mergedNotice(null, null);
    expect(hidden).toContain("tracked");
    expect(hidden).not.toMatch(/[0-9a-f]{8}/);
  });
});
