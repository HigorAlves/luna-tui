import { describe, expect, it } from "vitest";

import { CONTEXT_MIN_WORDS, contextComplete } from "./context-complete.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const card = (over: Record<string, unknown> = {}) => ({ repoPath: "/r", title: "", description: words(CONTEXT_MIN_WORDS), reporter: null, attachments: 0, ...over });

describe("the context-complete check", () => {
  it("is complete with a repository and twenty words, and no reporter", () => {
    expect(contextComplete(card())).toEqual({ complete: true, missing: [] });
  });
  it("counts the title and the description together", () => {
    expect(contextComplete(card({ title: words(5), description: words(CONTEXT_MIN_WORDS - 5) })).complete).toBe(true);
    expect(contextComplete(card({ description: words(CONTEXT_MIN_WORDS - 1) }))).toEqual({ complete: false, missing: ["text"] });
  });
  it("takes an attachment in place of the words", () => {
    expect(contextComplete(card({ description: "broken", attachments: 1 })).complete).toBe(true);
  });
  it("names a missing repository", () => {
    expect(contextComplete(card({ repoPath: null }))).toEqual({ complete: false, missing: ["repository"] });
  });
  it("wants a reporter that can be reached: one with a channel, or none", () => {
    expect(contextComplete(card({ reporter: { id: "U1" } }))).toEqual({ complete: false, missing: ["reporter"] });
    expect(contextComplete(card({ reporter: { id: "U1", channel: "slack" } })).complete).toBe(true);
  });
  it("lists everything absent, in a fixed order", () => {
    expect(contextComplete(card({ repoPath: null, description: "", reporter: { id: "U1" } })).missing).toEqual(["repository", "reporter", "text"]);
  });
});
