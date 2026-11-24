import { describe, expect, it } from "vitest";

import { conversationRow } from "../test/conversation-row.ts";
import { candidateOf } from "./conversation-candidate.ts";

describe("candidateOf", () => {
  it("takes the first line as the title, at most 300 characters, and quotes the thread as the text", () => {
    const out = candidateOf(conversationRow({ text: `${"x".repeat(400)}\nsecond line` }));
    expect(out.title).toHaveLength(300);
    expect(out.text).toContain("> marta: ");
    expect(out.text).not.toContain("\nsecond line");
    expect(out.text).toContain("second line");
  });
  it("masks e-mail addresses and phone numbers, and keeps the text to 4000 characters", () => {
    const out = candidateOf(conversationRow({ text: `write to ana@corp.example or +1 415 555 0100 ${"y ".repeat(3000)}` }));
    expect(out.text).not.toContain("ana@corp.example");
    expect(out.text).not.toContain("555 0100");
    expect(out.text.length).toBeLessThanOrEqual(4000);
  });
  it("holds no thread text for a private conversation: a fixed line and the permalink", () => {
    for (const kind of ["group", "dm", "mpim"] as const) {
      const out = candidateOf(conversationRow({ text: "the secret plan is banana", kind }));
      expect(out.title).toBe("A private Slack conversation");
      expect(out.text).toBe("A private Slack conversation: open it in Slack. https://x.slack.com/p1");
    }
  });
});
