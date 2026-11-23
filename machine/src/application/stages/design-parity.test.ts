import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { waiverHash } from "../../domain/design-parity.ts";
import { runDesignParity } from "./design-parity.ts";

const desktop = { name: "1440x900", width: 1440, height: 900 };
const designed = { state: "default", nodeId: "12:35", suggestion: null };
const spec = { frames: [{ id: "F1", name: "Checkout", viewport: { width: 1440, height: 900 }, states: [designed] }, { id: "F9", name: "Modal", viewport: null, states: [designed] }] } as never;
const parity = {
  plan: { targets: [{ scenario: "S1", frame: "F1", viewport: desktop, state: "default" as const }], uncited: [], notes: [] },
  captures: [{ scenario: "S1", frame: "F1", viewport: "1440x900", state: "default" as const, image: "/evidence/parity/S1/1440x900-default.png", styles: null, elements: 3 }],
  missing: [],
  notes: [],
  dir: "/state/runs/r1/parity",
};
const ctx = { runId: "r1", task: { id: "t1", repoPath: "/r/app" } } as never;
const answer = { frames: [{ frame: "F1", scenario: "S1", viewport: "1440x900", state: "default", status: "compared", capture: "/evidence/parity/S1/1440x900-default.png", render: "/design/1-0.png" }], findings: [], designInput: "complete", confidence: 0.9, summary: "clean" };
const ok = { outcome: "pass" as const, detail: { answer }, usage: { tokens: { input: 10, output: 5 } } };
const deps = (over: Record<string, unknown> = {}) => ({ run: async () => ok, spec: () => spec, bar: async () => 0.75, stateDir: "/state", ...over }) as never;

