import { describe, expect, it } from "vitest";

import { CONTEXT_MAX_BYTES, recordContext } from "./record-context.ts";

// A token-shaped string built at runtime: GitHub's push protection reads source files.
const token = ["gh", "p_"].join("") + "a".repeat(36);

describe("recordContext", () => {
  it("leaves a context with nothing to hide as it was, and counts none", () => {
    const context = { ship: { kind: "retro", runs: 14, note: "all green" } };
    expect(recordContext(context, { secrets: {}, private: false })).toEqual({ context, redacted: 0 });
  });

  it("replaces a token shape and a run's own secret value with the redactor's marker, and counts the strings changed", () => {
    const out = recordContext({ log: { tail: `push failed with ${token}`, other: "the value hunter2-hunter2 leaked", fine: "nothing here" }, list: [`again ${token}`] }, { secrets: { DB_PASSWORD: "hunter2-hunter2" }, private: false });
    expect(out.context).toEqual({ log: { tail: "push failed with [redacted]", other: "the value [secret:DB_PASSWORD] leaked", fine: "nothing here" }, list: ["again [redacted]"] });
    expect(out.redacted).toBe(3);
  });

  it("redacts a secret in a key name too", () => {
    const out = recordContext({ [`k-${token}`]: 1 }, { secrets: {}, private: false });
    expect(Object.keys(out.context)).toEqual(["k-[redacted]"]);
    expect(out.redacted).toBe(1);
  });

  it("keeps ids, enum values, counts and dates of a private conversation and removes its text", () => {
    const conversation = { channel: "C01ABC2DEF", private: true, id: "1700000000.0001", kind: "question", count: 3, at: "2026-11-05T09:00:00.000Z", latest: "fire Bob on friday", thread: ["marta: the plan is banana", "ok"], candidates: [{ id: "c1", title: "A very long title that is more than forty characters long, truly" }] };
    const out = recordContext({ conversation, other: { text: "outside the conversation stays as it is" } }, { secrets: {}, private: true });
    expect(out.context).toEqual({
      conversation: { channel: "C01ABC2DEF", private: true, id: "1700000000.0001", kind: "question", count: 3, at: "2026-11-05T09:00:00.000Z", latest: "[private]", thread: ["[private]", "[private]"], candidates: [{ id: "c1", title: "[private]" }] },
      other: { text: "outside the conversation stays as it is" },
    });
  });

  it("does not touch a conversation that is not private, and reads the flag from the conversation itself when the caller does not say", () => {
    const conversation = { private: false, latest: "a message with spaces" };
    expect(recordContext({ conversation }, { secrets: {}, private: false }).context).toEqual({ conversation });
    expect(recordContext({ conversation: { private: true, latest: "a message with spaces" } }, { secrets: {} }).context).toEqual({ conversation: { private: true, latest: "[private]" } });
  });

  it("replaces a short private message with no space, and a private channel's name, keeping the channel only as an id", () => {
    const named = recordContext({ conversation: { channel: "layoffs", private: true, latest: "fired", thread: ["bob:x", "ok"], author: { profile: "member", title: "CFO" }, candidates: [{ slot: 1, kind: "open", title: "Hi", summary: "x" }] } }, { secrets: {} });
    expect(named.context).toEqual({ conversation: { channel: "[private]", private: true, latest: "[private]", thread: ["[private]", "[private]"], author: { profile: "member", title: "[private]" }, candidates: [{ slot: 1, kind: "open", title: "[private]", summary: "[private]" }] } });
    const byId = recordContext({ conversation: { channel: "G01ABC2DEF", private: true, latest: "no" } }, { secrets: {} });
    expect(byId.context).toEqual({ conversation: { channel: "G01ABC2DEF", private: true, latest: "[private]" } });
  });

  it("bounds one call's stored context: a very long string is cut with a marker, each cut counts as a redaction, the rest stays", () => {
    const context = { log: { tail: "x".repeat(300_000), other: "small" }, ids: ["a", "b"] };
    const out = recordContext(context, { secrets: {}, private: false });
    const flat = JSON.stringify(out.context);
    expect(flat.length).toBeLessThan(120_000);
    expect(out.context).toMatchObject({ log: { other: "small" }, ids: ["a", "b"] });
    expect((out.context.log as { tail: string }).tail).toContain("[… cut]");
    expect(out.redacted).toBe(1);
  });

  it("bounds a context made of many medium strings: the whole stays under the cap, and says it was cut", () => {
    const context = { items: Array.from({ length: 400 }, (_, i) => `${i}:` + "y".repeat(5_000)) };
    const out = recordContext(context, { secrets: {}, private: false });
    expect(JSON.stringify(out.context).length).toBeLessThanOrEqual(CONTEXT_MAX_BYTES);
    expect(out.redacted).toBeGreaterThan(0);
  });
});
