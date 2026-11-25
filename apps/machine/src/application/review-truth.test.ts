import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Learned, TruthSink } from "./decision-truth.ts";
import { keepThreadDecisions, learnAtMerge, learnFromRereview } from "./review-truth.ts";

let stateDir: string;
let truth: TruthSink & { learned: ReturnType<typeof vi.fn> };
beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "review-truth-"));
  truth = { learned: vi.fn(async (_fact: Learned) => true) };
});

const kept = () =>
  keepThreadDecisions(stateDir, "t1", {
    resolved: [
      { threadId: "T1", recordId: "rec-fixed", settle: "fixed" },
      { threadId: "T2", recordId: "rec-holds", settle: "reply_holds" },
    ],
    acknowledged: [{ threadId: "T3", recordId: "rec-ack" }],
  });
const labelled = () => truth.learned.mock.calls.map(([f]) => ({ pack: f.pack, recordId: f.recordId, label: f.label, kind: f.kind, source: f.source }));

describe("a thread we resolved and someone reopened", () => {
  it("was settled wrongly: addressed (or reply_holds) was not a yes", async () => {
    await kept();
    await learnFromRereview({ stateDir, truth }, "t1", { open: new Set(["T1", "T2"]), fixed: new Set() });
    expect(labelled()).toEqual([
      { pack: "thread_settle", recordId: "rec-fixed", label: { addressed: { value: false } }, kind: "outcome", source: "thread_reopened" },
      { pack: "thread_settle", recordId: "rec-holds", label: { reply_holds: { value: false } }, kind: "outcome", source: "thread_reopened" },
    ]);
  });

  it("is labelled once: the next re-review has nothing left to say about it", async () => {
    await kept();
    await learnFromRereview({ stateDir, truth }, "t1", { open: new Set(["T1"]), fixed: new Set() });
    await learnFromRereview({ stateDir, truth }, "t1", { open: new Set(["T1"]), fixed: new Set() });
    expect(truth.learned).toHaveBeenCalledTimes(1);
  });
});

describe("an acknowledgement a later commit addressed", () => {
  it("confirms comment_intent's read of the reply", async () => {
    await kept();
    await learnFromRereview({ stateDir, truth }, "t1", { open: new Set(["T3"]), fixed: new Set(["T3"]) });
    expect(labelled()).toEqual([{ pack: "comment_intent", recordId: "rec-ack", label: { intent: { choice: "acknowledgement" } }, kind: "outcome", source: "thread_fixed_after_ack" }]);
  });

  it("says nothing while the thread is still open and unfixed", async () => {
    await kept();
    await learnFromRereview({ stateDir, truth }, "t1", { open: new Set(["T3"]), fixed: new Set() });
    expect(truth.learned).not.toHaveBeenCalled();
  });
});

describe("the PR merged", () => {
  const github = (open: string[] | null) => ({ prThreads: vi.fn(async () => (open === null ? Promise.reject(new Error("down")) : open.map((id) => ({ id })))) }) as never;

  it("confirms the threads still resolved, and contradicts one open at the merge", async () => {
    await kept();
    await learnAtMerge({ stateDir, truth, github: github(["T2"]) }, "t1", "o/a", 12);
    expect(labelled()).toEqual([
      { pack: "thread_settle", recordId: "rec-fixed", label: { addressed: { value: true } }, kind: "outcome", source: "pr_merged" },
      { pack: "thread_settle", recordId: "rec-holds", label: { reply_holds: { value: false } }, kind: "outcome", source: "thread_reopened" },
    ]);
  });

  it("labels nothing when the threads cannot be read, and keeps the memory for a later try", async () => {
    await kept();
    await learnAtMerge({ stateDir, truth, github: github(null) }, "t1", "o/a", 12);
    expect(truth.learned).not.toHaveBeenCalled();
    await learnAtMerge({ stateDir, truth, github: github([]) }, "t1", "o/a", 12);
    expect(truth.learned).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a card that kept no threads", async () => {
    await learnAtMerge({ stateDir, truth, github: github([]) }, "t9", "o/a", 12);
    expect(truth.learned).not.toHaveBeenCalled();
  });
});
