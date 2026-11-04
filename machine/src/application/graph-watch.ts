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
      if (this.scheduled.has(repoPath)) return;
      if (!(await this.options.policies.for(repoPath)).graph) return;
      if (await this.options.graph.stampOf(repoPath)) return;
      await this.build(repoPath);
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
        await this.build(repoPath);
      } catch (error) {
        this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Queues a build behind the ones before it; a repo already waiting is not queued twice. */
  private build(repoPath: string): Promise<void> {
    if (this.scheduled.has(repoPath)) return this.queue;
    this.scheduled.add(repoPath);
    this.queue = this.queue.then(async () => {
      try {
        await this.options.graph.build(repoPath);
      } catch (error) {
        this.log(`graph: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.scheduled.delete(repoPath);
      }
    });
    return this.queue;
  }
}
