import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readScenarioReds } from "./scenario-reds.ts";

const outWith = (content: string | null) => {
  const out = mkdtempSync(join(tmpdir(), "reds-"));
  mkdirSync(join(out, "checks"));
  if (content !== null) writeFileSync(join(out, "checks", "scenario-reds.json"), content);
  return out;
};

describe("readScenarioReds", () => {
  it("reads the writer's reports, keeping each output's tail capped, and drops an id that is not a plain id", async () => {
    const out = outWith(JSON.stringify({ S1: "x".repeat(10_000) + "THE END", "../etc": "no", S2: 7 }));
    const reds = await readScenarioReds(out);
    expect(Object.keys(reds)).toEqual(["S1"]);
    expect(reds.S1!.length).toBeLessThanOrEqual(4096);
    expect(reds.S1!.endsWith("THE END")).toBe(true);
  });

  it("is empty when the writer reported nothing or the file is not JSON", async () => {
    expect(await readScenarioReds(outWith(null))).toEqual({});
    expect(await readScenarioReds(outWith("{half"))).toEqual({});
  });

  it("does not follow a symlink the container planted in place of the file, and refuses one that is too big", async () => {
    const out = mkdtempSync(join(tmpdir(), "reds-"));
    mkdirSync(join(out, "checks"));
    const target = join(out, "secret.json");
    writeFileSync(target, JSON.stringify({ S1: "from a host file" }));
    symlinkSync(target, join(out, "checks", "scenario-reds.json"));
    expect(await readScenarioReds(out)).toEqual({});
    const big = outWith(JSON.stringify({ S1: "x".repeat(70_000) }));
    expect(await readScenarioReds(big)).toEqual({});
  });
});
