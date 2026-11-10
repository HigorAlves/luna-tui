import { describe, expect, it } from "vitest";

import { OVERHEAD_PACKS, ledgerRecord, summary } from "./ledger.ts";

const run = { at: "2026-01-01T00:00:00.000Z", runId: "r1", cardId: "c1" };

describe("ledger", () => {
  it("prices a run in effective tokens: input, cache reads at a tenth, output at five", () => {
    const record = ledgerRecord({ ...run, pack: "implementing", tokens: { input: 1000, output: 100, cached: 5000 } });
    expect(record).toEqual({ at: run.at, runId: "r1", card: "c1", pack: "implementing", kind: "exec", effective: 2000, tokens: { input: 1000, output: 100, cached: 5000 } });
  });

  it("is 0 effective when the runtime gave no numbers", () => {
    expect(ledgerRecord({ ...run, pack: "verifying", tokens: null })).toMatchObject({ effective: 0, tokens: null, kind: "exec" });
  });

  it("marks the judge, the redirect writer and the fact proposer as overhead", () => {
    expect(OVERHEAD_PACKS).toEqual(["loop_judge", "loop_redirect", "fact_propose"]);
    for (const pack of OVERHEAD_PACKS) expect(ledgerRecord({ ...run, pack, tokens: null }).kind).toBe("overhead");
  });

  it("keeps a cost in dollars when it is given", () => {
    expect(ledgerRecord({ ...run, pack: "loop_judge", tokens: null, costUsd: 0.02 })).toMatchObject({ costUsd: 0.02 });
  });

  it("sums exec and overhead, and the overhead's share of both", () => {
    const records = [
      ledgerRecord({ ...run, pack: "implementing", tokens: { input: 900, output: 0, cached: 0 } }),
      ledgerRecord({ ...run, pack: "loop_judge", tokens: { input: 100, output: 0, cached: 0 } }),
    ];
    expect(summary(records)).toEqual({ exec: 900, overhead: 100, overheadShare: 0.1 });
    expect(summary([])).toEqual({ exec: 0, overhead: 0, overheadShare: 0 });
  });
});
