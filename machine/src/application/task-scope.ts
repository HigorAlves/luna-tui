// Which card the code running now is working for. The pipeline opens a scope around a stage run and around the escalation decision;
// a decision pack called inside it carries the card's id (`ownCalls`), so the card's repository decides what is kept of the call
// (`learning.records`, `context`, `traces`), its record names the card, and the prune keeps it while the card is open. A call made
// outside any scope (intake, a ticket, a conversation) names no card, and the machine's own defaults apply.
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ taskId: string }>();

/** Runs `work` for the card `taskId`. */
export const withTask = <T>(taskId: string, work: () => T): T => scope.run({ taskId }, work);

/** The card the running code works for, or undefined. */
export const currentTask = (): string | undefined => scope.getStore()?.taskId;
