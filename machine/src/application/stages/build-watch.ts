// The build watch follows an implementing run's /out while its container runs. The container
// cannot push and the machine reads the ledger only after the run, so a slice that turned
// committed is handed to `onCommitted` as it lands.
import { type CheckContext, type DecisionOverrides, type LedgerSlice, Ledger, Slice } from "@hardness/contracts";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { type TruthSink, redCheckTruth, scopeFactsTruth } from "../decision-truth.ts";
import { scopeFacts as diffFacts } from "../../domain/scope-facts.ts";
import { type Decide, judgeCheck } from "./check-decide.ts";
import type { CardHit } from "../../domain/card-search.ts";
import { type AddedLine, type ScopeFacts, addedLinesOf, removedLinesOf, sanitizeFacts, scopeFacts } from "../../domain/scope.ts";

/** The most a request file the container writes may hold: a request is a few lines of JSON. */
export const MAX_MAILBOX_BYTES = 64 * 1024;

/**
 * One request file of the mailbox (`checks/<file>` under the run's `/out`), as text: the container writes there and is not trusted.
 * `checks/` must be a real directory (not a link out), the file a regular file of at most 64 KiB, and it is opened with
 * `O_NOFOLLOW | O_NONBLOCK` so a link swapped in after the check, or a FIFO, is refused rather than followed or waited on.
 * Null for anything else, and for a file that is not there yet.
 */
