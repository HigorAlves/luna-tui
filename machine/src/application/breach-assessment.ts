// The breach assessment of one incident (RFC 0008, wave 5): the `breach_assess` decision pack's answer, checked against its schema, becomes the
// regimes that apply and a notification clock for each, counted from when the machine first saw the incident. A decision that fails is an `error` on the
// incident, never an exception: the incident and its postmortem go on without it.
import { PACKS, type BreachAssessContext } from "@hardness/contracts";

import { breachContext, regimesOf, type BreachAnswers, type IncidentBreach } from "../domain/breach.ts";
import { breachClocks, type Incident } from "../domain/incident.ts";

export interface BreachAssessorDeps {
  /** The one run of the `breach_assess` pack; its answer is validated here. */
  decide(context: BreachAssessContext): Promise<unknown>;
  now?: () => Date;
}

export function breachAssessor(deps: BreachAssessorDeps): (incident: Incident) => Promise<IncidentBreach> {
  const now = deps.now ?? (() => new Date());
  return async (incident) => {
    try {
      const answers = PACKS.breach_assess.answer.parse(await deps.decide(breachContext(incident))) as BreachAnswers;
      const regimes = regimesOf(answers);
      return { assessedAt: now().toISOString(), answers, regimes, clocks: breachClocks(incident.seenAt ?? incident.startedAt, regimes) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}
