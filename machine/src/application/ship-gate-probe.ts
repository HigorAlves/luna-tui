// An open release question waits on a person, so nothing polls the PR. This is the look `Pipeline.tick` takes at it, at most once per poll interval:
// GitHub's facts only. A merged PR closes the question, a head that moved or a checklist that no longer passes takes it back, an approving review on the head
// is offered as the release approval, and so is a `/ship` comment (the pipeline applies the approver rules to both), anything unreadable leaves it.
import { approversByComment } from "../domain/review-rule.ts";
import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { loadCursor } from "./ship-cursor.ts";
import { type ShipFactsDeps, readShipFacts } from "./stages/ship-monitor.ts";
import type { StageContext } from "./ports.ts";
import { mergedIntoOther } from "./stack.ts";

/** `approvedBy`: the logins whose approval of the PR counts at `head` (reviews first, oldest first, then the people who only commented `/ship`); the pipeline picks the first
 *  the approver rules allow, or keeps the gate. `byComment`: those of them who approved by a `/ship` comment and not by a review (absent when none did). */
export type ShipGateProbe = (task: TaskRow, gate: ApprovalRow) => Promise<"merged" | "closed" | "withdraw" | "keep" | { approvedBy: string[]; head: string; byComment?: string[] }>;

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
    if (!facts.readiness.ready) return "withdraw";
    // A `/ship` must come after the head commit and after the question was asked; a head whose time is unknown takes none. An unreadable list of comments is none.
    const after = Math.max(Date.parse(facts.pr.headCommittedAt ?? ""), gate.createdAt instanceof Date ? gate.createdAt.getTime() : Number.NEGATIVE_INFINITY);
    const comments = await deps.github.prActivity(slug, number, null).catch(() => []);
    const known = new Set(facts.approvers.map((a) => a.toLowerCase()));
    const byComment = approversByComment(comments, Number.isNaN(after) ? null : after).filter((login) => !known.has(login.toLowerCase()));
    const approvedBy = [...facts.approvers, ...byComment];
    return approvedBy.length > 0 ? { approvedBy, head: facts.head, ...(byComment.length > 0 ? { byComment } : {}) } : "keep";
  };
}