export async function readMailbox(outDir: string, file: string): Promise<string | null> {
  try {
    const dir = join(outDir, "checks");
    if (!(await lstat(dir)).isDirectory()) return null;
    const path = join(dir, file);
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_MAILBOX_BYTES) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      // What was opened is what was checked: a file swapped in between the lstat and the open is refused here.
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_MAILBOX_BYTES) return null;
      const buffer = Buffer.alloc(MAX_MAILBOX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead > MAX_MAILBOX_BYTES ? null : buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** An answer into the mailbox: `checks/` made if missing but never followed if it is a link, the temp file made new (a leftover, or a link the container planted there, removed first) and renamed over the answer. */
export async function writeMailbox(outDir: string, file: string, content: string): Promise<void> {
  const dir = join(outDir, "checks");
  await mkdir(dir, { recursive: true });
  if (!(await lstat(dir)).isDirectory()) throw new Error("checks/ is not a directory");
  // Right before writing: the real path of checks/ is inside the run's folder.
  const [root, real] = await Promise.all([realpath(outDir), realpath(dir)]);
  if (!real.startsWith(root + sep)) throw new Error("checks/ is outside the run folder");
  const tmp = join(dir, `.${file}.tmp`);
  await rm(tmp, { force: true });
  await writeFile(tmp, content, { flag: "wx" });
  await rename(tmp, join(dir, file));
}

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
  /** Called once per `checks/card-search-request.json` the triage agent writes (a rewritten request is a new one). */
  onCardSearch?: (query: string) => Promise<void>;
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
/** Board searches answered per run: a triage agent that keeps asking is not helped by more. */
export const MAX_CARD_SEARCHES = 5;
/** The tail of a red note a decision sees: the failing lines are at the end, and a note is agent-written. */
export const NOTE_TAIL = 4096;

export function buildWatch(options: BuildWatchOptions): BuildWatch {
  const seen = new Set<number>();
  const reds = new Set<string>();
  const redsPerSlice = new Map<number, number>();
  let scopeRequests = 0;
  let lastRequest = "";
  let lastSearch = "";
  let cardSearches = 0;
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
    const text = await readMailbox(options.outDir, "scope-request.json");
    if (text === null) return;
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

  const searches = async (): Promise<void> => {
    if (!options.onCardSearch) return;
    const text = await readMailbox(options.outDir, "card-search-request.json");
    if (text === null) return;
    if (text === lastSearch) return;
    let query: string;
    try {
      const parsed = JSON.parse(text) as { query?: unknown };
      if (typeof parsed.query !== "string") return;
      query = parsed.query;
    } catch {
      return; // half-written: the next tick retries
    }
    lastSearch = text;
    if (cardSearches >= MAX_CARD_SEARCHES) return;
    cardSearches += 1;
    try {
      await options.onCardSearch(query);
    } catch (error) {
      options.log?.(`build watch: card search: ${(error as Error).message}`);
    }
  };

  const timer = setInterval(() => {
    tick = tick.then(() => (stopped ? undefined : poll().then(requests).then(searches)));
  }, options.every);

  return {
    seen,
    async stop() {
      clearInterval(timer);
      await tick;
      // One last look: a slice committed just before the container exited is still pushed.
      await poll();
      await requests();
      await searches();
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

export type { Decide };

export interface BuildChecksDeps {
  /** The run's `/out` on the host: answers go to `checks/` beside the requests. */
  outDir: string;
  repoPath: string | null;
  worktree: string;
  /** The commit the change is measured from; null when none can be trusted: the scope facts then cannot be computed and the stage fails closed. */
  inputCommit: string | null;
  /** The plan's slices (the planner's objects, as the approved plan carries them) and the files they and the code map name. */
  slices: unknown[];
  planned: string[];
  /** An approved plan exists (the feature route): an empty planned list does not switch the scope check off. */
  planPresent?: boolean;
  /** The tests the tests step committed, by scenario: the scope is measured from that commit, and any change to one of these files is a weakened test. */
  scenarioTests?: { scenario: string; file: string }[];
  /** Every path of the tests commit: none may change without a person. */
  protectedPaths?: string[];
  /** Null when no decision can run: every check is skipped. Read at call time. */
  decide: Decide | null;
  overrides: Record<string, DecisionOverrides>;
  /** Told, once a slice commits, whether each judged red was a right-reason red (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  taskId?: string;
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
    ...no("unrelated_refactors", "the change carries an unrelated refactor: code the plan does not touch was renamed, moved or tidied"),
  ];
}

/** red_check over one check context (a slice's red, or a scenario's in Build's tests step): the verdict, and what a no says is wrong whatever the confidence. */
export async function judgeRedCheck(decide: Decide | null, check: CheckContext, repoPath: string | null, overrides: Record<string, DecisionOverrides>, log: (line: string) => void = () => {}): Promise<CheckAnswer & { recordId?: string }> {
  const { verdict, answer, recordId } = await judgeCheck(decide, "red_check", check, repoPath, overrides, log);
  if (!answer) return { verdict: "skipped", problems: [] };
  const problems = problemsOf("red_check", answer);
  return { verdict: verdict === "proceed" && problems.length > 0 ? "flag" : verdict, problems, ...(recordId ? { recordId } : {}) };
}

/** The machine's side of the mailbox: judges a red slice and a scope request, answers in files the
 *  luna tools wait on, and computes the facts once more over the final diff. */
export function buildChecks(deps: BuildChecksDeps) {
  const log = deps.log ?? (() => {});
  const write = (file: string, answer: CheckAnswer): Promise<void> => writeMailbox(deps.outDir, file, JSON.stringify(answer));
  /** The records of each slice's judged reds, in order: when the slice commits, they say whether the test was rewritten. */
  const redRecords = new Map<number, string[]>();
  let lastRecord: string | undefined;
  const judge = async (pack: "red_check" | "scope_check", check: CheckContext): Promise<CheckAnswer> => {
    const { verdict, answer, recordId } = await judgeCheck(deps.decide, pack, check, deps.repoPath, deps.overrides, log);
    lastRecord = recordId;
    if (!answer) return { verdict: "skipped", problems: [] };
    const problems = problemsOf(pack, answer);
    return { verdict: verdict === "proceed" && problems.length > 0 ? "flag" : verdict, problems };
  };

  const factsFor = async (declared: { path: string }[]): Promise<ScopeFacts> => {
    if (deps.inputCommit === null) throw new Error("there is no commit the card's change can be measured from");
    const [nameStatus, diff] = await Promise.all([deps.git.nameStatus(deps.inputCommit, "HEAD"), deps.git.diff(deps.inputCommit, "HEAD")]);
    const addedLines: AddedLine[] = addedLinesOf(diff);
    return sanitizeFacts(scopeFacts({ nameStatus, addedLines, removedLines: removedLinesOf(diff), planned: deps.planned, declared, planPresent: deps.planPresent === true, ...(deps.scenarioTests?.length ? { scenarioTests: deps.scenarioTests } : {}), ...(deps.protectedPaths?.length ? { protectedPaths: deps.protectedPaths } : {}) }));
  };

  /** The files the implementer declared to scope_check, kept here as the verdict is: the machine took them when they were made, so a final answer that leaves them out does not turn them into undeclared files. */
  let toolDeclared: { path: string; reason: string }[] = [];
  /** The verdict the last scope_check came to, kept here: the answer file lives under /out, which the container can rewrite. */
  let verdict = "skipped";
  /** What the last scope_check's answers found beyond the facts: `unrelated_refactor`. */
  let judgedKinds: string[] = [];

  return {
    async onRed(slice: LedgerSlice): Promise<void> {
      const planned = Slice.safeParse(deps.slices[slice.id - 1]);
      const answer = await judge("red_check", { kind: "red", slice: { id: slice.id, title: slice.title, acceptance: planned.success ? planned.data.acceptance : [] }, output: (slice.note ?? "").slice(-NOTE_TAIL) });
      if (lastRecord) redRecords.set(slice.id, [...(redRecords.get(slice.id) ?? []), lastRecord]);
      await write(`red-${slice.id}.json`, answer);
    },
    /** The slice went green: a red the agent got past by rewriting the test (a later red followed it) was not a right-reason red; the last one was. */
    async onGreen(slice: LedgerSlice): Promise<void> {
      const records = redRecords.get(slice.id) ?? [];
      redRecords.delete(slice.id);
      for (const [at, recordId] of records.entries()) {
        await deps.truth?.learned({ pack: "red_check", recordId, label: redCheckTruth(at < records.length - 1), kind: "fact", source: "slice_green", ...(deps.taskId ? { taskId: deps.taskId } : {}) });
      }
    },
    async onScopeRequest(request: ScopeRequest): Promise<void> {
      toolDeclared = request.outOfMap.filter((f) => typeof f?.path === "string");
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
      // The diff answers four of the six questions by script; a "no" it found says what the answer should have been.
      const scopeRecord = facts ? lastRecord : undefined;
      if (scopeRecord && deps.truth) {
        try {
          const derived = scopeFactsTruth(diffFacts(await deps.git.diff(deps.inputCommit!, "HEAD")));
          if (derived) await deps.truth.learned({ pack: "scope_check", recordId: scopeRecord, label: derived.label, kind: derived.kind, source: derived.source, ...(deps.taskId ? { taskId: deps.taskId } : {}) });
        } catch (error) {
          log(`build checks: scope truth skipped: ${(error as Error).message}`);
        }
      }
      judgedKinds = answer.problems.some((p) => p.includes("unrelated refactor")) ? ["unrelated_refactor"] : [];
      await write("scope.json", { ...answer, ...(facts ? { facts } : {}) });
    },
    /** The authoritative facts, over the final diff, with the files the answer declared. */
    finalFacts: (declared: { path: string }[]) => factsFor([...declared, ...toolDeclared]),
    /** What the last scope_check's answers found beyond the facts, for the issues' severities. */
    async lastJudged(): Promise<string[]> {
      return judgedKinds;
    },
    /** The verdict the last scope_check came to, or "skipped" when the implementer never asked. */
    async lastVerdict(): Promise<string> {
      return verdict;
    },
  };
}

/** The machine's side of `card_search`: runs the search over the board and answers in the mailbox. The container can ask
 *  only for its own repository's cards: the repo comes from the task, never from the request. */
export function cardSearchAnswers(deps: { outDir: string; search: (query: string) => Promise<CardHit[]> }) {
  return {
    async onCardSearch(query: string): Promise<void> {
      const cards = await deps.search(query);
      await writeMailbox(deps.outDir, "card-search.json", JSON.stringify({ verdict: "ok", problems: [], cards }));
    },
  };
}
