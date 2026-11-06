import { describe, expect, it } from "vitest";

import { diffSummaryOf } from "./diff-summary.ts";

const facts = { changed: ["web/cart.tsx", "web/cart.test.ts", "src/extra.ts"], newDependencies: ["left-pad"], todos: ["web/cart.tsx: TODO later"], mapFiles: ["web/cart.tsx", "web/cart.test.ts"] };

describe("diffSummaryOf", () => {
  it("takes the agent's words and fills what git knows: in_code_map, deps_added and todos win over the agent's own", () => {
    const summary = diffSummaryOf({ what: "Adds CSV export", why: "C1", files: [{ path: "web/cart.tsx", reason: "the button", in_code_map: false }], deps_added: ["nothing"], todos: [] } as never, facts);
    expect(summary).toMatchObject({ what: "Adds CSV export", why: "C1", deps_added: ["left-pad"], todos: ["web/cart.tsx: TODO later"] });
    expect(summary.files.find((f) => f.path === "web/cart.tsx")).toEqual({ path: "web/cart.tsx", reason: "the button", in_code_map: true });
  });

  it("adds a file in the diff that the summary does not list, with no reason and git's in_code_map", () => {
    const summary = diffSummaryOf({ what: "w", files: [{ path: "web/cart.tsx", reason: "r" }] }, facts);
    expect(summary.files).toEqual([
      { path: "web/cart.tsx", reason: "r", in_code_map: true },
      { path: "web/cart.test.ts", reason: null, in_code_map: true },
      { path: "src/extra.ts", reason: null, in_code_map: false },
    ]);
  });

  it("drops a listed file the diff does not have and any path that is not a plain repository path", () => {
    const summary = diffSummaryOf({ what: "w", files: [{ path: "not/changed.ts", reason: "r" }, { path: "../etc/passwd", reason: "r" }, { path: "/abs.ts", reason: "r" }] }, facts);
    expect(summary.files.map((f) => f.path)).toEqual(["web/cart.tsx", "web/cart.test.ts", "src/extra.ts"]);
  });

  it("flattens every text field and caps it at 300 characters, the files at 50, a list at 10", () => {
    const long = `line one\n\nline two ${"x".repeat(1000)}`;
    const many = Array.from({ length: 60 }, (_, i) => `f${i}.ts`);
    const summary = diffSummaryOf({ what: long, why: long, files: [{ path: "web/cart.tsx", reason: long }], risks_noticed: Array.from({ length: 20 }, () => long), flags_added: [long], migrations: [long] }, { ...facts, changed: ["web/cart.tsx", ...many], mapFiles: [] });
    for (const text of [summary.what, summary.why, summary.files[0]!.reason!, summary.risks_noticed[0]!, summary.flags_added[0]!, summary.migrations[0]!]) {
      expect(text.length).toBeLessThanOrEqual(300);
      expect(text).not.toContain("\n");
    }
    expect(summary.files).toHaveLength(50);
    expect(summary.risks_noticed).toHaveLength(10);
  });

  it("reads a plain string answer as `what`, and no answer as an empty summary with git's facts", () => {
    expect(diffSummaryOf("Adds CSV export", facts).what).toBe("Adds CSV export");
    const none = diffSummaryOf(undefined, facts);
    expect(none).toMatchObject({ what: "", why: "", deps_added: ["left-pad"] });
    expect(none.files).toHaveLength(3);
  });

  it("puts the prose through safe(): a token is redacted and a mention or a tag is defused", () => {
    const token = ["ghp", "c".repeat(36)].join("_");
    const summary = diffSummaryOf({ what: `uses ${token} and pings @someone <b>x</b>`, why: "Closes #12", files: [{ path: "web/cart.tsx", reason: `reason ${token}` }], risks_noticed: [`risk ${token}`] }, facts);
    const text = JSON.stringify(summary);
    expect(text).not.toContain(token);
    expect(summary.what).not.toContain("<b>");
    expect(summary.what).not.toMatch(/@someone/);
    expect(summary.why).not.toContain("#12");
  });
});
