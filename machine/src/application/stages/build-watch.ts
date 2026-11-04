// The build watch follows an implementing run's /out while its container runs. The container
// cannot push and the machine reads the ledger only after the run, so a slice that turned
// committed is handed to `onCommitted` as it lands.
import { type CheckContext, type DecisionOverrides, type LedgerSlice, Ledger, PACKS, Slice, applyPolicy } from "@hardness/contracts";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type AddedLine, type ScopeFacts, addedLinesOf, scopeFacts } from "../../domain/scope.ts";

export interface BuildWatchOptions {
  /** The run's `/out` folder on the host. */
  outDir: string;
  /** Poll interval in ms. */
  every: number;
  /** Called once per slice that became committed with a commit. */
  onCommitted: (slice: LedgerSlice) => Promise<void>;
  /** Called once per red of a slice that carries a note (a slice that left red and came back is a new red). */
  onRed?: (slice: LedgerSlice) => Promise<void>;
  /** Called once per `checks/scope-request.json` the implementer writes (a rewritten request is a new one). */
  onScopeRequest?: (request: ScopeRequest) => Promise<void>;
  log?: (line: string) => void;
}

/** What the implementer's `scope_check` tool leaves for the machine. */
export interface ScopeRequest {
  diffSummary: string;
  outOfMap: { path: string; reason: string }[];
}

export interface BuildWatch {
  /** Stops polling, reads the ledger one last time and waits for the handlers. */
  stop(): Promise<void>;
  /** The ids of the slices already handed to `onCommitted`. */
  seen: ReadonlySet<number>;
}

/** Reds of one slice judged per run: the first attempt and one rewrite; the rest are the agent's to settle. */
export const MAX_REDS_PER_SLICE = 2;
/** Scope requests judged per run: the first and two fix passes. */
export const MAX_SCOPE_REQUESTS = 3;
/** The tail of a red note a decision sees: the failing lines are at the end, and a note is agent-written. */
export const NOTE_TAIL = 4096;

export function buildWatch(options: BuildWatchOptions): BuildWatch {
  const seen = new Set<number>();
  const reds = new Set<string>();
  const redsPerSlice = new Map<number, number>();
  let scopeRequests = 0;
  let lastRequest = "";
  let stopped = false;
  let tick: Promise<void> = Promise.resolve();

  const poll = async (): Promise<void> => {
    let ledger: Ledger;
    try {
      ledger = Ledger.parse(JSON.parse(await readFile(join(options.outDir, "ledger.json"), "utf8")));
    } catch {
      return; // not written yet, or half-written: the next tick retries
    }
    for (const slice of ledger.slices) {
      if (stopped) return;
      if (slice.status !== "red") {
        for (const key of [...reds]) if (key.startsWith(`${slice.id}:`)) reds.delete(key);
      } else if (options.onRed && slice.note) {
        const key = `${slice.id}:${slice.note}`;
        if (!reds.has(key) && (redsPerSlice.get(slice.id) ?? 0) < MAX_REDS_PER_SLICE) {
          reds.add(key);
          redsPerSlice.set(slice.id, (redsPerSlice.get(slice.id) ?? 0) + 1);
          try {
            await options.onRed(slice);
          } catch (error) {
            options.log?.(`build watch: red ${slice.id}: ${(error as Error).message}`);
          }
        }
      }
      if (slice.status !== "committed" || !slice.commit || seen.has(slice.id)) continue;
      seen.add(slice.id);
      try {
        await options.onCommitted(slice);
      } catch (error) {
        options.log?.(`build watch: slice ${slice.id}: ${(error as Error).message}`);
      }
    }
  };

  const requests = async (): Promise<void> => {
    if (!options.onScopeRequest) return;
    let text: string;
    try {
      text = await readFile(join(options.outDir, "checks", "scope-request.json"), "utf8");
    } catch {
      return;
    }
    if (text === lastRequest) return;
    let request: ScopeRequest;
    try {
      const parsed = JSON.parse(text) as Partial<ScopeRequest>;
      request = { diffSummary: String(parsed.diffSummary ?? ""), outOfMap: Array.isArray(parsed.outOfMap) ? parsed.outOfMap : [] };
    } catch {
      return; // half-written: the next tick retries
    }
    lastRequest = text;
    if (scopeRequests >= MAX_SCOPE_REQUESTS) return;
    scopeRequests += 1;
    try {
      await options.onScopeRequest(request);
    } catch (error) {
      options.log?.(`build watch: scope request: ${(error as Error).message}`);
    }
  };

  const timer = setInterval(() => {
    tick = tick.then(() => (stopped ? undefined : poll().then(requests)));
  }, options.every);

  return {
    seen,
    async stop() {
      clearInterval(timer);
      await tick;
      // One last look: a slice committed just before the container exited is still pushed.
      await poll();
      await requests();
      stopped = true;
    },
  };
}

/** What a check answers: the verdict against the repo's bars, what is wrong whatever the confidence, and the facts. */
export interface CheckAnswer {
  verdict: string;
  problems: string[];
  facts?: ScopeFacts;
}

