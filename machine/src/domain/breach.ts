// What the breach assessment (RFC 0008, wave 5) says about an incident, and what the machine derives from it. Pure: the model answers
// typed questions, and the regimes and the notification clocks come from those answers by rule.

import type { BreachAssessContext } from "@hardness/contracts";

import type { BreachRegime, Incident } from "./incident.ts";

interface YesNo {
  value: boolean;
  p: number;
}

/** The answer of the `breach_assess` pack: one entry per question. */
export interface BreachAnswers {
  personal_data: YesNo;
  phi: YesNo;
  eu_subjects: YesNo;
  br_subjects: YesNo;
  us_subjects: YesNo;
  /** 0 few, 1 many, 2 most; fractional between. */
  subjects: { score: number; confidence: number };
}

/** Kept on the incident: the assessment and its clocks, or the reason there is none. A failed assessment never blocks the incident. */
export interface AssessedBreach {
  assessedAt: string;
  answers: BreachAnswers;
  regimes: BreachRegime[];
  clocks: Partial<Record<BreachRegime, string>>;
  /** The later reassessment that failed, if one did: the clocks above are still the last good ones. */
  error?: string;
  errorAt?: string;
}
export type IncidentBreach = AssessedBreach | { error: string; errorAt?: string };

/** The assessment an incident holds, with its clocks, even when a later reassessment failed; null when it never had a good one. */
export const assessedBreach = (breach: IncidentBreach | undefined): AssessedBreach | null => (breach && "clocks" in breach ? breach : null);

/** What to store after a reassessment: a good one replaces everything; a failed one is kept beside the last good assessment, so
 *  a clock set once is never erased by a rate limit. */
export function mergeBreach(last: IncidentBreach | undefined, next: IncidentBreach, at: string): IncidentBreach {
  if ("clocks" in next) return next;
  const kept = assessedBreach(last);
  const failure = { error: next.error, errorAt: at };
  return kept ? { ...kept, ...failure } : failure;
}

/** Health information puts HIPAA in play on its own; personal data does so for each region whose people are affected. */
export function regimesOf(answers: BreachAnswers): BreachRegime[] {
  const regimes: BreachRegime[] = [];
  const personal = answers.personal_data.value;
  if (personal && answers.eu_subjects.value) regimes.push("gdpr");
  if (personal && answers.br_subjects.value) regimes.push("lgpd");
  if (answers.phi.value) regimes.push("hipaa");
  if (personal && answers.us_subjects.value) regimes.push("us_privacy");
  return regimes.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

const ORDER: BreachRegime[] = ["gdpr", "lgpd", "hipaa", "us_privacy"];
const TIMELINE_CAP = 40;
const SIGNAL_CAP = 20;

/** What the model is shown of an incident: facts, the newest timeline entries and each signal's own title and summary. No address, payload or stack trace. */
export function breachContext(incident: Incident): BreachAssessContext {
  return {
    title: incident.title,
    severity: incident.severity,
    service: incident.service,
    startedAt: incident.startedAt,
    timeline: incident.timeline.slice(-TIMELINE_CAP).map(({ at, source, text }) => ({ at, source, text })),
    signals: incident.signals.slice(0, SIGNAL_CAP).map(({ source, title, severity, status, summary }) => ({ source, title, severity, status, summary })),
  };
}
