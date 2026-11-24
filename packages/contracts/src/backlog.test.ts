import { describe, expect, it } from "vitest";

import { BacklogAddInput } from "./backlog.ts";

const ok = { title: "Retry the webhook", text: "It drops on 502.", scores: { who: 2, what: 2, impact: 3, time: 2, demand: 1 }, size: "S" };

describe("a backlog item as it is added", () => {
  it("takes a title, text, five sub-scores from 1 to 3 and a size, with defaults for the rest", () => {
    const parsed = BacklogAddInput.parse(ok);
    expect(parsed).toMatchObject({ ...ok, sources: [], dependsOn: [], repo: null });
  });
  it("bounds every string, list and score", () => {
    const bad = (over: Record<string, unknown>) => BacklogAddInput.safeParse({ ...ok, ...over }).success;
    expect(bad({ title: "" })).toBe(false);
    expect(bad({ title: "x".repeat(301) })).toBe(false);
    expect(bad({ text: "x".repeat(4001) })).toBe(false);
    expect(bad({ size: "XXL" })).toBe(false);
    expect(bad({ scores: { ...ok.scores, who: 4 } })).toBe(false);
    expect(bad({ scores: { ...ok.scores, who: 0 } })).toBe(false);
    expect(bad({ sources: Array.from({ length: 21 }, () => ({ type: "slack" })) })).toBe(false);
    expect(bad({ dependsOn: Array.from({ length: 21 }, () => "00000000-0000-0000-0000-000000000000") })).toBe(false);
    expect(bad({ dependsOn: ["not-a-uuid"] })).toBe(false);
  });
});
