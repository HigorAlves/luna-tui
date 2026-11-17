import type { BrainClaim } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type Brain, type BrainAnswer, noBrain } from "./brain.ts";
import { brainWeek } from "./brain-week.ts";
import type { ClaimStore } from "./brain-claims.ts";

const since = new Date("2026-11-09T00:00:00.000Z");
const until = new Date("2026-11-15T23:59:59.999Z");

const claim = (id: string, over: Partial<BrainClaim> = {}) => ({ id, status: "verified", proposed: "verify", decidedBy: "jev", decidedAt: "2026-11-11T10:00:00.000Z", ...over }) as BrainClaim;

function store(lists: { verified?: BrainClaim[]; rejected?: BrainClaim[] }, waiting = 0, fail: "list" | "stats" | null = null) {
  const asked: unknown[] = [];
  const claims = {
    list: async (filter: { status?: string }) => {
      asked.push(filter);
      if (fail === "list") throw new Error("pg");
      return (filter.status === "verified" ? lists.verified : lists.rejected) ?? [];
    },
    stats: async () => {
      if (fail === "stats") throw new Error("pg");
      return { waiting, decided: 0, agreed: 0, missed: 0, ready: false };
    },
  } as unknown as Pick<ClaimStore, "list" | "stats">;
  return { claims, asked };
}

function brainWith(rows: Record<string, number | Error>): Brain {
  return {
    ...noBrain(),
    enabled: true,
    query: async (name): Promise<BrainAnswer> => {
      const hit = rows[name] ?? 0;
      if (hit instanceof Error) throw hit;
      return { rows: Array.from({ length: hit }, () => ({ x: 1 })), note: null };
    },
  };
}

describe("brainWeek", () => {
  it("counts what Jev decided alone in the week, what waits, and the two hygiene queries", async () => {
    const { claims, asked } = store({ verified: [claim("a"), claim("b", { proposed: "flag" }), claim("c", { proposed: "flag" }), claim("late", { decidedAt: "2026-11-20T00:00:00.000Z" })], rejected: [claim("d", { status: "rejected" })] }, 3);
    const week = await brainWeek({ claims, brain: brainWith({ learnings_at_risk: 1, contested_claims: 2 }), since, until });
    expect(week).toEqual({ verifiedByJev: 3, flagged: 2, rejectedByJev: 1, waiting: 3, atRisk: 1, contested: 2 });
    expect(asked).toEqual([
      { status: "verified", decidedBy: "jev", decidedSince: since, limit: 200 },
      { status: "rejected", decidedBy: "jev", decidedSince: since, limit: 200 },
    ]);
  });

  it("reports a graph number as unknown, never zero, when its query did not answer, and counts a plain empty answer as zero", async () => {
    const { claims } = store({ verified: [claim("a")] }, 2);
    expect(await brainWeek({ claims, brain: brainWith({ learnings_at_risk: new Error("down"), contested_claims: 4 }), since, until })).toEqual({ verifiedByJev: 1, flagged: 0, rejectedByJev: 0, waiting: 2, atRisk: null, contested: 4 });
    const refusing: Brain = { ...noBrain(), enabled: true, query: async (name) => (name === "contested_claims" ? { rows: [], note: "unavailable" } : { rows: [], note: `${name} found nothing` }) };
    expect(await brainWeek({ claims, brain: refusing, since, until })).toMatchObject({ atRisk: 0, contested: null });
    expect(await brainWeek({ claims, brain: brainWith({}), since, until })).toMatchObject({ atRisk: 0, contested: 0 });
  });

  it("keeps the other numbers when a store read fails", async () => {
    const { claims } = store({ verified: [claim("a")] }, 2);
    const failing = store({}, 5, "list");
    expect(await brainWeek({ claims: failing.claims, brain: brainWith({}), since, until })).toEqual({ verifiedByJev: 0, flagged: 0, rejectedByJev: 0, waiting: 5, atRisk: 0, contested: 0 });
    const noStats = store({ verified: [claim("a")] }, 5, "stats");
    expect((await brainWeek({ claims: noStats.claims, brain: brainWith({}), since, until })).waiting).toBe(0);
  });

  it("asks the graph nothing when the brain is off", async () => {
    const { claims } = store({}, 1);
    expect(await brainWeek({ claims, brain: noBrain(), since, until })).toEqual({ verifiedByJev: 0, flagged: 0, rejectedByJev: 0, waiting: 1, atRisk: null, contested: null });
  });
});
