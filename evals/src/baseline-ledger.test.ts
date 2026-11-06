import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { baselineHashes, changedLines, readLedger, writeLedger } from "./baseline-ledger.ts";

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  mkdirSync(join(dir, "baselines", "jev"), { recursive: true });
  writeFileSync(join(dir, "baselines", "jev", "a.json"), "1");
  writeFileSync(join(dir, "baselines", "jev", "b.json"), "1");
  return dir;
};

describe("the baseline ledger", () => {
  it("says every file is new before a first write", () => {
    expect(changedLines(readLedger(folder()), baselineHashes(folder()))[0]).toMatch(/no earlier write is recorded: all 2/);
  });

  it("lists the files changed, new and gone since the last write, and says so when none", () => {
    const dir = folder();
    writeLedger(dir, baselineHashes(dir));
    expect(changedLines(readLedger(dir), baselineHashes(dir))).toEqual(["no baseline file changed since the last write"]);
    writeFileSync(join(dir, "baselines", "jev", "a.json"), "2");
    writeFileSync(join(dir, "baselines", "jev", "c.json"), "1");
    const before = readLedger(dir)!;
    writeFileSync(join(dir, "baselines", "jev", "b.json"), "1");
    expect(changedLines({ ...before, "jev/d.json": "x" }, baselineHashes(dir)).sort()).toEqual(["changed since the last write: evals/baselines/jev/a.json", "gone since the last write: evals/baselines/jev/d.json", "new since the last write: evals/baselines/jev/c.json"]);
  });
});
