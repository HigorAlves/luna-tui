// Posting replies on review threads and resolving them: the address route's delivery and the re-review's post both end here.
import { type GitHub, messageOf } from "../github.ts";

export type FollowedUp = { ok: true; replied: number; resolved: number; skipped: string[] } | { ok: false; error: string; replied: number; resolved: number; skipped: string[] };

/** Posts an answer's replies and resolves the threads it marked; a thread someone resolved meanwhile is skipped. Stops at the first refusal. */
export async function followUp(github: GitHub, replies: Array<{ threadId: string; body: string; resolve: boolean }>): Promise<FollowedUp> {
  let replied = 0;
  let resolved = 0;
  const skipped: string[] = [];
  for (const reply of replies) {
    if (await github.threadResolved(reply.threadId)) {
      skipped.push(reply.threadId);
      continue;
    }
    try {
      await github.replyToThread(reply.threadId, reply.body);
    } catch (error) {
      return { ok: false, error: `reply to thread ${reply.threadId} failed: ${messageOf(error)}`, replied, resolved, skipped };
    }
    replied++;
    if (!reply.resolve) continue;
    try {
      await github.resolveThread(reply.threadId);
    } catch (error) {
      return { ok: false, error: `resolving thread ${reply.threadId} failed: ${messageOf(error)}`, replied, resolved, skipped };
    }
    resolved++;
  }
  return { ok: true, replied, resolved, skipped };
}
