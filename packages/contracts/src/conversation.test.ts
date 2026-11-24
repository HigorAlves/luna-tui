import { describe, expect, it } from "vitest";

import { CanonicalMessage, MESSAGE_CAPS } from "./conversation.ts";

const base = {
  id: "C1:1700000000.000100",
  threadId: "C1:1700000000.000100",
  platform: "slack",
  channel: { id: "C1", name: "eng", kind: "channel" },
  author: { id: "U2", name: "marta", isBot: false },
  text: "hello",
  attachments: [],
  mentions: [],
  permalink: "https://x.slack.com/archives/C1/p1700000000000100",
  ts: "1700000000.000100",
  editedAt: null,
  deleted: false,
};

describe("CanonicalMessage", () => {
  it("reads a well-formed message", () => {
    expect(CanonicalMessage.parse(base).threadId).toBe("C1:1700000000.000100");
  });
  it("bounds the text and every list", () => {
    expect(MESSAGE_CAPS).toEqual({ text: 4000, attachments: 10, mentions: 20, history: 20, participants: 30 });
    expect(CanonicalMessage.safeParse({ ...base, text: "x".repeat(4001) }).success).toBe(false);
    expect(CanonicalMessage.safeParse({ ...base, mentions: Array.from({ length: 21 }, (_, i) => `U${i}`) }).success).toBe(false);
    expect(CanonicalMessage.safeParse({ ...base, attachments: Array.from({ length: 11 }, (_, i) => ({ id: `F${i}`, name: "a", kind: "png" })) }).success).toBe(false);
  });
  it("keeps an attachment as a reference only", () => {
    const parsed = CanonicalMessage.parse({ ...base, attachments: [{ id: "F1", name: "trace.log", kind: "text", url: "https://files.slack.com/x" }] });
    expect(parsed.attachments[0]).toEqual({ id: "F1", name: "trace.log", kind: "text" });
  });
});
