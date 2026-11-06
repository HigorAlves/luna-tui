import { SCORING_DEFAULTS, scorePriority } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type PriorityFile, parsePriorityFiles, proposeWeights, readPriorityFiles, renderWeights } from "./weights.ts";

const subs = (who: number, what: number, impact: number, time: number, demand: number) => ({ who, what, impact, time, demand });
const file = (s: ReturnType<typeof subs>, personLevel: string, machineLevel: string | null = null, knockOut: string | null = null): PriorityFile => ({ subScores: s, personLevel, machineLevel, knockOut });
const level = (s: ReturnType<typeof subs>) => scorePriority(s).priority;

/** 40 files whose person level follows a rule where only `who` and `what` matter. */
const world = () => {
  const out: PriorityFile[] = [];
  for (let i = 0; i < 40; i++) {
    const s = subs(i % 3, (i + 1) % 3, (i * 2) % 3, (i * 5) % 3, i % 2);
    const total = s.who * 5 + s.what * 5;
    out.push(file(s, total >= 8 ? "P0" : total >= 5 ? "P1" : total >= 3 ? "P2" : "P3", level(s)));
  }
  return out;
};

describe("proposeWeights", () => {
  it("says too few under thirty files, or under ten where the person changed the level", () => {
    expect(proposeWeights(world().slice(0, 10)).proposal).toBeNull();
    const same = world().map((f) => ({ ...f, personLevel: f.machineLevel! }));
    const out = proposeWeights(same);
    expect(out.proposal).toBeNull();
    expect(out.reason).toMatch(/too few: .* changed/);
  });

  it("leaves a knock-out card out", () => {
    const files = [...world(), file(subs(0, 0, 0, 0, 0), "P0", "P3", "production_down")];
    expect(proposeWeights(files).used).toBe(40);
  });

  it("finds weights and bands that agree with the person more often than today's, and counts the cards it would change", () => {
    const out = proposeWeights(world());
    expect(out.proposal).not.toBeNull();
    expect(out.today.agreement).toBeLessThan(out.proposal!.agreement);
    expect(out.proposal!.weights.who).toBeGreaterThanOrEqual(0);
    expect(out.proposal!.weights.who).toBeLessThanOrEqual(5);
    expect(out.proposal!.changes).toBeGreaterThan(0);
    expect(out.today.weights).toEqual(SCORING_DEFAULTS.weights);
  });

  it("proposes nothing when today's settings already agree best", () => {
    const files = Array.from({ length: 40 }, (_, i) => {
      const s = subs(i % 3, (i + 1) % 3, (i * 2) % 3, (i * 5) % 3, i % 2);
      return file(s, i < 12 ? level(s) : level(s), i < 12 ? "P0" : level(s));
    });
    const out = proposeWeights(files);
    expect(out.proposal).toBeNull();
    expect(out.reason).toMatch(/already/);
  });

  it("prints luna.yaml lines marked proposed, not applied, and no card text", () => {
    const text = renderWeights(proposeWeights(world())).join("\n");
    expect(text).toMatch(/scoring\.weights: \{ who: \d, what: \d, impact: \d, time: \d, demand: \d \}/);
    expect(text).toMatch(/scoring\.bands: \{ P0: \d+, P1: \d+, P2: \d+ \}/);
    expect(text).toContain("proposed, not applied");
  });
});

describe("parsePriorityFiles", () => {
  it("reads the machine's files and skips what does not parse or holds no five sub-scores", () => {
    const good = JSON.stringify({ schema: 1, machine: "triage", id: "1", recordId: null, subScores: subs(1, 1, 1, 1, 1), machineLevel: "P2", personLevel: "P1", knockOut: null });
    const out = parsePriorityFiles([good, "{", JSON.stringify({ machine: "triage", subScores: { who: 1 }, personLevel: "P1" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ personLevel: "P1", machineLevel: "P2" });
  });
});

describe("readPriorityFiles", () => {
  it("reads the files of one machine from the state dir, and nothing when the folder is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "prio-"));
    mkdirSync(join(dir, "ground-truth", "priority"), { recursive: true });
    const body = (machine: string) => JSON.stringify({ schema: 1, machine, id: "1", subScores: subs(1, 1, 1, 1, 1), machineLevel: "P2", personLevel: "P1", knockOut: null });
    writeFileSync(join(dir, "ground-truth", "priority", "triage-1-a.json"), body("triage"));
    writeFileSync(join(dir, "ground-truth", "priority", "conversation-1-a.json"), body("conversation"));
    expect(readPriorityFiles(dir)).toHaveLength(2);
    expect(readPriorityFiles(dir, "triage")).toHaveLength(1);
    expect(readPriorityFiles(join(dir, "none"))).toEqual([]);
  });
});
