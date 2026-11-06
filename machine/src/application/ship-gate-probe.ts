// An open release question waits on a person, so nothing polls the PR. This is the look `Pipeline.tick` takes at it, at most once per poll interval:
// GitHub's facts only. A merged PR closes the question, a head that moved or a checklist that no longer passes takes it back, anything unreadable leaves it.
import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { loadCursor } from "./ship-cursor.ts";
import { type ShipFactsDeps, readShipFacts } from "./stages/ship-monitor.ts";
import type { StageContext } from "./ports.ts";
import { mergedIntoOther } from "./stack.ts";

export type ShipGateProbe = (task: TaskRow, gate: ApprovalRow) => Promise<"merged" | "closed" | "withdraw" | "keep">;

export function shipGateProbe(deps: ShipFactsDeps & { stateDir: string; now?: () => Date }): ShipGateProbe {
  return async (task, gate) => {
    const cursor = await loadCursor(deps.stateDir, task.id);
    if (!cursor) return "keep";
    const { slug, number } = cursor.pr;
    const state = await deps.github.prMerged(slug, number);
    if (state.merged) return (await mergedIntoOther(deps, slug, number, task.repoPath)) ? "closed" : "merged";
    // GitHub's own `closed` state: the pipeline archives the card (`pr_closed`).
    if (state.state === "closed") return "closed";
    const facts = await readShipFacts(deps, { task, approvals: [] } as unknown as StageContext, { slug, number }, cursor, deps.now);
    if (!facts) return "keep";
    const asked = gate.requested.head;
    if (facts.head === null || (typeof asked === "string" && facts.head !== asked)) return "withdraw";
    return facts.readiness.ready ? "keep" : "withdraw";
  };
}
