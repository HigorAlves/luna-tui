import { describe, expect, it } from "vitest";

import { ConversationDrafts, MemoryDraftStore } from "./conversation-drafts.ts";

let clock = new Date("2026-10-28T12:00:00Z");
const make = () => new ConversationDrafts(new MemoryDraftStore(), { expiryHours: () => 24, now: () => clock });
const input = (over: Record<string, unknown> = {}) => ({ thread: "C1:1.1", channel: "C1", threadTs: "1.1", kind: "reply" as const, text: "It is queued.", cardId: null, private: false, records: {}, ...over });

describe("ConversationDrafts", () => {
  it("keeps one waiting draft per thread: a new one marks the old superseded", async () => {
    const drafts = make();
    const a = await drafts.open(input());
    const b = await drafts.open(input({ text: "Newer." }));
    expect((await drafts.waiting("C1:1.1"))?.id).toBe(b.id);
    expect((await drafts.get(a.id))?.status).toBe("superseded");
  });
  it("expires a waiting draft past its creation plus the configured hours, and posts nothing", async () => {
    clock = new Date("2026-10-28T12:00:00Z");
    const drafts = make();
    const a = await drafts.open(input());
    clock = new Date("2026-10-29T11:59:00Z");
    expect(await drafts.expire(clock)).toEqual([]);
    clock = new Date("2026-10-29T12:01:00Z");
    expect((await drafts.expire(clock)).map((d) => d.id)).toEqual([a.id]);
    expect((await drafts.get(a.id))?.status).toBe("expired");
    expect(await drafts.waiting("C1:1.1")).toBeNull();
  });
  it("settles a waiting draft: the same text is sent, another is edited with the machine's text kept", async () => {
    const drafts = make();
    await drafts.open(input());
    expect(await drafts.settle("C1:1.1", "It is queued.")).toMatchObject({ outcome: "sent_as_drafted", draft: { status: "sent" } });
    await drafts.open(input());
    const edited = await drafts.settle("C1:1.1", "We are on it.");
    expect(edited).toMatchObject({ outcome: "edited", draft: { status: "edited", text: "We are on it.", original: "It is queued." } });
    expect(await drafts.settle("C1:1.1", "x")).toBeNull();
  });
  it("ignores a waiting draft", async () => {
    const drafts = make();
    const a = await drafts.open(input());
    expect((await drafts.ignore("C1:1.1"))?.id).toBe(a.id);
    expect((await drafts.get(a.id))?.status).toBe("ignored");
    expect(await drafts.ignore("C1:1.1")).toBeNull();
  });
  it("supersedes a waiting draft when the thread moves", async () => {
    const drafts = make();
    const a = await drafts.open(input());
    await drafts.supersede("C1:1.1");
    expect((await drafts.get(a.id))?.status).toBe("superseded");
  });
  it("gives the last five edits of the same channel, never another channel's, and never a private one for a public thread", async () => {
    const drafts = make();
    const edit = async (over: Record<string, unknown>, n: number) => {
      await drafts.open(input({ thread: `${over.channel ?? "C1"}:${n}.0`, threadTs: `${n}.0`, ...over }));
      await drafts.settle(`${over.channel ?? "C1"}:${n}.0`, `person ${n}`);
    };
    for (let n = 1; n <= 7; n++) await edit({}, n);
    await edit({ channel: "C2" }, 20);
    await edit({ private: true }, 30);
    const tone = await drafts.recentEdits("C1", false);
    expect(tone).toHaveLength(5);
    expect(tone.map((t) => t.person)).toEqual(["person 7", "person 6", "person 5", "person 4", "person 3"]);
    expect((await drafts.recentEdits("C2", false)).map((t) => t.person)).toEqual(["person 20"]);
    expect((await drafts.recentEdits("C1", true)).map((t) => t.person)).toEqual(["person 30"]);
  });
});
