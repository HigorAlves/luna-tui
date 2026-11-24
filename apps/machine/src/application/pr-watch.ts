// The PR watch: a PR card that has posted its review or fixed its CI waits in Ship (`pr_watch`) until its PR is merged or closed. On the PR poller's
// interval this loop reads each watched PR through the GitHub port and sends the card one event: `merged` or `closed` ends it, `responded` sends it back
// to the stage its route started with (a re-review, a CI watch, addressing the threads). A response fires only after the PR has been quiet for
// `review.quiet_minutes`, and once per key (the head and the last activity it saw), so a loop-back that changes nothing is not repeated.
import type { TaskRoute } from "@hardness/contracts";

import { summarizeChecks, type CheckRunNode, type StatusContextNode } from "../domain/pull-request.ts";
import { type GitHub, messageOf } from "./github.ts";

/** What the watch needs to know about a card at `pr_watch`. */
export interface WatchedCard {
  id: string;
  route: TaskRoute;
  repoPath: string | null;
  /** The PR the card is about; a card without one is skipped. */
  source: { repo: string; number: number } | null;
  /** When the card entered `pr_watch`: what happened on the PR before it was already dealt with. */
  since: Date;
  /** The key of the last response sent, so the same activity does not fire twice. */
  watchKey?: string;
}

export interface PrWatchPolicy {
  auto_rereview: "on" | "off";
  quiet_minutes: number;
}

export interface PrWatchOptions {
  github: Pick<GitHub, "viewer" | "prMerged" | "prFacts" | "prReviews" | "prThreads">;
  /** The cards waiting at `pr_watch`. */
  watching: () => Promise<WatchedCard[]>;
  /** Sends the card its event (the pipeline applies it). `key` goes with `responded`. */
  send: (id: string, what: "merged" | "closed" | "responded", key?: string) => Promise<unknown>;
  /** The repository's `review.*` keys. */
  policy: (repoPath: string | null) => Promise<PrWatchPolicy>;
  intervalMs?: number;
  now?: () => Date;
  warn?: (message: string, error?: unknown) => void;
}

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export class PrWatch {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running: Promise<void> | null = null;
  private me: string | null = null;
  private readonly now: () => Date;
  private readonly warn: (message: string, error?: unknown) => void;

  constructor(private readonly options: PrWatchOptions) {
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? ((message, error) => console.warn(message, error));
  }

  /** Ticks now, then after each interval. Never throws. */
  start(): void {
    if (this.timer || this.stopped) return;
    const run = () => {
      void this.tick()
        .catch((error: unknown) => this.warn("pr watch: tick failed", error))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(run, this.options.intervalMs ?? 60_000);
          this.timer.unref();
        });
    };
    run();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass over the watched cards; a pass already running is shared. A card whose read fails is skipped, the others go on. */
  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const card of await this.options.watching()) {
      if (!card.source) continue;
      try {
        await this.watch(card, card.source);
      } catch (error) {
        this.warn(`pr watch: ${card.source.repo}#${card.source.number}: ${messageOf(error)}`);
      }
    }
  }

  private async login(): Promise<string> {
    if (!this.me) this.me = (await this.options.github.viewer()).login;
    return this.me;
  }

  private async watch(card: WatchedCard, source: { repo: string; number: number }): Promise<void> {
    const { github } = this.options;
    const state = await github.prMerged(source.repo, source.number);
    if (state.state === "closed") {
      await this.options.send(card.id, state.merged ? "merged" : "closed");
      return;
    }
    const policy = await this.options.policy(card.repoPath);
    if (card.route === "review" && policy.auto_rereview === "off") return;
    const node = await github.prFacts(source.repo, source.number);
    if (!node) return;
    const commit = node.commits.nodes[0]?.commit;
    const head = commit?.oid ?? null;
    const headAt = ms(commit?.committedDate);
    const seen = await this.activity(card, source, { head, headAt, rollup: (commit?.statusCheckRollup?.contexts.nodes ?? []) as Array<CheckRunNode | StatusContextNode> });
    if (seen === null) return;
    // Quiet: nothing newer than the window, so a push in progress or a back-and-forth is let finish first.
    if (this.now().getTime() - seen < policy.quiet_minutes * 60_000) return;
    const key = `${head ?? "?"}:${new Date(seen).toISOString()}`;
    if (key === card.watchKey) return;
    await this.options.send(card.id, "responded", key);
  }

  /** When the PR last did what the card's route waits for, as epoch ms; null when it did not. */
  private async activity(card: WatchedCard, source: { repo: string; number: number }, pr: { head: string | null; headAt: number | null; rollup: Array<CheckRunNode | StatusContextNode> }): Promise<number | null> {
    const { github } = this.options;
    const since = card.since.getTime();
    if (card.route === "ci_fix") return summarizeChecks(pr.rollup).state === "failure" ? (pr.headAt ?? since) : null;
    const me = await this.login();
    if (card.route === "address") {
      const times = (await github.prThreads(source.repo, source.number)).flatMap((t) => t.comments.filter((c) => !same(c.author, me)).map((c) => ms(c.at) ?? 0)).filter((t) => t > since);
      return times.length > 0 ? Math.max(...times) : null;
    }
    // review: against our latest review of the PR.
    const ours = (await github.prReviews(source.repo, source.number)).filter((r) => r.author !== null && same(r.author, me)).sort((a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0)).at(-1);
    if (!ours) return pr.headAt !== null && pr.headAt > since ? pr.headAt : null;
    const reviewedAt = ms(ours.at) ?? since;
    const times: number[] = [];
    if (pr.head && ours.commitId && pr.head !== ours.commitId) times.push(pr.headAt ?? reviewedAt);
    for (const thread of await github.prThreads(source.repo, source.number)) {
      if (!thread.comments[0] || !same(thread.comments[0].author, me)) continue;
      for (const c of thread.comments) if (!same(c.author, me) && (ms(c.at) ?? 0) > reviewedAt) times.push(ms(c.at)!);
    }
    return times.length > 0 ? Math.max(...times) : null;
  }
}
