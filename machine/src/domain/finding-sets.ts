// The set of blocker findings a verifying failure carries, and how many rounds Build has had on it.
// Pure: the transition function decides from these whether the same set came back.
import { type Finding, findingId, severityOf } from "@hardness/contracts";

export interface FindingSetRounds {
  key: string;
  rounds: number;
}

/** The blocker findings' ids, sorted and joined; null when no blocker stands (the loop cap then applies). The id a finding carries wins over one worked out from its text. */
export function blockerSetKey(findings: readonly Finding[]): string | null {
  const ids = [...new Set(findings.filter((f) => severityOf(f.severity) === "blocker").map((f) => f.id ?? findingId(f)))].sort();
  return ids.length > 0 ? ids.join(",") : null;
}

/** What a failure with this set does: escalate when Build already had `allowed` rounds on the same set, else send it to Build and count the round. A different set starts its own count. */
export function nextRound(prev: FindingSetRounds | undefined, key: string, allowed: number): { escalate: boolean; set: FindingSetRounds } {
  const spent = prev?.key === key ? prev.rounds : 0;
  return spent >= allowed ? { escalate: true, set: { key, rounds: spent } } : { escalate: false, set: { key, rounds: spent + 1 } };
}
