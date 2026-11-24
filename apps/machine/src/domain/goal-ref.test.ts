import { describe, expect, it } from "vitest";

import { goalRefOf } from "./goal-ref.ts";

describe("goalRefOf", () => {
  it("takes a Jira epic link first", () => {
    expect(goalRefOf({ text: "part of EPIC-9", epicKey: "HAR-100" })).toBe("HAR-100");
  });
  it("finds an epic or OKR id in the text by pattern", () => {
    expect(goalRefOf({ text: "Serves OKR-Q3 and more" })).toBe("OKR-Q3");
    expect(goalRefOf({ text: "see EPIC-42 for context" })).toBe("EPIC-42");
    expect(goalRefOf({ text: "KR-2026-Q3-1 depends on this" })).toBe("KR-2026-Q3-1");
  });
  it("is none otherwise, and ignores an epic link that is not a Jira key", () => {
    expect(goalRefOf({ text: "fix the thing, an epic-level change" })).toBe("none");
    expect(goalRefOf({ text: "fix", epicKey: "not a key; drop table" })).toBe("none");
    expect(goalRefOf({ text: `${"x".repeat(30_000)} EPIC-1` })).toBe("none");
  });
});
