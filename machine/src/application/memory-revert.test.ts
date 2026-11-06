import { describe, expect, it } from "vitest";

import { fakeMemory } from "../test/memory.ts";
import { MemoryReverts, prOfUrl } from "./memory-revert.ts";

const draft = (card: string | null, text: string) => ({
  kind: "outcome" as const,
  repo: "app-1",
  source: { kind: "github" as const, ref: null },
  anchors: { files: ["a.ts"], commit: "abc1234" },
  provenance: { by: "machine" as const, card, run: null, pack: null },
  trust: "fact" as const,
  text,
});

const shipped = (number: number, mergedSha = "feedbeef00") => ({ title: "Revert it", prUrl: `https://github.com/Acme/App/pull/${number}`, number, mergedSha, by: "person", format: null, howToVerify: null, media: [] });

async function world(pr: { title: string; body: string | null } | null) {
  const memory = fakeMemory();
  await memory.write([draft("card-a", "a1 uploader retries"), draft("card-a", "a2 timeout"), draft("card-b", "b1 other card"), draft(null, "no card")]);
  const calls: unknown[] = [];
  const reverts = new MemoryReverts({
    memory,
    pr: async (repo, number) => (calls.push({ repo, number }), pr),
    cardMergedAs: async (target) => ("sha" in target ? (target.sha === "0123abc" ? "card-b" : null) : target.repo === "acme/app" && target.number === 10 ? "card-a" : null),
  });
  return { memory, reverts, calls };
}

const statusOf = (memory: Awaited<ReturnType<typeof world>>["memory"], text: string) => memory.items.find((i) => i.text.startsWith(text))!.status;

describe("MemoryReverts", () => {
  it("retires the items of the card whose PR the merged PR reverts", async () => {
    const { memory, reverts, calls } = await world({ title: 'Revert "Add retries"', body: "Reverts Acme/App#10" });
    expect(await reverts.handle({ kind: "ship.merged", taskId: "card-r", payload: shipped(12) })).toBe(2);
    expect(calls).toEqual([{ repo: "acme/app", number: 12 }]);
    expect(statusOf(memory, "a1")).toBe("retired");
    expect(statusOf(memory, "a2")).toBe("retired");
    expect(statusOf(memory, "b1")).toBe("active");
    expect(statusOf(memory, "no card")).toBe("active");
  });

  it("takes a bare #n as the merged PR's own repository, and a commit sha too", async () => {
    const { memory, reverts } = await world({ title: "Revert", body: "Reverts #10\n\nThis reverts commit 0123abc." });
    expect(await reverts.handle({ kind: "ship.merged", taskId: "card-r", payload: shipped(12) })).toBe(3);
    expect(statusOf(memory, "b1")).toBe("retired");
  });

  it("is idempotent: a replayed event retires nothing twice", async () => {
    const { reverts } = await world({ title: "Revert", body: "Reverts #10" });
    expect(await reverts.handle({ kind: "ship.merged", taskId: "card-r", payload: shipped(12) })).toBe(2);
    expect(await reverts.handle({ kind: "ship.merged", taskId: "card-r", payload: shipped(12) })).toBe(0);
  });

  it("changes nothing for a PR that reverts nothing, a card nobody merged, itself, other events or no PR text", async () => {
    for (const pr of [{ title: 'Revert "x"', body: null }, { title: "Fix", body: "Reverts #99" }, null]) {
      const { memory, reverts } = await world(pr);
      expect(await reverts.handle({ kind: "ship.merged", taskId: "card-r", payload: shipped(12) })).toBe(0);
      expect(memory.items.every((i) => i.status === "active")).toBe(true);
    }
    const self = await world({ title: "Revert", body: "Reverts #10" });
    expect(await self.reverts.handle({ kind: "ship.merged", taskId: "card-a", payload: shipped(12) })).toBe(0);
    expect(await self.reverts.handle({ kind: "transition", taskId: "card-r", payload: shipped(12) })).toBe(0);
    expect(self.calls).toEqual([{ repo: "acme/app", number: 12 }]);
  });

  it("does nothing with memory off, an event that is not a merge, or a failing GitHub", async () => {
    const off = new MemoryReverts({ memory: { ...fakeMemory(), enabled: false }, pr: async () => Promise.reject(new Error("never asked")), cardMergedAs: async () => null });
    expect(await off.handle({ kind: "ship.merged", taskId: "c", payload: shipped(1) })).toBe(0);
    const broken = new MemoryReverts({ memory: fakeMemory(), pr: async () => Promise.reject(new Error("rate limited")), cardMergedAs: async () => null });
    const quiet = console.warn;
    console.warn = () => {};
    try {
      expect(await broken.handle({ kind: "ship.merged", taskId: "c", payload: shipped(1) })).toBe(0);
      expect(await broken.handle({ kind: "ship.merged", taskId: "c", payload: { nope: true } })).toBe(0);
    } finally {
      console.warn = quiet;
    }
  });

  it("finds the PR in its address", () => {
    expect(prOfUrl("https://github.com/Acme/App/pull/7")).toEqual({ repo: "acme/app", number: 7 });
    expect(prOfUrl("https://example.com/x/y/pull/7")).toBeNull();
  });
});
