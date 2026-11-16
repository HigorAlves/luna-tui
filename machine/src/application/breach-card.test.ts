import { describe, expect, it, vi } from "vitest";

import type { Incident } from "../domain/incident.ts";
import { breachCards } from "./breach-card.ts";

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "datadog:incident:812",
  title: "Export bucket public",
  severity: "critical",
  status: "open",
  startedAt: "2026-11-10T09:00:00.000Z",
  resolvedAt: null,
  service: null,
  signals: [],
  timeline: [],
  breach: { assessedAt: "2026-11-10T09:05:00.000Z", answers: {} as never, regimes: ["gdpr", "lgpd"], clocks: { gdpr: "2026-11-13T09:00:00.000Z", lgpd: "2026-11-13T09:00:00.000Z" } },
  ...over,
});

const build = () => {
  const createTask = vi.fn(async (_input: unknown) => ({ id: "card-1" }));
  const record = vi.fn(async (_id: string, _kind: string, _payload: Record<string, unknown>) => {});
  const update = vi.fn(async (_id: string, patch: Partial<Incident>) => ({ ...incident(), ...patch }));
  const log = vi.fn();
  return { createTask, record, update, log, cards: breachCards({ pipeline: { createTask, record }, update, log }) };
};

describe("breachCards", () => {
  it("makes one security card listing each regime's deadline and who is told, with one deadline event per clock", async () => {
    const { cards, createTask, record, update } = build();
    const result = await cards(incident());
    expect(createTask).toHaveBeenCalledTimes(1);
    const task = createTask.mock.calls[0]![0] as { title: string; description: string; source: unknown };
    expect(task.title).toBe("Breach notification: Export bucket public");
    expect(task.source).toMatchObject({ kind: "incident", id: "datadog:incident:812", labels: ["security"] });
    expect(task.description).toContain("gdpr");
    expect(task.description).toContain("2026-11-13");
    expect(task.description).toContain("supervisory authority");
    expect(task.description).toContain("ANPD");
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith("card-1", "compliance.deadline", expect.objectContaining({ regime: "gdpr", deadline: "2026-11-13T09:00:00.000Z" }));
    expect(update).toHaveBeenCalledWith("datadog:incident:812", { breachCardId: "card-1" });
    expect(result.breachCardId).toBe("card-1");
  });

  it("makes no second card on a reassessment of an incident that has one", async () => {
    const { cards, createTask, record } = build();
    const first = await cards(incident());
    await cards({ ...first, breach: { ...(first.breach as object), regimes: ["gdpr"] } as never });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("makes none when no regime applies, or the assessment failed or is missing", async () => {
    const { cards, createTask } = build();
    await cards(incident({ breach: { assessedAt: "x", answers: {} as never, regimes: [], clocks: {} } }));
    await cards(incident({ breach: { error: "rate limited" } }));
    await cards(incident({ breach: undefined }));
    expect(createTask).not.toHaveBeenCalled();
  });

  it("logs and goes on when the card cannot be made", async () => {
    const { cards, createTask, log, update } = build();
    createTask.mockRejectedValueOnce(new Error("db down"));
    const result = await cards(incident());
    expect(result.breachCardId).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("db down"));
  });
});
