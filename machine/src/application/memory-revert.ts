// Revert retirement (RFC 0007, "Forgetting"): when a merged PR reverts a card's PR, what memory learned from that card was
// learned from work the repository has since taken back, so its items are retired. The machine sees the merge as a
// `ship.merged` event; it reads the merged PR's title and body from GitHub and looks for GitHub's revert convention
// (`domain/revert.ts`). A PR that reverts nothing it names, or a card the machine never merged, changes nothing. Idempotent:
// a retired item is not listed again, so a replayed event retires nothing twice.
import type { EventRow } from "../domain/task.ts";
import { revertTargets, revertsNothing } from "../domain/revert.ts";
import type { Memory } from "./memory.ts";
import { ShippedEvent, isShippedKind } from "./ship-loop.ts";

export interface RevertDeps {
  memory: Memory;
  /** The merged PR's title and body (`owner/name`, number); null when GitHub has none (no token, gone). */
  pr(repo: string, number: number): Promise<{ title: string; body: string | null } | null>;
  /** The card that merged this PR or commit; null when none did. */
  cardMergedAs(target: { repo: string; number: number } | { sha: string }): Promise<string | null>;
}

/** `owner/name` and the number of a PR's address, or null for one that is not a GitHub PR. */
export function prOfUrl(url: string): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/i.exec(url);
  return m ? { repo: m[1]!.toLowerCase(), number: Number(m[2]) } : null;
}

export class MemoryReverts {
  constructor(private readonly deps: RevertDeps) {}

  /** Reacts to one logged event; only a merge matters. Never throws: a failure here is a missed retirement, not a failed card. */
  async handle(event: Pick<EventRow, "kind" | "taskId" | "payload">): Promise<number> {
    if (!isShippedKind(event.kind) || !this.deps.memory.enabled) return 0;
    try {
      return await this.retireFor(event);
    } catch (error) {
      console.warn(`memory: revert check of card ${event.taskId} failed:`, error);
      return 0;
    }
  }

  private async retireFor(event: Pick<EventRow, "taskId" | "payload">): Promise<number> {
    const shipped = ShippedEvent.safeParse(event.payload);
    if (!shipped.success) return 0;
    const own = prOfUrl(shipped.data.prUrl);
    if (!own) return 0;
    const pr = await this.deps.pr(own.repo, own.number);
    if (!pr) return 0;
    const targets = revertTargets(pr);
    if (revertsNothing(targets)) return 0;
    const cards = new Set<string>();
    for (const target of targets.prs) {
      const card = await this.deps.cardMergedAs({ repo: target.repo ?? own.repo, number: target.number });
      if (card) cards.add(card);
    }
    for (const sha of targets.shas) {
      const card = await this.deps.cardMergedAs({ sha });
      if (card) cards.add(card);
    }
    // A card never reverts itself: its own merge is not what its PR says it undoes.
    cards.delete(event.taskId);
    let retired = 0;
    for (const card of cards) {
      const items = await this.deps.memory.list({ card, status: ["pending", "active", "stale"], limit: 500 });
      for (const item of items) {
        await this.deps.memory.setStatus(item.id, "retired", `its card's PR was reverted by ${shipped.data.prUrl}`);
        retired += 1;
      }
    }
    return retired;
  }
}