export type Decide = (pack: "red_check" | "scope_check", check: CheckContext, repoPath: string | null) => Promise<Record<string, unknown>>;

export interface BuildChecksDeps {
  /** The run's `/out` on the host: answers go to `checks/` beside the requests. */
  outDir: string;
  repoPath: string | null;
  worktree: string;
  inputCommit: string;
  /** The plan's slices (the planner's objects, as the approved plan carries them) and the files they and the code map name. */
  slices: unknown[];
  planned: string[];
  /** Null when no decision can run: every check is skipped. Read at call time. */
  decide: Decide | null;
  overrides: Record<string, DecisionOverrides>;
  git: { nameStatus(from: string, to: string): Promise<string>; diff(from: string, to: string): Promise<string> };
  log?: (line: string) => void;
}

const flag = (answer: Record<string, unknown>, question: string): boolean | null => {
  const value = (answer[question] as { value?: boolean } | undefined)?.value;
  return typeof value === "boolean" ? value : null;
};

/** What an answer says is wrong, whatever its confidence: a confident "no" is a finding too. */
function problemsOf(pack: "red_check" | "scope_check", answer: Record<string, unknown>): string[] {
  const no = (question: string, problem: string) => (flag(answer, question) === false ? [problem] : []);
  if (pack === "red_check") {
    return [
      ...no("right_reason", "the test fails for a reason other than the missing behaviour (a typo, an import, a path or a fixture)"),
      ...no("not_tautological", "the test would still pass without the behaviour: it asserts its own setup"),
    ];
  }
  return [
    ...no("planned_or_declared", "a changed file is neither planned nor declared with a reason that justifies it"),
    ...no("no_new_dependency", "the change adds a dependency the plan does not call for"),
    ...no("no_secret_or_pii", "the change adds something that looks like a secret or personal data"),
    ...no("no_test_removed", "the change removes a test"),
    ...no("no_todo", "the change leaves a TODO in place of work"),
  ];
}

/** The machine's side of the mailbox: judges a red slice and a scope request, answers in files the
 *  luna tools wait on, and computes the facts once more over the final diff. */
export function buildChecks(deps: BuildChecksDeps) {
  const log = deps.log ?? (() => {});
  const checksDir = join(deps.outDir, "checks");
  const write = async (file: string, answer: CheckAnswer): Promise<void> => {
    await mkdir(checksDir, { recursive: true });
    const tmp = join(checksDir, `.${file}.tmp`);
    await writeFile(tmp, JSON.stringify(answer));
    await rename(tmp, join(checksDir, file));
  };
  const judge = async (pack: "red_check" | "scope_check", check: CheckContext): Promise<CheckAnswer> => {
    if (!deps.decide) return { verdict: "skipped", problems: [] };
    try {
      const answer = await deps.decide(pack, check, deps.repoPath);
      const { overall } = applyPolicy(PACKS[pack], answer, deps.overrides[pack]);
      const problems = problemsOf(pack, answer);
      return { verdict: overall === "proceed" && problems.length > 0 ? "flag" : overall, problems };
    } catch (error) {
      log(`build checks: ${pack} skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { verdict: "skipped", problems: [] };
    }
  };

  const factsFor = async (declared: { path: string }[]): Promise<ScopeFacts> => {
    const [nameStatus, diff] = await Promise.all([deps.git.nameStatus(deps.inputCommit, "HEAD"), deps.git.diff(deps.inputCommit, "HEAD")]);
    const addedLines: AddedLine[] = addedLinesOf(diff);
    return scopeFacts({ nameStatus, addedLines, planned: deps.planned, declared });
  };

  /** The verdict the last scope_check came to, kept here: the answer file lives under /out, which the container can rewrite. */
  let verdict = "skipped";

  return {
    async onRed(slice: LedgerSlice): Promise<void> {
      const planned = Slice.safeParse(deps.slices[slice.id - 1]);
      const answer = await judge("red_check", { kind: "red", slice: { id: slice.id, title: slice.title, acceptance: planned.success ? planned.data.acceptance : [] }, output: (slice.note ?? "").slice(-NOTE_TAIL) });
      await write(`red-${slice.id}.json`, answer);
    },
    async onScopeRequest(request: ScopeRequest): Promise<void> {
      let facts: ScopeFacts | null = null;
      try {
        facts = await factsFor(request.outOfMap);
      } catch (error) {
        log(`build checks: scope facts unavailable: ${(error as Error).message}`);
      }
      const answer = facts
        ? await judge("scope_check", { kind: "scope", planned: deps.planned, ...facts, declared: request.outOfMap, diffSummary: request.diffSummary })
        : { verdict: "skipped", problems: [] };
      verdict = answer.verdict;
      await write("scope.json", { ...answer, ...(facts ? { facts } : {}) });
    },
    /** The authoritative facts, over the final diff, with the files the answer declared. */
    finalFacts: factsFor,
    /** The verdict the last scope_check came to, or "skipped" when the implementer never asked. */
    async lastVerdict(): Promise<string> {
      return verdict;
    },
  };
}
