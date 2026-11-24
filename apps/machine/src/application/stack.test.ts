import { describe, expect, it } from "vitest";

import { GitHubError } from "./github.ts";
import { type StackDeps, currentStackFacts, stackFactsOf } from "./stack.ts";
import { fakeGitHub } from "../test/github.ts";
import type { TaskRow } from "../domain/task.ts";

const PARENT = "11111111-2222-3333-4444-555555555555";
const row = (over: Partial<TaskRow> = {}): TaskRow => ({ id: "99999999-2222-3333-4444-555555555555", repoPath: "/r", state: "awaiting_approval", branch: "task/child", archiveReason: null, card: { base: { card: PARENT, branch: "task/parent" } } as never, source: null, ...over }) as TaskRow;
const parentRow = (over: Partial<TaskRow> = {}): TaskRow => ({ id: PARENT, repoPath: "/r", state: "awaiting_ship", branch: "task/parent", archiveReason: null, card: null, source: null, ...over }) as TaskRow;
const node = (baseRef: string) => ({ number: 7, baseRefName: baseRef }) as never;

function deps(over: Partial<StackDeps> & { prMerged?: unknown; baseRef?: string; open?: boolean } = {}): StackDeps {
  const github = fakeGitHub({
    findPr: async () => (over.open === false ? null : { url: "https://github.com/o/a/pull/7", number: 7, isDraft: false }),
    prMerged: async () => (over.prMerged ?? { merged: false, mergedSha: null, state: "open", mergedAt: null }) as never,
    prFacts: async () => node(over.baseRef ?? "task/other"),
    prHeadSha: async () => "a".repeat(40),
  });
  return { github, getTask: async () => parentRow(), deliveredNumber: async () => 7, defaultBranch: async () => "main", merged: async () => false, ...over } as StackDeps;
}

describe("stackFactsOf", () => {
  it("is null for a card with no base", async () => {
    expect(await stackFactsOf(deps(), "o/a", row({ card: null }))).toBeNull();
  });

  it("names the open parent, its PR and its head", async () => {
    expect(await stackFactsOf(deps(), "o/a", row())).toEqual({ parent: { id: PARENT, branch: "task/parent", number: 7, state: "open", head: "a".repeat(40) }, defaultBranch: "main" });
  });

  it("calls the parent merged only when GitHub says merged and the PR's base was the default branch", async () => {
    const merged = { merged: true, mergedSha: "b".repeat(40), state: "closed", mergedAt: "2026-11-06T00:00:00Z" };
    expect((await stackFactsOf(deps({ prMerged: merged, baseRef: "main" }), "o/a", row()))!.parent.state).toBe("merged");
    // Merged into some other branch is not a ship: the parent is gone, never merged.
    expect((await stackFactsOf(deps({ prMerged: merged, baseRef: "task/grandparent" }), "o/a", row()))!.parent.state).toBe("gone");
  });

  it("calls the parent merged when its card is closed with a merge on record", async () => {
    const d = deps({ getTask: async () => parentRow({ state: "closed" }), merged: async () => true, open: false });
    expect((await stackFactsOf(d, "o/a", row()))!.parent.state).toBe("merged");
  });

  it("is gone when the parent card was archived, or its PR was closed without merging", async () => {
    expect((await stackFactsOf(deps({ getTask: async () => parentRow({ state: "archived", archiveReason: "rejected" }) }), "o/a", row()))!.parent.state).toBe("gone");
    const closed = { merged: false, mergedSha: null, state: "closed", mergedAt: null };
    expect((await stackFactsOf(deps({ prMerged: closed }), "o/a", row()))!.parent.state).toBe("gone");
  });

  it("falls back to the number of the parent's last passed delivering run when no PR is open on its branch", async () => {
    const d = deps({ open: false, deliveredNumber: async () => 12 });
    expect((await stackFactsOf(d, "o/a", row()))!.parent.number).toBe(12);
  });

  it("throws when GitHub fails: the caller waits and never guesses", async () => {
    const github = fakeGitHub({ findPr: async () => { throw new GitHubError("down"); } });
    await expect(stackFactsOf({ ...deps(), github }, "o/a", row())).rejects.toThrow("down");
  });
});

describe("currentStackFacts", () => {
  it("reads the card's row again each time: once the stored base is cleared, the stale row the watch holds no longer says it is stacked", async () => {
    const held = row();
    let stored = row();
    const d = deps({ getTask: async (id) => (id === held.id ? stored : parentRow()) });
    expect((await currentStackFacts(d, "o/a", held))!.parent.id).toBe(PARENT);
    stored = row({ card: {} as never });
    expect(await currentStackFacts(d, "o/a", held)).toBeNull();
    expect(await stackFactsOf(d, "o/a", held)).not.toBeNull();
  });

  it("throws for a row that cannot be read, so the watch waits instead of reading a base that may be gone", async () => {
    await expect(currentStackFacts(deps({ getTask: async () => null }), "o/a", row())).rejects.toThrow(/cannot be read/);
  });
});
