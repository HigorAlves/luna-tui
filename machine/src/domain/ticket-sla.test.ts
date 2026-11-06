import { FACTORY_DEFAULTS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { type ClockInput, ticketClocks } from "./ticket-sla.ts";

const DAY = 86_400_000;
const t0 = new Date("2026-11-01T00:00:00Z");
const input = (over: Partial<ClockInput> = {}): ClockInput => ({ firstSeenAt: t0, acknowledgedAt: null, priority: null, status: "assessed", needsInfoSince: null, updatedAt: t0, ...over });
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const by = (clocks: ReturnType<typeof ticketClocks>, name: string) => clocks.find((c) => c.name === name);
const cfg = FACTORY_DEFAULTS.tickets;

describe("ticketClocks, with the defaults", () => {
  it("has the defaults: acknowledge in 24 hours, resolve by priority, stale after 30 days, a reminder after 3 and a park after 10 days waiting for a reporter", () => {
    expect(cfg.sla).toEqual({ acknowledge_hours: 24, resolve_days: { P0: 2, P1: 7, P2: 30, P3: 90 }, stale_days: 30, needs_info_reminder_days: 3, needs_info_park_days: 10 });
  });

  it("acknowledge: due 24 hours after first seen, overdue after, and gone once someone acknowledged", () => {
    expect(by(ticketClocks(input(), at(0.5), cfg), "acknowledge")).toMatchObject({ dueAt: at(1), overdue: false });
    expect(by(ticketClocks(input(), at(1.5), cfg), "acknowledge")).toMatchObject({ overdue: true });
    expect(by(ticketClocks(input({ acknowledgedAt: at(0.2) }), at(5), cfg), "acknowledge")).toBeUndefined();
  });

  it("resolve: by the priority, from first seen; none before a priority is known", () => {
    expect(by(ticketClocks(input({ priority: "P1" }), at(6), cfg), "resolve")).toMatchObject({ dueAt: at(7), overdue: false });
    expect(by(ticketClocks(input({ priority: "P0" }), at(3), cfg), "resolve")).toMatchObject({ dueAt: at(2), overdue: true });
    expect(by(ticketClocks(input(), at(3), cfg), "resolve")).toBeUndefined();
  });

  it("stale: 30 days after the last change", () => {
    expect(by(ticketClocks(input({ updatedAt: at(2) }), at(31), cfg), "stale")).toMatchObject({ dueAt: at(32), overdue: false });
    expect(by(ticketClocks(input({ updatedAt: at(2) }), at(33), cfg), "stale")).toMatchObject({ overdue: true });
  });

  it("waiting for the reporter: a reminder at 3 days and a park at 10, from when it started waiting", () => {
    const waiting = input({ status: "needs_info", needsInfoSince: at(1) });
    expect(by(ticketClocks(waiting, at(3), cfg), "needs_info_reminder")).toMatchObject({ dueAt: at(4), overdue: false });
    expect(by(ticketClocks(waiting, at(5), cfg), "needs_info_reminder")).toMatchObject({ overdue: true });
    expect(by(ticketClocks(waiting, at(10), cfg), "needs_info_park")).toMatchObject({ dueAt: at(11), overdue: false });
    expect(by(ticketClocks(waiting, at(12), cfg), "needs_info_park")).toMatchObject({ overdue: true });
    expect(by(ticketClocks(input(), at(12), cfg), "needs_info_park")).toBeUndefined();
  });

  it("has no resolve or stale clock for a ticket that has a card, was handed over or ended", () => {
    for (const status of ["carded", "handed_over", "duplicate", "not_ours", "parked"]) {
      const c = ticketClocks(input({ status, priority: "P0" }), at(100), cfg);
      expect(by(c, "resolve")).toBeUndefined();
      expect(by(c, "stale")).toBeUndefined();
    }
  });

  it("takes the repository's numbers", () => {
    const own = { ...cfg, sla: { ...cfg.sla, acknowledge_hours: 2 } };
    expect(by(ticketClocks(input(), at(0.1), own), "acknowledge")).toMatchObject({ overdue: true });
  });
});
