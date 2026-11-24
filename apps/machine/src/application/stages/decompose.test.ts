import { type SplitChild, type SplitContext, sizeLimits, FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { tagged } from "../decision-truth.ts";
import { type DecomposeDeps, decompositionLoop } from "./decompose.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const child = (over: Partial<SplitChild> = {}): SplitChild => ({ title: "Part", goal: words(25), acceptance_criteria: ["it works"], covers: [], files_hint: [], est_loc: 400, depends_on: [], order: 1, ...over });
const valid = (): SplitChild[] => [child({ covers: ["C1"], order: 1 }), child({ covers: ["C2"], depends_on: [1], order: 2 })];
const origin = { title: "Export", text: "Export reports", criteria: [{ id: "C1", text: "csv" }, { id: "C2", text: "pdf" }] };
const limits = sizeLimits(FACTORY_DEFAULTS.size);
const input = (over: Record<string, unknown> = {}) => ({ origin, files: [{ path: "src/a.ts" }], limits, ...over });
const yes = { covers: { value: true, p: 0.95 }, no_overlap: { value: true, p: 0.95 }, stand_alone: { value: true, p: 0.95 } };

function setup(script: { decompose?: Array<Record<string, unknown> | Error>; check?: Array<Record<string, unknown> | Error> | null }) {
  const seen: SplitContext[] = [];
  const asked: SplitContext[] = [];
  const answers = [...(script.decompose ?? [{ children: valid() }])];
  const checks = [...(script.check ?? [yes])];
  const deps: DecomposeDeps = {
    decompose: async (context) => {
      seen.push(context);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    check:
      script.check === null
        ? null
        : async (context) => {
            asked.push(context);
            const next = checks.length > 1 ? checks.shift()! : checks[0]!;
            if (next instanceof Error) throw next;
            return next;
          },
    bars: undefined,
  };
  return { deps, seen, asked };
}

describe("decompositionLoop", () => {
  it("answers a valid first round with the checked children, the rounds used and that a decision judged them", async () => {
    const { deps, seen } = setup({});
    const out = await decompositionLoop(deps, input());
    expect(out).toMatchObject({ ok: true, rounds: 1, judged: true });
    expect(out.ok && out.children.map((c) => c.order)).toEqual([1, 2]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ round: 1, children: [], limit: { hard: 2500, maxChildren: 8 }, origin: { criteria: [{ id: "C1", text: "csv" }, { id: "C2", text: "pdf" }] } });
  });

  it("with no check the script alone decides and the answer says nothing judged it", async () => {
    const { deps } = setup({ check: null });
    expect(await decompositionLoop(deps, input())).toMatchObject({ ok: true, judged: false });
  });

  it("hands the script's issues and the last children to the next round, and goes on until the split is valid", async () => {
    const orphan = [child({ covers: ["C1"] }), child({ covers: [] })];
    const { deps, seen } = setup({ decompose: [{ children: orphan }, { children: valid() }] });
    const out = await decompositionLoop(deps, input());
    expect(out).toMatchObject({ ok: true, rounds: 2 });
    expect(seen[1]).toMatchObject({ round: 2, issues: ["criterion C2 is covered by no child"] });
    expect(seen[1]!.children).toHaveLength(2);
  });

  it("asks split_check only when the script has no issue, and turns a no, at any confidence, into one fixed sentence per question", async () => {
    const { deps, seen, asked } = setup({ check: [{ ...yes, stand_alone: { value: false, p: 0.02 }, covers: { value: false, p: 0.4 } }, yes] });
    const out = await decompositionLoop(deps, input());
    expect(out).toMatchObject({ ok: true, rounds: 2, judged: true });
    expect(asked).toHaveLength(2);
    expect(seen[1]!.issues).toEqual(["the children together leave something out of the original", "a child cannot be merged and tested on its own"]);
  });

  it("treats a question under its flag bar (the repository's luna.yaml can raise it) as a finding too, and lets a yes between the bars through", async () => {
    const { deps, seen } = setup({ check: [{ ...yes, no_overlap: { value: true, p: 0.8 } }, yes] });
    await decompositionLoop({ ...deps, bars: { no_overlap: { proceed: 0.95, flag: 0.9 } } }, input());
    expect(seen[1]!.issues).toEqual(["a piece of the work is in more than one child"]);
    const between = setup({ check: [{ ...yes, no_overlap: { value: true, p: 0.6 } }] });
    expect(await decompositionLoop(between.deps, input())).toMatchObject({ ok: true, rounds: 1 });
  });

  it("stops after maxRounds with the reason, the last children and what was still wrong", async () => {
    const bad = [child({ covers: ["C1"] }), child({ covers: [] })];
    const { deps, seen } = setup({ decompose: [{ children: bad }] });
    const out = await decompositionLoop(deps, input());
    expect(out).toEqual({ ok: false, reason: "no valid split after 3 rounds", rounds: 3, issues: ["criterion C2 is covered by no child"], children: expect.any(Array) });
    expect(seen).toHaveLength(3);
    expect(!out.ok && out.children).toHaveLength(2);
  });

  it("counts a decompose run that fails or does not parse as a round", async () => {
    const { deps, seen } = setup({ decompose: [new Error("no runtime"), { children: "nope" }, { children: valid() }] });
    const out = await decompositionLoop(deps, input());
    expect(out).toMatchObject({ ok: true, rounds: 3 });
    expect(seen[2]!.issues).toEqual(["the last answer could not be read as a list of children"]);
    const never = setup({ decompose: [new Error("down")] });
    expect(await decompositionLoop(never.deps, input())).toMatchObject({ ok: false, rounds: 3, children: [] });
  });

  it("keeps going with the script alone when the check cannot be asked", async () => {
    const { deps } = setup({ check: [new Error("jev is down")] });
    expect(await decompositionLoop(deps, input())).toMatchObject({ ok: true, judged: false, rounds: 1 });
  });

  it("hands a person's comment to every round as a flattened note, and honours the repository's maxRounds", async () => {
    const { deps, seen } = setup({ decompose: [{ children: [child()] }] });
    const out = await decompositionLoop(deps, input({ limits: { ...limits, maxRounds: 2 }, note: "split\nby layer " + "x".repeat(3000) }));
    expect(out).toMatchObject({ ok: false, rounds: 2 });
    expect(seen).toHaveLength(2);
    for (const c of seen) {
      expect(c.note).not.toMatch(/\n/);
      expect(c.note!.length).toBeLessThanOrEqual(2000);
    }
  });

  it("returns the recordId of the decision that judged the split", async () => {
    const { deps } = setup({ check: [tagged({ answer: yes, recordId: "rec-1" })] });
    expect(await decompositionLoop(deps, input())).toMatchObject({ ok: true, recordId: "rec-1" });
  });
});
