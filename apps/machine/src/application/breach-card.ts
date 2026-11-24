// The breach card (RFC 0008, wave 5): when an assessment finds at least one regime, the incident gets ONE board card, so the clocks are seen
// and triage reads it as P0 (a `security` label on its source). The card's id is kept on the incident, so a reassessment never makes a second.
// Each clock is one `compliance.deadline` event on the card, as the vulnerability job logs an overdue alert.
import { assessedBreach } from "../domain/breach.ts";
import type { BreachRegime, Incident } from "../domain/incident.ts";
import { messageOf } from "./github.ts";
import type { NewTask } from "./pipeline.ts";

/** Who must be told, per regime. */
const TOLD: Record<BreachRegime, string> = {
  gdpr: "the supervisory authority (GDPR Art. 33), and the people affected when the risk to them is high",
  lgpd: "the ANPD and the people affected (LGPD)",
  hipaa: "the people affected, and HHS (HIPAA breach notification)",
  us_privacy: "the people affected, and the state attorneys general where a state law asks (US state breach laws)",
};

export interface BreachCardDeps {
  pipeline: { createTask(input: NewTask): Promise<{ id: string }>; record(id: string, kind: string, payload: Record<string, unknown>): Promise<void> };
  /** Keeps the card id on the stored incident. */
  update(id: string, patch: { breachCardId: string }): Promise<Incident | null>;
  log?: (line: string) => void;
}

/** Given an incident with its fresh assessment, makes the card when there is none yet and a regime applies; returns the incident as stored. */
export function breachCards(deps: BreachCardDeps): (incident: Incident) => Promise<Incident> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (incident) => {
    const breach = assessedBreach(incident.breach);
    if (incident.breachCardId || !breach || breach.regimes.length === 0) return incident;
    try {
      const clocks = breach.clocks as Record<string, string>;
      const task = await deps.pipeline.createTask({
        title: `Breach notification: ${incident.title}`,
        description: [
          `A breach assessment of the incident "${incident.title}" (${incident.severity}${incident.service ? `, service ${incident.service}` : ""}) found notification duties.`,
          "",
          "Deadlines, from when the company became aware of it:",
          ...breach.regimes.map((regime) => `- ${regime}: by ${clocks[regime] ?? "unknown"}. Tell ${TOLD[regime]}.`),
        ].join("\n"),
        repoPath: null,
        // A `security` label on the source knocks the card's priority out to P0 when triage reads its signals.
        source: { kind: "incident", id: incident.id, labels: ["security"] },
        originMachine: "automation",
        hints: { kind: "security", urgency: "critical" },
        // A Jira key in the incident's title names the incident's own ticket: linking it would let the Jira sync move that ticket.
        noJiraDetection: true,
      });
      for (const regime of breach.regimes) {
        await deps.pipeline.record(task.id, "compliance.deadline", { incident: incident.id, regime, deadline: clocks[regime] ?? null }).catch((error: unknown) => log(`incidents: ${incident.id} ${regime}: ${messageOf(error)}`));
      }
      return (await deps.update(incident.id, { breachCardId: task.id })) ?? { ...incident, breachCardId: task.id };
    } catch (error) {
      log(`incidents: breach card for ${incident.id}: ${messageOf(error)}`);
      return incident;
    }
  };
}
