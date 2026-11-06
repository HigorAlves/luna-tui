import { MESSAGE_CAPS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { RawMessage } from "../application/slack.ts";
import { applyEdit, canonicalMessageOf, emptyConversation, foldMessage, latestText } from "./conversation.ts";

const raw = (over: Partial<RawMessage> = {}): RawMessage => ({ ts: "1700000100.000200", user: "U2", botId: null, text: "hi", subtype: null, threadTs: "1700000000.000100", replyCount: 0, latestReply: null, ...over });
const ctx = {
  channel: { id: "C1", name: "eng", kind: "channel" as const },
  author: { id: "U2", name: "marta", isBot: false },
  permalink: "https://x.slack.com/archives/C1/p1700000100000200",
};

describe("canonicalMessageOf", () => {
  it("builds the ids from the channel, the ts and the root ts", () => {
    const m = canonicalMessageOf(raw(), ctx);
    expect(m.id).toBe("C1:1700000100.000200");
    expect(m.threadId).toBe("C1:1700000000.000100");
    expect(m.platform).toBe("slack");
    expect(m.editedAt).toBeNull();
    expect(m.deleted).toBe(false);
  });

  it("is its own root when it has no thread", () => {
    expect(canonicalMessageOf(raw({ threadTs: null }), ctx).threadId).toBe("C1:1700000100.000200");
  });

  it("screens and caps the text and lists the mentioned user ids", () => {
    const token = ["xox", "b-", "1234567890-abcdef"].join("");
    const m = canonicalMessageOf(raw({ text: `<@U1> look ${token} ${"y".repeat(5000)}<@U3>` }), ctx);
    expect(m.text).not.toContain(token);
    expect(m.text).toContain("[redacted]");
    expect(m.text.length).toBeLessThanOrEqual(MESSAGE_CAPS.text);
    expect(m.mentions).toEqual(["U1", "U3"]);
  });

  it("keeps a file as a reference and the edit time as ISO", () => {
    const m = canonicalMessageOf(raw({ subtype: "file_share", files: [{ id: "F1", name: "trace.log", kind: "text" }], editedTs: "1700000200.000000" }), ctx);
    expect(m.attachments).toEqual([{ id: "F1", name: "trace.log", kind: "text" }]);
    expect(m.editedAt).toBe(new Date(1700000200 * 1000).toISOString());
  });

  it("bounds the attachments", () => {
    const files = Array.from({ length: 14 }, (_, i) => ({ id: `F${i}`, name: "a", kind: "png" }));
    expect(canonicalMessageOf(raw({ files }), ctx).attachments).toHaveLength(MESSAGE_CAPS.attachments);
  });
});

describe("the conversation object", () => {
  const msg = (n: number, text = `m${n}`) => canonicalMessageOf(raw({ ts: `1700000${String(n).padStart(3, "0")}.000000`, text }), ctx);

  it("starts private for anything but a public channel", () => {
    expect(emptyConversation({ kind: "channel" }).private).toBe(false);
    for (const kind of ["group", "dm", "mpim"] as const) expect(emptyConversation({ kind }).private).toBe(true);
  });

  it("folds a message once, in ts order, and keeps the last twenty", () => {
    let c = emptyConversation({ kind: "channel" });
    c = foldMessage(c, msg(2), { secrets: 1, pii: ["email"] });
    c = foldMessage(c, msg(1));
    expect(c.history.map((m) => m.text)).toEqual(["m1", "m2"]);
    const again = foldMessage(c, msg(2), { secrets: 1, pii: ["email"] });
    expect(again).toBe(c);
    expect(c.redactions).toBe(1);
    expect(c.pii).toEqual(["email"]);
    expect(c.participants).toEqual([{ id: "U2", name: "marta", isBot: false }]);
    for (let n = 3; n <= 30; n++) c = foldMessage(c, msg(n));
    expect(c.history).toHaveLength(MESSAGE_CAPS.history);
    expect(c.history[0]!.text).toBe("m11");
  });

  it("applies an edit and a deletion to the message they name only", () => {
    let c = foldMessage(foldMessage(emptyConversation({ kind: "channel" }), msg(1)), msg(2));
    const edited = applyEdit(c, { id: msg(1).id, text: "new", editedAt: "2026-10-28T00:00:00.000Z" });
    expect(edited.history[0]).toMatchObject({ text: "new", editedAt: "2026-10-28T00:00:00.000Z", deleted: false });
    expect(edited.history[1]!.text).toBe("m2");
    const gone = applyEdit(edited, { id: msg(2).id, deleted: true, editedAt: "2026-10-28T00:01:00.000Z" });
    expect(gone.history[1]).toMatchObject({ text: "", deleted: true });
    expect(latestText(gone)).toBe("new");
    expect(applyEdit(c, { id: "C1:9.9", text: "x", editedAt: "2026-10-28T00:00:00.000Z" })).toBe(c);
  });
});