describe("runDesignParity", () => {
  it("runs the reviewer as a sub-run with the captures mounted read-only, and settles its answer", async () => {
    const calls: Array<{ runId: string; mounts: unknown; parity: unknown }> = [];
    const out = await runDesignParity(deps({ run: async (sub: { runId: string }, extra: { mounts: unknown; parity: unknown }) => (calls.push({ runId: sub.runId, mounts: extra.mounts, parity: extra.parity }), ok) }), ctx, parity);
    expect(calls).toEqual([{ runId: "r1-parity", mounts: [{ host: "/state/runs/r1/parity", container: "/evidence/parity", readOnly: true }], parity: { plan: parity.plan, captures: parity.captures, spec } }]);
    expect(out).toMatchObject({ report: { ran: true, runId: "r1-parity", confidence: 0.9, bar: 0.75, designInput: "complete", summary: "clean", counts: { blocker: 0, should_fix: 0, nit: 0, waived: 0 } }, gate: { fires: false } });
    // The rows carry host paths; with no pairing wired there is no pair.
    expect((out as { report: { frames: unknown[] } }).report.frames).toEqual([expect.objectContaining({ status: "compared", capture: "/state/runs/r1/parity/S1/1440x900-default.png", render: "/state/runs/r1-parity/design/1-0.png", pair: null })]);
  });

  it("starts no sub-run when the machine holds no capture: every planned row is not compared, no capture", async () => {
    const none = { ...parity, captures: [] };
    const out = await runDesignParity(deps({ run: async () => { throw new Error("ran"); } }), ctx, none);
    expect(out).toMatchObject({ report: { ran: false, runId: null, frames: [{ frame: "F1", status: "not_compared", reason: "no capture" }] }, gate: { fires: true, why: expect.arrayContaining(["not_compared"]) } });
  });

  it("pairs each compared frame from host paths: the container paths are mapped", async () => {
    const state = mkdtempSync(join(tmpdir(), "parity-"));
    const here = { ...parity, dir: join(state, "runs", "r1", "parity") };
    const pairs: Array<{ render: string; capture: string; outDir: string; name: string }> = [];
    const pair = async (input: (typeof pairs)[number]) => (pairs.push(input), { pair: `${input.outDir}/${input.name}.pair.png`, diff: `${input.outDir}/${input.name}.diff.png`, diffRatio: 0.02 });
    const out = await runDesignParity(deps({ pair, stateDir: state }), ctx, here);
    expect(pairs).toEqual([{ render: join(state, "runs", "r1-parity", "design", "1-0.png"), capture: join(state, "runs", "r1", "parity", "S1", "1440x900-default.png"), outDir: join(state, "runs", "r1-parity", "pairs"), name: expect.stringMatching(/^[A-Za-z0-9_-]{1,80}$/) }]);
    expect(out).toMatchObject({ report: { frames: [{ status: "compared", capture: pairs[0]!.capture, render: pairs[0]!.render, diffRatio: 0.02, pair: expect.stringContaining(".pair.png") }] }, gate: { fires: false } });
  });

  it("never passes a frame the reviewer gave no render for, and the gate fires for it", async () => {
    const noRender = { ...ok, detail: { answer: { ...answer, frames: [{ ...answer.frames[0], render: null }] } } };
    const out = await runDesignParity(deps({ run: async () => noRender, pair: async () => { throw new Error("paired"); } }), ctx, parity);
    expect(out).toMatchObject({ report: { frames: [{ status: "not_compared", reason: "no frame render to pair" }] }, gate: { fires: true, why: ["not_compared"] } });
  });

  it("never passes a frame whose pair could not be made, and the gate fires for it", async () => {
    const state = mkdtempSync(join(tmpdir(), "parity-"));
    const out = await runDesignParity(deps({ stateDir: state, pair: async () => ({ pair: null, diff: null, diffRatio: null, note: "frame unreadable: ENOENT" }) }), ctx, parity);
    expect(out).toMatchObject({ report: { frames: [{ status: "not_compared", reason: "frame unreadable: ENOENT" }] }, gate: { fires: true, why: ["not_compared"] } });
  });

  it("settles a failed sub-run as no answer: nothing compared, the gate fires", async () => {
    const out = await runDesignParity(deps({ run: async () => ({ outcome: "fail", detail: {} }) }), ctx, parity);
    expect(out).toMatchObject({ report: { ran: true, confidence: 0 }, gate: { fires: true, why: expect.arrayContaining(["low_confidence"]) } });
  });

  it("settles an answer off the schema, and a run that throws, as no answer", async () => {
    for (const run of [async () => ({ outcome: "pass" as const, detail: { answer: { frames: "x" } } }), async () => { throw new Error("boom"); }]) {
      expect(await runDesignParity(deps({ run }), ctx, parity)).toMatchObject({ gate: { fires: true, why: expect.arrayContaining(["low_confidence"]) } });
    }
  });

  it("does not run without a planned capture or a cited frame to count", async () => {
    const empty = { ...parity, plan: { targets: [], uncited: [], notes: [] } };
    expect(await runDesignParity(deps({ run: async () => { throw new Error("ran"); } }), ctx, empty)).toBeNull();
  });

  it("counts a cited frame with no viewport as not compared and opens the gate, without a run when nothing else is planned", async () => {
    const empty = { ...parity, plan: { targets: [], uncited: [], notes: [] }, captures: [] };
    const out = await runDesignParity(deps({ run: async () => { throw new Error("ran"); } }), ctx, empty, [{ scenario: "S9", frame: "F9" }]);
    expect(out).toMatchObject({ report: { ran: false, runId: null, frames: [{ frame: "F9", status: "not_compared", reason: "the spec gives this frame no viewport" }] }, gate: { fires: true, why: expect.arrayContaining(["not_compared"]) } });
  });

  it("escalates design_budget without a run when the budget is spent", async () => {
    const spent = { tokens: 9, tokensCounted: true, minutes: 1, spent: "tokens" as const, limits: { max_tokens: 5, max_minutes: 60 } };
    const out = await runDesignParity(deps({ budget: async () => spent, run: async () => { throw new Error("ran"); } }), ctx, parity);
    expect(out).toMatchObject({ escalate: { outcome: "escalated", detail: { escalation: "design_budget", step: "e2e" } } });
  });

  it("reports the sub-run's usage and whether the budget ran out after it", async () => {
    let calls = 0;
    const budget = async () => ({ tokens: 0, tokensCounted: true, minutes: 0, spent: ++calls > 1 ? ("tokens" as const) : null, limits: { max_tokens: 5, max_minutes: 60 } });
    const out = await runDesignParity(deps({ budget }), ctx, parity);
    expect(out).toMatchObject({ usage: { tokens: { input: 10, output: 5 } }, spentAfter: true });
  });

  it("counts a finding a person already waived on this card under waived, and keeps it out of the blockers and the gate", async () => {
    const found = { level: "blocker", kind: "token", frame: "F1", node: "x", element: "button.pay", viewport: "1440x900", state: "default", expected: "a", actual: "b", title: "t", why: "w", confidence: 0.9 };
    const run = async () => ({ outcome: "pass" as const, detail: { answer: { ...answer, findings: [found] } } });
    const first = (await runDesignParity(deps({ run }), ctx, parity)) as { findings: Array<{ id: string; body: string; design: unknown }> };
    expect(first.findings).toHaveLength(1);
    const asked: string[] = [];
    const again = await runDesignParity(deps({ run, waived: async (id: string) => (asked.push(id), [{ id: first.findings[0]!.id, hash: waiverHash(first.findings[0]! as never) }]) }), ctx, parity);
    expect(asked).toEqual(["t1"]);
    expect(again).toMatchObject({ gate: { fires: false }, report: { counts: { blocker: 0, should_fix: 0, nit: 0, waived: 1 } }, findings: [{ resolution: { status: "waived", by: "person" } }] });
  });
});
