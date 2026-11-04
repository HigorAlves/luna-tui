// The build watch follows an implementing run's /out while the container runs: a slice turned
// committed is pushed as it lands, so a killed container never loses a green slice.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildWatch } from "./build-watch.ts";

const ledger = (slices: Array<{ id: number; status: string; commit?: string | null }>) =>
  JSON.stringify({ schema: 1, slices: slices.map((s) => ({ id: s.id, title: `slice ${s.id}`, status: s.status, commit: s.commit ?? null })) });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("buildWatch", () => {
  it("calls onCommitted once per slice that became committed, and never again for the same slice", async () => {
    const out = mkdtempSync(join(tmpdir(), "build-watch-"));
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "red" }]));
    const committed: number[] = [];
    const watch = buildWatch({ outDir: out, every: 5, onCommitted: async (slice) => void committed.push(slice.id) });
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "committed", commit: "abc" }]));
    await settle(60);
    expect(committed).toEqual([1]);
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 1, status: "committed", commit: "abc" }, { id: 2, status: "committed", commit: "def" }]));
    await settle(60);
    expect(committed).toEqual([1, 2]);
    writeFileSync(join(out, "ledger.json"), "{ not json");
    await settle(30);
    await watch.stop();
    writeFileSync(join(out, "ledger.json"), ledger([{ id: 3, status: "committed", commit: "ghi" }]));
    await settle(30);
    expect(committed).toEqual([1, 2]);
  });
});
