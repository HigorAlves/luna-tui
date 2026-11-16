import { describe, expect, it, vi } from "vitest";

import type { Incident } from "../domain/incident.ts";
import { breachAssessor } from "./breach-assessment.ts";

const incident: Incident = {
  id: "jira:OPS-9",
  title: "Export bucket public",
  severity: "high",
  status: "open",
  startedAt: "2026-11-10T09:00:00.000Z",
  resolvedAt: null,
  service: "exports",
  signals: [],
  timeline: [],
};
const NOW = new Date("2026-11-12T00:00:00.000Z");
const yes = { value: true, p: 0.9 };
const no = { value: false, p: 0.1 };
const answer = { personal_data: yes, phi: no, eu_subjects: yes, br_subjects: yes, us_subjects: no, subjects: { score: 1, confidence: 0.7 } };

describe("breachAssessor", () => {
  it("derives the regimes from the answers and the clocks from when the incident started", async () => {
    const decide = vi.fn(async () => answer);
    const breach = await breachAssessor({ decide, now: () => NOW })(incident);
    expect(breach).toEqual({
      assessedAt: NOW.toISOString(),
      answers: answer,
      regimes: ["gdpr", "lgpd"],
      clocks: { gdpr: "2026-11-13T09:00:00.000Z", lgpd: "2026-11-13T09:00:00.000Z" },
    });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ title: "Export bucket public", service: "exports" }));
  });

  it("counts the clocks from when the machine first saw the incident, not from when its source says it started", async () => {
    const seen = { ...incident, startedAt: "2026-08-01T00:00:00.000Z", seenAt: "2026-11-11T09:00:00.000Z" };
    const breach = await breachAssessor({ decide: async () => answer, now: () => NOW })(seen);
    expect(breach).toMatchObject({ clocks: { gdpr: "2026-11-14T09:00:00.000Z" } });
  });

  it("answers with the error instead of throwing when the decision fails or is not valid", async () => {
    const down = await breachAssessor({ decide: async () => Promise.reject(new Error("agents are off")), now: () => NOW })(incident);
    expect(down).toEqual({ error: "agents are off" });
    const odd = await breachAssessor({ decide: async () => ({ personal_data: "yes" }), now: () => NOW })(incident);
    expect(odd).toHaveProperty("error");
    expect(odd).not.toHaveProperty("regimes");
  });
});
