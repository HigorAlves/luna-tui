import { SCORING_DEFAULTS, type TicketContext } from "@hardness/contracts";
import type { CanonicalTicket } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AssessAnswer } from "../domain/ticket-score.ts";
import { assessTicket } from "./ticket-assess.ts";
import type { TicketValidity } from "./ticket-validity.ts";

const s = { score: 1, confidence: 0.9 };
const no = { value: false, p: 0.05 };
const answer = { who: s, what: s, impact: s, time: s, demand: s, files: s, unknowns: s, cross_team: s, new_infra: s, dependents: s, traffic: s, data_sensitivity: s, reversibility: s, regression: s, compounding: s, production_down: no, data_loss: no, security: no, incident: no, compliance_deadline: no } as AssessAnswer;
const ticket = { key: "PAY-12", title: "t", description: "d", type: "Bug", priority: null, reporter: { id: "u" }, labels: [], sprint: "S5", dueAt: "2026-12-01", comments: [] } as unknown as CanonicalTicket;
const enrichment = { linked: [], epic: null, recent: [], files: [], shortlist: [] };
const workable: TicketValidity = { outcome: "workable", missing: [], duplicateOf: null, reporterReachable: true };
const config = { scoring: { weights: SCORING_DEFAULTS.weights, bands: SCORING_DEFAULTS.bands } };

describe("assessTicket", () => {
  it("assesses only a workable ticket: any other validity makes no call", async () => {
    const decide = vi.fn(async () => answer);
    for (const outcome of ["needs_info", "duplicate", "not_ours"] as const) {
      expect(await assessTicket({ decide }, ticket, enrichment, { ...workable, outcome }, config, new Date())).toBeNull();
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("makes one call, scores it in code, and keeps the sub-scores in the record, which carries the sprint and due date to the pack", async () => {
    let seen: TicketContext | null = null;
    const appended: Record<string, unknown>[] = [];
    const rec = await assessTicket({ decide: async (ctx) => ((seen = ctx), answer), store: { appendAssessment: async (_k, e) => void appended.push(e) } }, ticket, enrichment, workable, config, new Date("2026-11-05T12:00:00Z"));
    expect(seen).toMatchObject({ sprint: "S5", dueAt: "2026-12-01" });
    expect(rec).toMatchObject({ priority: "P1", size: "M", blastRadius: "medium", at: "2026-11-05T12:00:00.000Z" });
    expect(rec!.subScores.who).toEqual({ value: 2, confidence: 0.9 });
    expect(appended).toHaveLength(1);
  });

  it("makes a cannot-reproduce bug with no reachable reporter a park", async () => {
    const rec = await assessTicket({ decide: async () => answer }, ticket, enrichment, { ...workable, reporterReachable: false }, config, new Date(), { cantReproduce: true });
    expect(rec).toMatchObject({ parked: true });
  });

  it("is no assessment when the call fails", async () => {
    expect(await assessTicket({ decide: async () => { throw new Error("down"); } }, ticket, enrichment, workable, config, new Date())).toBeNull();
  });
});
