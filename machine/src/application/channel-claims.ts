// Which repository a Slack channel belongs to: the one known repository whose own `luna.yaml` lists the channel in
// `conversation.channels`. A channel two repositories list has no repository (and is still claimed: someone opted it in).
// The files are read on `refresh()` (each poll); `repoOf` and `claimed` answer from what was last read.
import { FACTORY_DEFAULTS, type FactoryConfig } from "@hardness/contracts";

export interface RepoConversationConfig {
  conversation: FactoryConfig["conversation"];
  scoring: FactoryConfig["scoring"];
}

export class ChannelClaims {
  private byRepo = new Map<string, RepoConversationConfig>();

  constructor(
    private readonly repos: () => Promise<string[]>,
    private readonly configOfRepo: (repoPath: string) => Promise<RepoConversationConfig>,
  ) {}

  /** Reads every known repository's section; one that cannot be read keeps what it said last time. */
  async refresh(): Promise<void> {
    const paths = await this.repos().catch(() => null);
    if (!paths) return;
    const next = new Map<string, RepoConversationConfig>();
    for (const path of [...new Set(paths)]) {
      const read = await this.configOfRepo(path).catch(() => this.byRepo.get(path) ?? null);
      if (read) next.set(path, read);
    }
    this.byRepo = next;
  }

  /** The one repository (its checkout) that lists the channel; null when none or more than one does. */
  repoOf(channel: string): string | null {
    const holders = [...this.byRepo].filter(([, c]) => c.conversation.channels.includes(channel));
    return holders.length === 1 ? holders[0]![0] : null;
  }

  /** Every channel any repository lists. */
  claimed(): Set<string> {
    return new Set([...this.byRepo.values()].flatMap((c) => c.conversation.channels));
  }

  /** A conversation's settings: its repository's `conversation` and `scoring`, else the defaults. */
  configOf(channel: string): RepoConversationConfig {
    const repo = this.repoOf(channel);
    return (repo && this.byRepo.get(repo)) || { conversation: FACTORY_DEFAULTS.conversation, scoring: FACTORY_DEFAULTS.scoring };
  }
}
