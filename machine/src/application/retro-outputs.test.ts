import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { acceptedMisses, proposalsSection, retroTruthOf, writeRetroTruth } from "./retro-outputs.ts";

const facts = { predicted: { size: "small", risk: "low", estLoc: 100, urgency: "high" }, actual: { added: 50, removed: 5, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 1, format: "text", durationMin: 30, overrides: 2 }, runs: 6 };

describe("retroTruthOf", () => {
  it("is the machine's own predicted-against-actual table whether or not a retro ran", () => {
    const doc = retroTruthOf({ taskId: "t1", facts, retro: null, adopted: false });
    expect(doc).toEqual({ schema: 1, taskId: "t1", table: { size: { predicted: "small", actual: 55 }, risk: { predicted: "low" }, urgency: { predicted: "high" }, iterations: { actual: 1 }, escalations: { actual: 1 }, format: { actual: "text" } }, retroRan: false, recalibration: [], adopted: false });
  });
  it("keeps the retro's recalibration notes through safe(), capped at 300 characters, and whether its proposals were adopted", () => {
    const note = "x".repeat(400) + " mail me at bo@example.com <script>";
    const doc = retroTruthOf({ taskId: "t1", facts, retro: { recalibration: [{ dimension: "size", predicted: "small", actual: "large", note }] }, adopted: true });
    expect(doc.retroRan).toBe(true);
    expect(doc.adopted).toBe(true);
    expect(doc.recalibration[0]!.note.length).toBeLessThanOrEqual(300);
    expect(doc.recalibration[0]!.note).not.toContain("<script>");
  });
  it("is written to <stateDir>/ground-truth/retro/<taskId>.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retro-"));
    await writeRetroTruth(dir, retroTruthOf({ taskId: "t9", facts, retro: null, adopted: false }));
    expect(JSON.parse(await readFile(join(dir, "ground-truth", "retro", "t9.json"), "utf8"))).toMatchObject({ schema: 1, taskId: "t9" });
  });
});

describe("acceptedMisses", () => {
  it("keeps only a path that is also one of the card's files outside the map; a path only the model names is dropped", () => {
    expect(acceptedMisses(["src/a.ts", "etc/passwd", "../x"], ["src/a.ts", "src/b.ts"])).toEqual(["src/a.ts"]);
    expect(acceptedMisses("nope", ["a"])).toEqual([]);
  });
});

describe("proposalsSection", () => {
  it("is an inert Proposals section: no mentions, no markup, nothing past the caps", () => {
    const text = proposalsSection([{ kind: "adr", title: "Use <b>queues</b> @bo", body: "see #12 and @team " + "y".repeat(3000) }]);
    expect(text).toMatch(/^## Proposals/);
    expect(text).not.toContain("<b>");
    expect(text).not.toMatch(/@(?=[A-Za-z])/);
    expect(text.length).toBeLessThan(2600);
  });
  it("is empty with no proposals", () => {
    expect(proposalsSection([])).toBe("");
  });
});
