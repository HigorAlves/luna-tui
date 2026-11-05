// Keeps each repo's code graph at the head of its default branch. The machine has no merge hook,
// so this polls: a tick fetches every known repo's default head and builds the graph of any repo
// whose stamp is older (or missing), one build at a time. A repo whose luna.yaml says
// `policy.graph: off` is left alone. A failed build is logged, never thrown.
import { defaultHead as gitDefaultHead } from "../adapters/git/worktree.ts";
import type { Graph } from "./graph.ts";

export interface GraphWatchOptions {
  graph: Graph;
  /** Every checkout the machine knows: non-terminal tasks' repos and the repo map's remembered ones. */
  repos: () => Promise<string[]>;
  policies: { for(repoPath: string): Promise<{ graph: boolean }> };
  /** The commit `origin/<default>` points at after a fetch. */
  defaultHead?: (repoPath: string) => Promise<string>;
  log?: (message: string) => void;
}

export class GraphWatch {
  private queue: Promise<void> = Promise.resolve();
  private readonly scheduled = new Set<string>();
  /** The head each repo's last build failed at: not tried again until the head moves, so a broken repo does not burn a build every tick. */
  private readonly failed = new Map<string, string>();
  private ticking: Promise<void> | null = null;
  private readonly starting = new Set<Promise<void>>();
  private readonly head: (repoPath: string) => Promise<string>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: GraphWatchOptions) {
    this.head = options.defaultHead ?? gitDefaultHead;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** One pass over every repo; resolves once its builds are done. A pass already running is joined, not doubled. */
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Schedules a first build for a repo with no graph (a task is about to read it); does not wait for it. */
  ensure(repoPath: string): void {
    const starting = (async () => {
      if (this.scheduled.has(repoPath) || this.failed.has(repoPath)) return;
      if (!(await this.options.policies.for(repoPath)).graph) return;
      if (await this.options.graph.stampOf(repoPath)) return;
      await this.build(repoPath, "");
    })().catch((error: unknown) => this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`));
    this.starting.add(starting);
    void starting.finally(() => this.starting.delete(starting));
  }

  /** A card of this repository merged (RFC 0006 D8): rebuild its graph now, whatever the poll has seen; the poll stays as the fallback.
   *  Not tried again until the head moves does not apply here: a merge is new news, so an earlier failure is forgotten. */
  requestRebuild(repoPath: string): void {
    const starting = (async () => {
      if (!(await this.options.policies.for(repoPath)).graph) return;
      this.failed.delete(repoPath);
      await this.build(repoPath, "");
    })().catch((error: unknown) => this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`));
    this.starting.add(starting);
    void starting.finally(() => this.starting.delete(starting));
  }

  /** Resolves once the builds scheduled so far are done. */
  async idle(): Promise<void> {
    await Promise.all(this.starting);
    await this.queue;
  }

  private async pass(): Promise<void> {
    for (const repoPath of await this.options.repos()) {
      try {
        if (!(await this.options.policies.for(repoPath)).graph) continue;
        const head = await this.head(repoPath);
        const stamp = await this.options.graph.stampOf(repoPath);
        if (stamp?.commit === head) continue;
        if (this.failed.get(repoPath) === head) continue;
        await this.build(repoPath, head);
      } catch (error) {
        this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Queues a build behind the ones before it; a repo already waiting is not queued twice. */
  private build(repoPath: string, head: string): Promise<void> {
    if (this.scheduled.has(repoPath)) return this.queue;
    this.scheduled.add(repoPath);
    this.queue = this.queue.then(async () => {
      try {
        await this.options.graph.build(repoPath);
        this.failed.delete(repoPath);
      } catch (error) {
        this.failed.set(repoPath, head);
        this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.scheduled.delete(repoPath);
      }
    });
    return this.queue;
  }
}
