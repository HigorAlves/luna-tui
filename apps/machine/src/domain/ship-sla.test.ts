import { describe, expect, it } from "vitest";

import { shipSla } from "./ship-sla.ts";

const day = 86_400_000;
const t0 = new Date("2026-11-01T00:00:00Z");
const at = (days: number) => new Date(t0.getTime() + days * day);
const base = { lastActivityAt: t0.toISOString(), remindedAt: null, escalatedAt: null, reminderDays: 2, escalateDays: 5 };

describe("shipSla", () => {
  it("says nothing before the reminder days", () => {
    expect(shipSla({ ...base, now: at(1.9) })).toBeNull();
  });
  it("reminds after two quiet days, once", () => {
    expect(shipSla({ ...base, now: at(2) })).toBe("remind");
    expect(shipSla({ ...base, remindedAt: at(2).toISOString(), now: at(3) })).toBeNull();
  });
  it("escalates after five days, only after a reminder, once", () => {
    expect(shipSla({ ...base, now: at(6) })).toBe("remind");
    expect(shipSla({ ...base, remindedAt: at(2).toISOString(), now: at(5) })).toBe("escalate");
    expect(shipSla({ ...base, remindedAt: at(2).toISOString(), escalatedAt: at(5).toISOString(), now: at(9) })).toBeNull();
  });
  it("activity starts the period again: a reminder before the last activity does not count", () => {
    const later = { ...base, lastActivityAt: at(4).toISOString(), remindedAt: at(2).toISOString() };
    expect(shipSla({ ...later, now: at(7) })).toBe("remind");
  });
  it("0 turns either clock off", () => {
    expect(shipSla({ ...base, reminderDays: 0, now: at(9) })).toBeNull();
    expect(shipSla({ ...base, escalateDays: 0, remindedAt: at(2).toISOString(), now: at(9) })).toBeNull();
  });
  it("an unreadable date says nothing", () => {
    expect(shipSla({ ...base, lastActivityAt: "soon", now: at(9) })).toBeNull();
  });
});
