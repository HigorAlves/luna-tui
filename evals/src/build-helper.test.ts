import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { type BuildTrial, type LoadedBuildCase, caseReport, loadBuildCases, renderDry, renderReport, trialReport, untilInterrupted } from "./build-helper.ts";

const EVALS = resolve(import.meta.dirname, "..");
const cases = loadBuildCases(EVALS);
const c = cases[0] as LoadedBuildCase;

const trial = (over: Partial<BuildTrial> = {}): BuildTrial => ({
  delegation: "on",
  outcome: "pass",
  wallMs: 6 * 60_000,
  changed: ["src/cart/total.ts", "test/cart/total.test.ts", "src/ui/ProductCard.ts"],
  rows: [
    { kind: "build.helper_started", payload: { slice: 2 } },
    { kind: "build.helper_ended", payload: { slice: 2, outcome: "pass" } },
    { kind: "build.helper_picked", payload: { slice: 2 } },
  ],
  ...over,
});

describe("the build-helper cases", () => {
  it("has three cards, each a logic slice and the UI slice of a ui_design case, with its spec and its replayed servers", () => {
    expect(cases.map((x) => x.id)).toEqual(["card-with-discount", "field-rounds-total", "panel-skips-empty-lines"]);
    for (const x of cases) {
      expect(x.slices).toHaveLength(2);
      expect(x.slices[0]!.touchpoints).toContain("src/cart/total.ts");
      expect(x.slices[1]!.touchpoints[0]).toMatch(/^src\/ui\//);
      expect(x.spec.frames.length, x.id).toBeGreaterThan(0);
      expect(x.mcpDir).toContain(`ui_design/cases/${x.uiCase}/mcp`);
      expect(x.repoPath).toBe("fixtures/golden-ui");
      expect(x.testsFiles, x.id).toHaveLength(1);
    }
  });

  it("names the one that is asked for, and refuses one that is not there", () => {
    expect(loadBuildCases(EVALS, ["field-rounds-total"]).map((x) => x.id)).toEqual(["field-rounds-total"]);
    expect(() => loadBuildCases(EVALS, ["nope"])).toThrow("no build-helper case named nope");
  });

  it("lists what would run without running it", () => {
    const text = renderDry(cases, true);
    expect(text).toContain("3 build-helper cases");
    expect(text).toContain("nothing runs");
    expect(text).toContain("with delegation off");
  });
});

describe("the report of a run", () => {
  it("passes when both slices are on the branch, in scope, the helper was picked and nothing conflicted", () => {
    const r = caseReport(c, trial(), trial({ delegation: "off", wallMs: 10 * 60_000, rows: [], changed: ["src/cart/total.ts", "src/ui/ProductCard.ts"] }));
    expect(r.pass).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.delegated).toMatchObject({ committed: { logic: true, ui: true }, scopeClean: true, picks: 1, conflicts: 0, delegated: true });
    expect(r.ratio).toBe(0.6);
  });

  it("fails a UI slice that never landed", () => {
    const r = caseReport(c, trial({ changed: ["src/cart/total.ts", "test/cart/total.test.ts"] }), null);
    expect(r.pass).toBe(false);
    expect(r.problems).toContain("the UI slice is not on the branch");
    expect(r.ratio).toBeNull();
  });

  it("fails a file outside the plan, but not the card's own scenario test", () => {
    const stray = trialReport(c, trial({ changed: [...trial().changed, "package.json"] }));
    expect(stray).toMatchObject({ scopeClean: false, strays: ["package.json"] });
    expect(trialReport(c, trial({ changed: [...trial().changed, c.testsFiles[0]!] })).scopeClean).toBe(true);
  });

  it("fails a pick conflict, and a run where the implementer never delegated", () => {
    const conflicted = caseReport(c, trial({ rows: [...trial().rows, { kind: "build.helper_conflict", payload: { slice: 2, attempt: 1 } }] }), null);
    expect(conflicted.problems).toContain("1 pick conflict");
    const alone = caseReport(c, trial({ rows: [] }), null);
    expect(alone.problems).toContain("the implementer never delegated the UI slice");
  });

  it("fails an escalated run and names the reason", () => {
    const r = caseReport(c, trial({ outcome: "escalated", escalation: "merge_conflict" }), null);
    expect(r.problems[0]).toBe("the run ended escalated (merge_conflict)");
  });

  it("fails a baseline that delegated, since delegation was meant to be off", () => {
    expect(caseReport(c, trial(), trial({ delegation: "off" })).problems).toContain("the baseline run delegated: delegation was not off");
  });

  it("names the engine the helper ran on, from the machine's helper_started row", () => {
    const on = trial({ rows: [{ kind: "build.helper_started", payload: { slice: 2, engine: "claude:sonnet" } }, { kind: "build.helper_picked", payload: { slice: 2 } }] });
    expect(trialReport(c, on).helperEngine).toBe("claude:sonnet");
    expect(trialReport(c, trial()).helperEngine).toBeNull();
    expect(renderReport("claude:opus", [caseReport(c, on, null)])).toContain("helper engine: claude:sonnet");
  });

  it("prints each case's four facts and the tally", () => {
    const text = renderReport("claude:sonnet", [caseReport(c, trial(), trial({ delegation: "off", wallMs: 10 * 60_000, rows: [] })), caseReport(cases[1]!, trial({ changed: [] }), null)]);
    expect(text).toContain("build-helper on claude:sonnet");
    expect(text).toContain("PASS card-with-discount");
    expect(text).toContain("both slices committed: yes");
    expect(text).toContain("wall clock: 6.0 min with the helper, 10.0 min with delegation off (0.6x)");
    expect(text).toContain("FAIL field-rounds-total");
    expect(text).toContain("1/2 cases passed");
  });
});

describe("untilInterrupted", () => {
  const added = (before: Function[]) => process.listeners("SIGINT").filter((l) => !before.includes(l));

  it("aborts the controller on SIGINT while the run is going, and leaves no handler after it", async () => {
    const before = process.listeners("SIGINT");
    const abort = new AbortController();
    let inside: Function[] = [];
    const out = await untilInterrupted(abort, async () => {
      inside = added(before);
      expect(inside).toHaveLength(1);
      (inside[0] as () => void)();
      return "done";
    });
    expect(out).toBe("done");
    expect(abort.signal.aborted).toBe(true);
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("removes the handler when the run throws, and does not abort", async () => {
    const before = process.listeners("SIGINT");
    const abort = new AbortController();
    await expect(untilInterrupted(abort, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(process.listeners("SIGINT")).toEqual(before);
    expect(abort.signal.aborted).toBe(false);
  });
});
