// What `GET /metrics` shows of the token economy (RFC 0007 §5): the statuses of one repository or of every known one, added up.
import type { EconomyMetrics, EconomyStatus } from "@hardness/contracts";

export function economyMetrics(statuses: readonly EconomyStatus[]): EconomyMetrics {
  let exec = 0;
  let overhead = 0;
  let overheadUnpriced = 0;
  let redirects = 0;
  let stops = 0;
  let active = 0;
  let promoted = 0;
  let masked = 0;
  for (const status of statuses) {
    exec += status.cost.exec;
    overhead += status.cost.overhead;
    overheadUnpriced += status.cost.overheadUnpriced;
    for (const event of status.guard) {
      if (event.action === "redirect") redirects += 1;
      else if (event.action === "stop") stops += 1;
    }
    for (const fact of status.facts ?? []) {
      if (fact.state === "active") active += 1;
      else if (fact.state === "promoted") promoted += 1;
    }
    for (const tools of Object.values(status.tools ?? {})) masked += tools.mask.length;
  }
  const total = exec + overhead;
  return { effective: { exec, overhead }, overheadShare: total === 0 ? 0 : overhead / total, overheadUnpriced, guard: { redirects, stops }, facts: { active, promoted }, masked };
}
