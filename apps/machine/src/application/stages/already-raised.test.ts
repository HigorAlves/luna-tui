import type { Finding } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { dropAlreadyRaised } from "./already-raised.ts";
import type { Decide } from "./check-decide.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({ path: "a.ts", line: 10, severity: "bug", title: "Null deref", body: "x may be null", confidence: 0.9, id: "f1", ...over });
const comment = (over: Partial<{ path: string | null; line: number | null; author: string; body: string }> = {}) => ({ path: "a.ts", line: 11, author: "coderabbit", body: "x can be null here", ...over });
const same = (value: boolean, p: number) => ({ same: { value, p } });
const deps = (decide: Decide | null, me: string | null = "luna") => ({ decide, repoPath: "/r", decisions: {}, me });

describe("dropAlreadyRaised", () => {
  it("drops a finding a confident yes says another comment on the same file already made, and names who made it", async () => {
    const asked: unknown[] = [];
    const decide: Decide = async (pack, check) => (asked.push({ pack, check }), same(true, 0.95));
    const f = finding();
    const out = await dropAlreadyRaised(deps(decide), [f], [comment()]);
    expect(out.kept).toEqual([]);
    expect(out.dropped).toEqual([{ id: "f1", title: "Null deref", path: "a.ts", line: 10, by: "coderabbit" }]);
    expect(asked).toEqual([{ pack: "already_raised", check: { kind: "finding", finding: f, existing: { author: "coderabbit", path: "a.ts", line: 11, body: "x can be null here" } } }]);
  });

  it("keeps a finding on a no, a middling answer, a failed or absent decision", async () => {
    for (const decide of [async () => same(false, 0.02), async () => same(true, 0.6), async () => { throw new Error("no key"); }, null]) {
      const out = await dropAlreadyRaised(deps(decide as Decide | null), [finding()], [comment()]);
      expect(out.kept).toHaveLength(1);
      expect(out.dropped).toEqual([]);
    }
  });

  it("compares only with comments by others on the same file near the line, never our own", async () => {
    const seen: string[] = [];
    const decide: Decide = async (_p, check) => (seen.push((check as { existing: { body: string } }).existing.body), same(false, 0.01));
    await dropAlreadyRaised(
      deps(decide),
      [finding()],
      [comment({ body: "near" }), comment({ path: "b.ts", body: "other file" }), comment({ line: 400, body: "far" }), comment({ author: "luna", body: "ours" }), comment({ line: null, path: "a.ts", body: "file level" }), comment({ path: null, body: "pr level" })],
    );
    expect(seen).toEqual(["near", "file level"]);
  });

  it("asks nothing when no comment is a candidate, and stops at the first yes", async () => {
    let calls = 0;
    const decide: Decide = async () => (calls++, same(true, 0.99));
    await dropAlreadyRaised(deps(decide), [finding()], []);
    expect(calls).toBe(0);
    await dropAlreadyRaised(deps(decide), [finding()], [comment({ body: "1" }), comment({ body: "2" })]);
    expect(calls).toBe(1);
  });
});
