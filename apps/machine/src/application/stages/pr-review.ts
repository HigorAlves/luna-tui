// The reviewing stage of a review PR task: the host fetches the PR's diff, files and the
// comments already on it (the sandbox has no GitHub credential), the pr-reviewer pack answers
// with line-anchored comments and a verdict, and the host posts one COMMENT review at once.
// An approve / request-changes verdict waits at the gate; `postVerdictRunner` posts it on `a`.
import { type DecisionOverrides, type Finding, PrReviewAnswer, type RequestedAction, type ReviewContext, type ReviewLinks, mergeDuplicateFindings } from "@hardness/contracts";

import { type Decide } from "./check-decide.ts";
import { diffExcerptOf } from "./diff-section.ts";
import { dropAlreadyRaised } from "./already-raised.ts";
import { type Recalibrated, recalibrateSeverity } from "./recalibrate.ts";
import { type ComplianceDeps, runCompliance } from "./compliance-review.ts";
import { type DiffFile, type Shard, type Skipped, capShards, parseDiff, shardDiff, splitReviewable } from "./review-diff.ts";
import { shardedSummary } from "./review-summary.ts";
import { PR_DIFF_MOUNT } from "./review-diff-files.ts";
import { type CriterionResult, checkCriteria } from "./criteria-check.ts";
import { type RiskRead, rankShards, readRisk } from "./review-risk.ts";
import { type RereviewDeps, type RereviewPlan, prepareRereview, settledReply } from "./rereview.ts";
import { type HelperDeps, type HelpersOutcome, type PassMount, type PassWorkspace, confirmHelperFindings, runHelpers } from "./review-helpers.ts";
import { followUp } from "./thread-followup.ts";
import { addUsage } from "./usage.ts";
import { excerptOf } from "./verify.ts";
import type { TruthSink } from "../decision-truth.ts";
import { type GitHub, type ReviewPost, messageOf } from "../github.ts";
import type { ApprovalRow } from "../../domain/task.ts";
import type { Jira } from "../jira.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type LinkableCard, type PrLinkDeps, type PrLinks, linkReview } from "../pr-link.ts";
import { type ThreadMemory, keepThreadDecisions } from "../review-truth.ts";
import { readTickets } from "../review-tickets.ts";

export interface PrReviewDeps {
  github: GitHub;
  /** The PR's diff from host git in the card's workspace (base fetched, merge base, diff), which has no size limit; GitHub refuses diffs over 20,000 lines. Absent, or when it throws, GitHub's diff is read and the reason is kept in `detail.diffNote`. */
  localDiff?: (opts: { repoPath: string; baseRef: string; worktree: string }) => Promise<string>;
  /** Runs the reviewing pack with what the host fetched; in a workspace of its own when a shard of a big PR is read. */
  runPack: (context: StageContext, review: ReviewContext, workspace?: PassWorkspace) => Promise<StageResult>;
  /** What a review may read in one reviewer's prompt (luna.yaml `review.shard_lines`, `review.max_shards`), per repo; absent, 4000 lines and 25 shards. */
  limits?: (repoPath: string | null) => Promise<{ shardLines: number; maxShards: number }>;
  /** The big PR's diff as files for the passes and the compliance lead (a folder the machine owns, mounted read-only); absent, a sharded PR's passes are skipped with a note. */
  diffFiles?: { write: (runId: string, files: readonly DiffFile[], whole: string) => Promise<{ host: string }>; remove: (host: string) => void | Promise<void> };
  /** The security, migration, infrastructure and second-opinion passes, run on every PR after the main review; absent runs none. `decide` (read at call time) asks finding_confirm about what only a pass found; null keeps those findings unchecked. */
  helpers?: HelperDeps & {
    decide: Decide | null;
    /** The repo's decision overrides (luna.yaml `policy.decisions`); absent, none. */
    decisions?: (repoPath: string | null) => Promise<Record<string, DecisionOverrides>>;
  };
  /** Re-reviewing a PR we reviewed before (by this login): the delta since that review, and our open threads settled by `thread_settle` or answered by the reviewer. Absent, every review reads the whole diff. */
  rereview?: RereviewDeps;
  /** The compliance review beside this one, only when the machine has a wiki to read controls from; it runs when the repo declares regimes. */
  compliance?: ComplianceDeps;
  /** The Jira port, only when Jira is configured: the tickets the PR names are read and the reviewer checks the diff against them. */
  jira?: Jira | null;
  /** The Jira projects the machine knows for a repo checkout; absent, or none, accepts any project key. */
  projects?: (repoPath: string | null) => Promise<readonly string[]>;
  /** The board cards and tickets the PR is linked to (by fact, else by the `pr_link` decision); absent, only the keys the PR names are read. */
  links?: PrLinkDeps & {
    /** Told once a review has passed with what it was linked to: the review's own card keeps it and each linked card logs the review. Never fails a review. */
    record?(taskId: string, links: ReviewLinks, pr: { url: string; number: number; repo: string }): Promise<void>;
  };
}

/** A card's description as the reviewer reads it: capped, the data block quotes the rest. */
const CARD_DESCRIPTION_CAP = 4000;
const cardOf = (c: LinkableCard) => ({ id: c.id, title: c.title, criteria: c.criteria, description: c.description.trim().slice(0, CARD_DESCRIPTION_CAP) });

/** What a re-review posts on one of our threads: a reply, and whether the thread is resolved after it. `by` says who settled it (the decision's templated reply, or the reviewer's own); `settled` is the decision's reason. */
export interface ThreadReply {
  threadId: string;
  body: string;
  resolve: boolean;
  by: "decision" | "reviewer";
  settled?: "fixed" | "reply_holds";
  /** The thread_settle record that resolved the thread, for what happens to it later. */
  settleRecord?: string;
  severity?: string;
  path: string | null;
  line: number | null;
}

/** "Acceptance criteria: 3 of 4 met, 1 not met.": what the checklist says in the review's body; empty when none was checked. */
function criteriaLine(results: readonly CriterionResult[] | undefined): string {
  const checked = (results ?? []).filter((r) => r.verdict !== "unchecked");
  if (checked.length === 0) return "";
  const count = (v: CriterionResult["verdict"]) => checked.filter((r) => r.verdict === v).length;
  const parts = [`${count("met")} of ${checked.length} met`, ...(count("unmet") > 0 ? [`${count("unmet")} not met`] : []), ...(count("unsure") > 0 ? [`${count("unsure")} unclear`] : [])];
  // The criteria that are not met, or unclear, are named here: their findings carry no line comment, since no line of the diff is theirs.
  const named = (v: CriterionResult["verdict"]) => checked.filter((r) => r.verdict === v).map((r) => `"${r.criterion.replace(/\s+/g, " ").slice(0, 160)}" (${r.source})`).join(", ");
  const unmet = count("unmet") > 0 ? ` Not met: ${named("unmet")}.` : "";
  const unclear = count("unsure") > 0 ? ` Unclear: ${named("unsure")}.` : "";
  return `Acceptance criteria: ${parts.join(", ")}.${unmet}${unclear}`;
}

const EVENT_OF = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;

/** The review event from the set of severities, as orc's review-contract defines it: no finding approves; a bug, a
 *  security, an api-surface or a test finding requests changes; anything else (suggestion, question, nit) comments. */
export function verdictOf(findings: ReadonlyArray<{ severity: string }>): "approve" | "request_changes" | "comment" {
  if (findings.length === 0) return "approve";
  const blocking = new Set(["bug", "security", "api-surface", "test"]);
  return findings.some((f) => blocking.has(f.severity)) ? "request_changes" : "comment";
}

/** "2 bugs, 1 suggestion": a list of findings by severity, gravest first. */
function severityCounts(findings: ReadonlyArray<{ severity: string }>): string {
  const by = new Map<string, number>();
  for (const f of findings) by.set(f.severity, (by.get(f.severity) ?? 0) + 1);
  return [...by].sort((a, b) => (SEVERITY_RANK[a[0]] ?? 9) - (SEVERITY_RANK[b[0]] ?? 9)).map(([s, n]) => `${n} ${s}${n === 1 || s === "api-surface" ? "" : "s"}`).join(", ");
}

/** inline-review's cap: more than this erodes signal, so the lowest severities stay in findings only. */
export const MAX_INLINE_COMMENTS = 15;
const SEVERITY_RANK: Record<string, number> = { security: 0, bug: 1, "api-surface": 2, test: 3, suggestion: 4, question: 5, nit: 6 };

/** The comments to post: at most `MAX_INLINE_COMMENTS`, the gravest findings first, the pack's order otherwise. */
export function capComments<T extends { path: string; line: number }>(comments: T[], findings: Array<{ path: string; line: number; severity: string }>): T[] {
  if (comments.length <= MAX_INLINE_COMMENTS) return comments;
  const rank = (c: T) => {
    const found = findings.find((f) => f.path === c.path && f.line === c.line);
    return SEVERITY_RANK[found?.severity ?? ""] ?? 9;
  };
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, MAX_INLINE_COMMENTS)
    .map(({ c }) => c);
}

export { diffExcerptOf };

/** The PR a task came from, or null when the task is not a PR task. */
export function prOf(context: StageContext): { repo: string; number: number; url: string } | null {
  const source = context.task.source;
  return source?.kind === "github_pr" ? { repo: source.repo, number: source.number, url: source.url } : null;
}

/** The PR's facts as the review and address packs read them. Throws when GitHub no longer shows it. */
export async function gatherPr(github: GitHub, repo: string, number: number): Promise<ReviewContext["pr"]> {
  const node = await github.prFacts(repo, number);
  if (!node) throw new Error(`${repo}#${number} is gone from GitHub`);
  return {
    repo,
    number,
    url: node.url,
    title: node.title,
    body: node.body ?? null,
    author: node.author?.login ?? "ghost",
    baseRef: node.baseRefName,
    headRef: node.headRefName,
  };
}

/** What the review keeps of its links: the tickets that were read (with how they were found), the cards, and the suggestion; null when there is nothing to show. */
export function reviewLinksOf(links: PrLinks, tickets: ReadonlyArray<{ key: string; url: string; summary: string }>): ReviewLinks | null {
  const jira = links.jira.flatMap((j) => {
    const t = tickets.find((x) => x.key === j.key);
    return t ? [{ key: t.key, url: t.url, summary: t.summary, how: j.how }] : [];
  });
  const cards = links.cards.map((l) => ({ id: l.card.id, title: l.card.title, how: l.how, ...(l.fact ? { fact: l.fact } : {}) }));
  if (jira.length === 0 && cards.length === 0 && !links.suggestion) return null;
  return { at: new Date().toISOString(), jira, cards, ...(links.suggestion ? { suggestion: links.suggestion } : {}) };
}

const fileEntryOf = (f: DiffFile): ReviewContext["files"][number] => ({ path: f.path, additions: f.additions, deletions: f.deletions, ...(f.previousPath ? { previousPath: f.previousPath } : {}) });

/** The PR's diff: host git first (whole, whatever its size), GitHub's as the fallback with the reason kept. Throws with both reasons when neither reads it. */
async function readDiff(deps: PrReviewDeps, context: StageContext, pr: { repo: string; number: number }, baseRef: string): Promise<{ diff: string; source: "local" | "github"; note?: string }> {
  const repoPath = context.task.repoPath ?? null;
  const worktree = context.task.worktreePath ?? null;
  let note: string | undefined;
  if (deps.localDiff && repoPath && worktree) {
    try {
      return { diff: await deps.localDiff({ repoPath, baseRef, worktree }), source: "local" };
    } catch (error) {
      note = `host git could not make the diff (${messageOf(error)}); GitHub's was read`;
      console.warn(`review: ${note}`);
    }
  }
  try {
    return { diff: await deps.github.prDiff(pr.repo, pr.number), source: "github", ...(note ? { note } : {}) };
  } catch (error) {
    throw new Error(note ? `${messageOf(error)}; ${note}` : messageOf(error));
  }
}

type Answer = (typeof PrReviewAnswer)["_output"];
const DEFAULT_LIMITS = { shardLines: 4000, maxShards: 25 };
/** What a shard's diff may weigh in characters: the prompt carries a PR's text up to 200,000, with the files and comments beside it. */
const SHARD_CHARS = 150_000;
/** The most shards run at once. */
const SHARD_CONCURRENCY = 4;

/** Adds up lines per path, in the order paths first appear. */
const mergeLines = (rows: ReadonlyArray<{ path: string; lines: number }>): Array<{ path: string; lines: number }> => {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.path, (by.get(r.path) ?? 0) + r.lines);
  return [...by].map(([path, lines]) => ({ path, lines }));
};

/**
 * Runs the main reviewer once per shard, at most four at once, each in a clone of its own when the machine can make one (one after another in
 * the card's folder when it cannot), and merges what they answer into one answer. A shard that fails, escalates, cannot get its clone or answers
 * badly leaves its files unreviewed; when no shard answered, the first shard's own result is the stage's.
 */
async function runShards(
  deps: PrReviewDeps,
  context: StageContext,
  review: ReviewContext,
  shards: readonly Shard[],
): Promise<{ result: StageResult; failed: Array<{ path: string; lines: number }>; failedShards: number; failures: Array<{ shard: number; files: number; reason: string }> }> {
  const maker = deps.helpers?.workspace;
  const limit = maker ? Math.min(SHARD_CONCURRENCY, shards.length) : 1;
  const outcomes: Array<{ result: StageResult; answer: Answer | null; note?: string }> = new Array(shards.length);
  const threads = review.rereview?.threads ?? [];
  const inShard = (shard: Shard, path: string | null): boolean => path !== null && shard.parts.some((p) => p.path === path);
  // A thread goes to the shard that holds its file; one whose file is in no shard (or none) goes to the first.
  const owner = (path: string | null): Shard => shards.find((s) => inShard(s, path)) ?? shards[0]!;
  const routed = (shard: Shard): NonNullable<ReviewContext["rereview"]>["threads"] => threads.filter((t) => owner(t.path) === shard);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < shards.length; i = next++) {
      const shard = shards[i]!;
      const sub: StageContext = { ...context, runId: `${context.runId}-shard-${shard.index}`, started: undefined, resume: undefined, engine: undefined };
      const shardReview: ReviewContext = {
        ...review,
        diff: shard.parts.map((p) => p.text).join(""),
        shard: { n: shard.index, of: shards.length },
        ...(review.rereview ? { rereview: { ...review.rereview, threads: routed(shard) } } : {}),
      };
      let made: PassWorkspace | undefined;
      try {
        if (maker) made = await maker.make(sub, `shard-${shard.index}`);
        const result = await deps.runPack(sub, shardReview, made);
        const parsed = result.outcome === "pass" ? PrReviewAnswer.safeParse(result.detail?.answer) : null;
        outcomes[i] = { result, answer: parsed?.success ? parsed.data : null, ...(parsed && !parsed.success ? { note: `its answer does not parse: ${parsed.error.message}` } : {}) };
      } catch (error) {
        outcomes[i] = { result: { outcome: "fail", detail: { error: messageOf(error) } }, answer: null, note: messageOf(error) };
      } finally {
        if (made) await Promise.resolve(maker!.remove(made)).catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));

  const failed: Array<{ path: string; lines: number }> = [];
  const answers: Answer[] = [];
  let usage: StageResult["usage"];
  outcomes.forEach((o, i) => {
    usage = addUsage(usage, o.result.usage);
    if (o.answer) answers.push(o.answer);
    else for (const p of shards[i]!.parts) failed.push({ path: p.path, lines: p.lines });
  });
  const failedShards = outcomes.filter((o) => !o.answer).length;
  // Why each part gave no answer, kept on the stage and said on the card: a part that fails is never silent.
  const failures = outcomes.flatMap((o, i) => (o.answer ? [] : [{ shard: shards[i]!.index, files: shards[i]!.parts.length, reason: (o.note ?? String(o.result.detail?.error ?? o.result.outcome)).slice(0, 300) }]));
  for (const f of failures) await context.note?.(`review part ${f.shard} of ${shards.length} (${f.files} files) gave no answer: ${f.reason}`).catch(() => {});
  if (answers.length === 0) {
    const first = outcomes[0]!;
    const result = first.result.outcome === "pass" ? { ...first.result, outcome: "fail" as const, detail: { ...first.result.detail, error: `the review answer does not parse: ${first.note ?? "no shard answered"}` } } : first.result;
    return { result, failed, failedShards, failures };
  }
  const findings = mergeDuplicateFindings(answers.flatMap((a) => a.findings));
  const seen = new Set<string>();
  const comments = answers.flatMap((a) => a.comments).filter((c) => {
    const key = `${c.path}:${c.line}:${c.side ?? "RIGHT"}:${c.body}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const merged: Answer = {
    verdict: verdictOf(findings),
    summary: answers.map((a) => a.summary.trim()).filter(Boolean).join(" "),
    findings,
    comments,
    ...(answers.some((a) => a.threads?.length) ? { threads: answers.flatMap((a) => a.threads ?? []) } : {}),
  };
  return { result: { outcome: "pass", ...(usage ? { usage } : {}), detail: { answer: merged, summary: merged.summary } }, failed, failedShards, failures };
}

export function prReviewRunner(deps: PrReviewDeps): StageRunner {
  const { github } = deps;
  return async (context) => {
    const cleanups: Array<() => void | Promise<void>> = [];
    try {
      return await reviewPr(context, cleanups);
    } finally {
      for (const c of cleanups) await Promise.resolve(c()).catch(() => {});
    }
  };

  async function reviewPr(context: StageContext, cleanups: Array<() => void | Promise<void>>): Promise<StageResult> {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    let review: ReviewContext;
    let links: PrLinks;
    let diffSource: "local" | "github" = "github";
    let diffNote: string | undefined;
    let skipped: Skipped[] = [];
    try {
      const [facts, existingComments] = await Promise.all([gatherPr(github, pr.repo, pr.number), github.prComments(pr.repo, pr.number)]);
      const read = await readDiff(deps, context, pr, facts.baseRef);
      diffSource = read.source;
      diffNote = read.note;
      // The files come from the diff itself (GitHub's file list stops at 3000 files), minus what nobody reviews.
      const split = splitReviewable(parseDiff(read.diff));
      const diff = split.reviewable.map((f) => f.text).join("");
      const files = split.reviewable.map(fileEntryOf);
      skipped = split.skipped;
      review = { pr: facts, diff, files, existingComments, ...(skipped.length > 0 ? { skipped } : {}) };
      const repoPath = context.task.repoPath ?? null;
      // What the PR is the work of: the keys it names, the cards that match by a recorded fact and, when nothing does, the decision's pick.
      links = await linkReview(
        { links: deps.links ?? { cards: async () => [], prUrls: async () => [] }, ...(deps.jira ? { jira: deps.jira } : {}), ...(deps.projects ? { projects: () => deps.projects!(repoPath) } : {}) },
        { pr: facts, files: files.map((f) => f.path), repoPath, selfId: context.task.id },
      );
      // A ticket that cannot be read is skipped inside readTickets: Jira never fails a review. A ticket a linked card carries is read like a named one.
      if (deps.jira) review.tickets = await readTickets(deps.jira, links.jira.map((j) => j.key));
      if (links.cards.length > 0) review.cards = links.cards.map((l) => cardOf(l.card));
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }

    // A PR we reviewed before is reviewed again on what changed since, and our open threads are settled first. Anything unreadable falls back to the whole diff.
    let plan: RereviewPlan | null = null;
    const cardPath = context.task.worktreePath ?? null;
    if (deps.rereview && cardPath) {
      try {
        plan = await prepareRereview(deps.rereview, github, { taskId: context.task.id, repo: pr.repo, number: pr.number, worktree: cardPath, repoPath: context.task.repoPath ?? null, baseRef: review.pr.baseRef, fullDiff: review.diff, log: (line) => console.warn(`review: ${line}`) });
      } catch (error) {
        console.warn(`review: could not prepare a re-review of ${pr.url} (${messageOf(error)}); reviewing the whole diff`);
      }
    }
    // The passes and the compliance lead read the diff only; the threads are the main reviewer's.
    if (plan) {
      // What the reviewers read is the delta, minus what nobody reviews there as well.
      const delta = splitReviewable(parseDiff(plan.diff));
      plan = { ...plan, diff: delta.reviewable.map((f) => f.text).join("") };
      skipped = delta.skipped;
      const { skipped: _all, ...rest } = review;
      review = { ...rest, ...(skipped.length > 0 ? { skipped } : {}) };
    }
    const shared: ReviewContext = plan ? { ...review, diff: plan.diff } : review;
    if (plan) review = { ...shared, rereview: plan.rereview };

    // No commit since the review we read: there is no new code, so no pass runs and no new finding is made; the reviewer runs only for a thread
    // that still needs a first answer at this head.
    const quiet = plan?.quiet === true;
    const noise = plan?.noise === true;
    // Noise (a thanks, a merge of the base, a CI-only change) settles our threads and nothing more: no reviewer runs for an unsettled one.
    const reviewerNeeded = !noise && (!quiet || plan!.rereview.threads.some((t) => t.settle === "unsettled" || t.settle === "question"));
    const silent: StageResult = { outcome: "pass", detail: { answer: { verdict: "comment", summary: "", findings: [], comments: [] } } };
    // A diff too big for one reviewer is read in shards by module; the passes and the compliance lead read the whole PR once, as files.
    const limits = (await deps.limits?.(context.task.repoPath ?? null).catch(() => null)) ?? DEFAULT_LIMITS;
    const readable = parseDiff(shared.diff);
    const diffLines = readable.reduce((n, f) => n + f.lines, 0);
    const sharded = diffLines > limits.shardLines;
    const passNotes: string[] = [];
    let diffMount: PassMount | null = null;
    if (sharded) {
      if (deps.diffFiles) {
        try {
          const written = await deps.diffFiles.write(context.runId, readable, shared.diff);
          cleanups.push(() => deps.diffFiles!.remove(written.host));
          diffMount = { host: written.host, container: PR_DIFF_MOUNT, readOnly: true };
        } catch (error) {
          passNotes.push(`the review passes were skipped: this pull request is too big to carry in a prompt and its diff files could not be written (${messageOf(error)})`);
        }
      } else if (deps.helpers) {
        passNotes.push("the review passes were skipped: this pull request is too big to carry in a prompt and the machine has no folder to hand its diff files in");
      }
    }
    const fileReview: ReviewContext = { ...shared, diff: "", diffDir: PR_DIFF_MOUNT };

    // How deep this review goes: pr_risk reads the files and line counts, and the risk suggests what the reviewer and the passes run on (luna.yaml wins).
    let risk: RiskRead | null = null;
    if (deps.helpers && !quiet && reviewerNeeded && readable.length > 0) {
      const h = deps.helpers;
      const repoPath = context.task.repoPath ?? null;
      risk = await readRisk(
        {
          decide: h.decide,
          decisions: (await h.decisions?.(repoPath).catch(() => ({}))) ?? {},
          policy: (await h.policy?.(repoPath).catch(() => ({}))) ?? {},
          ...(h.engineReady ? { engineReady: (engine) => h.engineReady!(engine, repoPath) } : {}),
          log: (line) => console.warn(`review: ${line}`),
        },
        { title: review.pr.title, files: readable, repoPath },
      ).catch((error) => (console.warn(`review: risk read failed: ${messageOf(error)}`), null));
    }
    // The acceptance criteria of the linked tickets and cards are checked against the whole diff, beside the reviewers; a re-review leaves them to the first review.
    const criteriaRun = deps.helpers && !plan && ((review.tickets?.length ?? 0) > 0 || (review.cards?.length ?? 0) > 0)
      ? (async () => {
          const h = deps.helpers!;
          const repoPath = context.task.repoPath ?? null;
          return checkCriteria({ decide: h.decide, decisions: (await h.decisions?.(repoPath).catch(() => ({}))) ?? {}, log: (line) => console.warn(`review: ${line}`) }, { tickets: review.tickets ?? [], cards: review.cards ?? [], files: readable, repoPath });
        })().catch((error) => (console.warn(`review: the criteria check failed: ${messageOf(error)}`), null))
      : null;
    const mainContext: StageContext = risk?.main ? { ...context, suggested: risk.main } : context;

    // The review passes start with the main review, each in a workspace of its own (they never share the reviewer's folder); runHelpers never throws.
    const helpersRun = deps.helpers && !quiet && (!sharded || diffMount) ? runHelpers(deps.helpers, context, sharded ? fileReview : shared, diffMount ? [diffMount] : undefined, risk?.passes) : null;
    let unreviewed: Array<{ path: string; lines: number }> = [];
    let shardStats: { count: number; reviewed: number; capped: number; failed: number; rankedBy?: string } | null = null;
    let shardFailures: Array<{ shard: number; files: number; reason: string }> = [];
    const mainPromise: Promise<StageResult> = !reviewerNeeded
      ? Promise.resolve(silent)
      : sharded
      ? (async () => {
          const shards = shardDiff(readable, limits.shardLines, SHARD_CHARS);
          // Over the cap, pr_risk scores each part from its paths and line counts; a part it cannot score keeps the path heuristic.
          const h = deps.helpers;
          const scores = h && shards.length > limits.maxShards
            ? await rankShards({ decide: h.decide, decisions: (await h.decisions?.(context.task.repoPath ?? null).catch(() => ({}))) ?? {}, log: (line) => console.warn(`review: ${line}`) }, { title: review.pr.title, shards, repoPath: context.task.repoPath ?? null }).catch(() => new Map<number, number>())
            : new Map<number, number>();
          const capped = capShards(shards, limits.maxShards, scores);
          const ran = await runShards(deps, mainContext, review, capped.kept);
          unreviewed = mergeLines([...capped.unreviewed, ...ran.failed]);
          shardStats = { count: shards.length, reviewed: capped.kept.length - ran.failedShards, capped: shards.length - capped.kept.length, failed: ran.failedShards, ...(scores.size > 0 ? { rankedBy: "jev" } : {}) };
          shardFailures = ran.failures;
          return ran.result;
        })()
      : deps.runPack(mainContext, review);
    const [mainRun, helpersDone] = await Promise.allSettled([mainPromise, helpersRun]);
    if (mainRun.status === "rejected") throw mainRun.reason;
    const pack = mainRun.value;
    if (pack.outcome !== "pass") return pack;
    const parsed = PrReviewAnswer.safeParse(pack.detail?.answer);
    if (!parsed.success) {
      return { ...pack, outcome: "fail", detail: { ...pack.detail, error: `the review answer does not parse: ${parsed.error.message}` } };
    }
    // What only a pass found is checked once more before it joins.
    const worktree = pack.workspace?.worktreePath ?? context.task.worktreePath ?? null;
    const helpers: HelpersOutcome | null = helpersDone.status === "fulfilled" ? helpersDone.value : null;
    let confirmed: Awaited<ReturnType<typeof confirmHelperFindings>> | null = null;
    const excerpt = async (finding: Finding): Promise<string> => (worktree ? await excerptOf(worktree, finding).catch(() => "") : "") || diffExcerptOf(review.diff, finding);
    if (deps.helpers && helpers) {
      const overrides = (await deps.helpers.decisions?.(context.task.repoPath ?? null).catch(() => ({}))) ?? {};
      confirmed = await confirmHelperFindings({ decide: deps.helpers.decide, repoPath: context.task.repoPath ?? null, decisions: overrides, excerpt, log: (line) => console.warn(`review: ${line}`) }, helpers.helpers, parsed.data.findings);
    }
    // An unsure finding is marked (`unsure`) for the gate only: the posted title and comment stay clean.
    const kept = (confirmed?.kept ?? []).map(({ finding, unsure }) => (unsure ? { ...finding, unsure: true } : finding));
    const helperComments = kept.map((f) => ({ path: f.path, line: f.line, side: f.side === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const), body: `${f.title}: ${f.body}` }));
    // The main reviewer's findings are marked the same way when the check doubts them; they are never dropped.
    const mainUnsure = new Set((confirmed?.main ?? []).filter((m) => m.unsure).map((m) => `${m.finding.path}:${m.finding.line}:${m.finding.title}`));
    if (mainUnsure.size > 0) {
      parsed.data.findings = parsed.data.findings.map((f) => (mainUnsure.has(`${f.path}:${f.line}:${f.title}`) ? { ...f, unsure: true } : f));
    }
    // The compliance lead reads the same diff beside the reviewer; its findings join before the verdict, so a high one blocks. It never fails the review.
    const compliance = deps.compliance && !quiet ? await runCompliance(deps.compliance, context, pr.repo, sharded ? (diffMount ? fileReview : null) : shared, diffMount ? [diffMount] : undefined) : null;
    const joined = {
      ...parsed.data,
      summary: [parsed.data.summary, compliance?.summary ? `Compliance: ${compliance.summary}` : ""].filter(Boolean).join(" "),
      findings: [...parsed.data.findings, ...(compliance?.findings ?? [])],
      comments: [...parsed.data.comments, ...(compliance?.comments ?? [])],
    };
    const merged = helpers || compliance ? { ...joined, findings: mergeDuplicateFindings([...joined.findings, ...(confirmed?.agreed ?? []), ...kept]), comments: [...joined.comments, ...helperComments] } : parsed.data;
    // A finding that repeats a comment someone else already left on the PR is dropped, with its line comment.
    let alreadyRaised: Awaited<ReturnType<typeof dropAlreadyRaised>>["dropped"] = [];
    let reviewed = merged;
    if (deps.helpers && !quiet && merged.findings.length > 0 && review.existingComments.length > 0) {
      const overrides = (await deps.helpers.decisions?.(context.task.repoPath ?? null).catch(() => ({}))) ?? {};
      const me = (await github.viewer().catch(() => null))?.login ?? null;
      const raised = await dropAlreadyRaised({ decide: deps.helpers.decide, repoPath: context.task.repoPath ?? null, decisions: overrides, me, log: (line) => console.warn(`review: ${line}`) }, merged.findings, review.existingComments);
      alreadyRaised = raised.dropped;
      if (alreadyRaised.length > 0) {
        const gone = new Set(alreadyRaised.map((d) => `${d.path}:${d.line}`));
        reviewed = { ...merged, findings: raised.kept, comments: merged.comments.filter((c) => !gone.has(`${c.path}:${c.line}`)) };
      }
    }
    // Severity is recalibrated both ways by finding_classify before the verdict is computed; each change is recorded and shown at the gate.
    let recalibrated: Recalibrated[] = [];
    if (deps.helpers && !quiet && reviewed.findings.length > 0) {
      const overrides = (await deps.helpers.decisions?.(context.task.repoPath ?? null).catch(() => ({}))) ?? {};
      const moved = await recalibrateSeverity({ decide: deps.helpers.decide, repoPath: context.task.repoPath ?? null, decisions: overrides, excerpt }, reviewed.findings);
      recalibrated = moved.changes;
      if (recalibrated.length > 0) reviewed = { ...reviewed, findings: moved.findings };
    }
    // With no new code, whatever the reviewer found is about code already reviewed: only its thread answers count.
    const criteria = (await criteriaRun) ?? null;
    // An unmet criterion is a finding (it counts toward the verdict) but no line comment: the body names it.
    const withCriteria = criteria ? { ...reviewed, findings: [...reviewed.findings, ...criteria.findings] } : reviewed;
    const answer = quiet ? { ...withCriteria, findings: [], comments: [] } : withCriteria;
    // Our threads: what the decision settled, what the reviewer resolved, and what stays open. An open thread counts at its severity, and one the reviewer
    // did not answer stays open as a question, so a review never approves past a thread nobody looked at.
    const threadReplies: ThreadReply[] = [];
    const acknowledged: Array<{ threadId: string; recordId: string }> = [];
    const stillOpen: Array<{ severity: string }> = [];
    if (plan) {
      const answered = new Map((parsed.data.threads ?? []).map((t) => [t.threadId, t]));
      for (const t of plan.rereview.threads) {
        const where = { path: t.path, line: t.line };
        // Answered since the review we read and no new commit: left as it is, still open.
        if (t.settle === "answered") {
          stillOpen.push({ severity: "question" });
          continue;
        }
        // An acknowledgement ("will fix") gets no reply: the thread stays open until a later commit addresses it.
        if (t.settle === "acknowledged") {
          const intent = plan.records[t.id]?.intent;
          if (intent) acknowledged.push({ threadId: t.id, recordId: intent });
          stillOpen.push({ severity: "question" });
          continue;
        }
        // A question is answered directly by the reviewer and the thread stays open: only a defect the question exposed counts above question level.
        if (t.settle === "question") {
          const q = answered.get(t.id);
          if (!q) {
            stillOpen.push({ severity: "question" });
            continue;
          }
          const severity = ["bug", "security", "api-surface", "test"].includes(q.severity) ? q.severity : "question";
          threadReplies.push({ threadId: t.id, body: q.body.trim() || "See the code above.", resolve: false, by: "reviewer", severity, ...where });
          stillOpen.push({ severity });
          continue;
        }
        if (t.settle !== "unsettled") {
          threadReplies.push({ threadId: t.id, body: settledReply(t.settle, plan.head), resolve: true, by: "decision", settled: t.settle, ...(plan.records[t.id]?.settle ? { settleRecord: plan.records[t.id]!.settle! } : {}), ...where });
          continue;
        }
        const a = answered.get(t.id);
        if (!a) {
          stillOpen.push({ severity: "question" });
          continue;
        }
        const resolve = a.decision === "resolve";
        threadReplies.push({ threadId: t.id, body: a.body.trim() || (resolve ? "Resolving." : "Still open."), resolve, by: "reviewer", ...(resolve ? {} : { severity: a.severity }), ...where });
        if (!resolve) stillOpen.push({ severity: a.severity });
      }
    }
    // The verdict is the findings' (and the open threads'), never the model's (orc review-contract): any finding keeps a review from approving.
    // What no shard read is said in the summary, and a review never approves past it.
    // A review read in parts gets one body written by the machine for the whole PR: the parts' own summaries each describe a slice.
    const stats = shardStats as { count: number; reviewed: number; capped: number; failed: number; rankedBy?: string } | null;
    const summary = stats
      ? [
          shardedSummary({
            title: review.pr.title,
            parts: { reviewed: stats.reviewed, of: stats.count },
            files: readable.length,
            lines: diffLines,
            skipped: skipped.length,
            findings: [...answer.findings, ...stillOpen],
            against: { tickets: (review.tickets ?? []).map((t) => t.key), cards: (review.cards ?? []).map((c) => c.id.slice(0, 8)) },
            unreviewed,
            capped: stats.capped,
            failed: stats.failed,
          }),
          compliance?.summary ? `Compliance: ${compliance.summary}` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : answer.summary;
    const verdict = verdictOf([...answer.findings, ...stillOpen, ...(unreviewed.length > 0 ? [{ severity: "question" }] : [])]);

    // Nothing is posted here: the review goes out under the person's name, so every verdict, its body and its line
    // comments wait at "post the verdict?" until the person says yes (or edits or drops it).
    const unsureAt = new Set(answer.findings.filter((f) => f.unsure).map((f) => `${f.path}:${f.line}`));
    const comments = capComments(
      answer.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body, ...(unsureAt.has(`${c.path}:${c.line}`) ? { unsure: true } : {}) })),
      answer.findings,
    );
    const commented = new Set(comments.map((c) => `${c.path}:${c.line}`));
    const proposed = new Map((confirmed?.records ?? []).filter((r) => commented.has(`${r.finding.path}:${r.finding.line}`)).map((r) => [`${r.finding.path}:${r.finding.line}`, r.recordId] as const));
    // The sub-runs' cost joins the review's, so the budget and the engine's counters see all of it.
    const usage = addUsage(addUsage(pack.usage, helpers?.usage), compliance?.usage);
    const base = { ...pack, ...(usage ? { usage } : {}), findings: answer.findings };
    const reviewLinks = reviewLinksOf(links, review.tickets ?? []);
    // The body says what the review did. The reviewer's own summary counts only its findings, so what the passes added is said beside it; with no
    // new commit and no reviewer run, the machine says it in one line.
    const settledCount = plan ? plan.rereview.threads.filter((t) => t.settle === "fixed" || t.settle === "reply_holds").length : 0;
    const body = quiet && !reviewerNeeded
      ? `${noise ? "Nothing to review since" : "No new commits since"} our review at ${plan!.rereview.since.slice(0, 7)}. ${settledCount} of ${plan!.rereview.threads.length} of our threads settled; the rest stay open.`
      : [summary, criteriaLine(criteria?.results), !quiet && !stats && kept.length > 0 ? `The review passes found ${kept.length} more: ${severityCounts(kept)}.` : ""].filter(Boolean).join(" ");
    const detail = {
      ...pack.detail,
      summary: body,
      // Which tickets the review was checked against, for the board's Result page.
      ...(review.tickets?.length ? { tickets: review.tickets.map((t) => ({ key: t.key, url: t.url, summary: t.summary })) } : {}),
      // What the review was linked to and how (key | fact | decision), and a suggestion that stayed under the bar.
      ...(reviewLinks ? { links: reviewLinks } : {}),
      verdict,
      diffSource,
      ...(diffNote ? { diffNote } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(helpers
        ? {
            helpers: helpers.helpers.map((h) => {
              const verdicts = confirmed?.verdicts[h.pack];
              const dropped = h.findings.length - (confirmed?.duplicates[h.pack] ?? 0) - (confirmed?.kept.filter((k) => k.pack === h.pack).length ?? 0);
              return { pack: h.pack, ...(h.engine ? { engine: h.engine } : {}), outcome: h.outcome, findings: h.findings.length, ...(verdicts ? { confirm: verdicts } : {}), ...(dropped > 0 ? { dropped } : {}), ...(confirmed?.duplicates[h.pack] ? { alsoFoundByReviewer: confirmed.duplicates[h.pack] } : {}) };
            }),
            ...(helpers.notes.length + passNotes.length > 0 ? { helperNotes: [...helpers.notes, ...passNotes] } : {}),
          }
        : passNotes.length > 0
          ? { helperNotes: passNotes }
          : {}),
      ...(criteria?.results.length ? { criteria: criteria.results } : {}),
      ...(risk ? { risk: { level: risk.level, by: risk.by, applied: risk.applied } } : {}),
      ...(shardStats ? { shards: shardStats } : {}),
      ...(shardFailures.length > 0 ? { shardFailures } : {}),
      ...(unreviewed.length > 0 ? { unreviewed } : {}),
      ...(plan
        ? { rereview: { since: plan.rereview.since, ...(plan.rereview.note ? { note: plan.rereview.note } : {}), settled: plan.rereview.threads.filter((t) => t.settle === "fixed" || t.settle === "reply_holds").length, open: stillOpen.length, threads: plan.rereview.threads.length, ...(plan.worth ? { worth: plan.worth } : {}) } }
        : {}),
      ...(alreadyRaised.length > 0 ? { alreadyRaised } : {}),
      ...(recalibrated.length > 0 ? { recalibrated } : {}),
      ...(confirmed && confirmed.main.length > 0 ? { mainConfirm: confirmed.mainVerdicts } : {}),
      // finding_confirm's record of each finding that reached the gate as a comment: what the person keeps or deletes there is its truth.
      ...(proposed.size > 0 ? { decisions: { finding_confirm: Object.fromEntries(proposed) } } : {}),
      ...(compliance ? { compliance: { regimesRun: compliance.regimesRun, findings: compliance.findings.length, notes: compliance.notes } } : {}),
      ...(parsed.data.verdict !== verdict ? { modelVerdict: parsed.data.verdict } : {}),
      posted: false,
      comments: comments.length,
      reason: "verdict",
    };
    // With no new commit and nothing to say on any thread, no review goes out: the card goes back to watching the PR.
    if (quiet && threadReplies.length === 0) return { ...base, detail: { ...detail, reason: "watching" } };
    if (reviewLinks && deps.links?.record) {
      try {
        await deps.links.record(context.task.id, reviewLinks, { url: pr.url, number: pr.number, repo: pr.repo });
      } catch (error) {
        console.warn(`review: could not record the links of ${pr.url} (${messageOf(error)})`);
      }
    }
    const requested: RequestedAction[] = [
      { kind: "pr_review_post", target: pr.url, payload: { event: EVENT_OF[verdict], body, comments, ...(plan ? { threadReplies, ...(acknowledged.length > 0 ? { acknowledged } : {}) } : {}) } },
    ];
    return { ...base, detail, requested };
  }
}

/** The thread decisions a gate carried that the card keeps: the threads it resolved on a decision's word, and the acknowledgements it left open. */
function memoryOf(payload: Record<string, unknown>): Partial<ThreadMemory> {
  const rows = (key: string): Array<Record<string, unknown>> => (Array.isArray(payload[key]) ? (payload[key] as Array<Record<string, unknown>>) : []);
  return {
    resolved: rows("threadReplies").flatMap((r) => (r.resolve === true && r.by === "decision" && typeof r.threadId === "string" && typeof r.settleRecord === "string" && (r.settled === "fixed" || r.settled === "reply_holds") ? [{ threadId: r.threadId, recordId: r.settleRecord, settle: r.settled }] : [])),
    acknowledged: rows("acknowledged").flatMap((r) => (typeof r.threadId === "string" && typeof r.recordId === "string" ? [{ threadId: r.threadId, recordId: r.recordId }] : [])),
  };
}

/** A comment the person left in the review is a finding they judged real; one that was proposed and is gone from what was posted, one they judged not. Only an approval tells it (a dropped review says nothing of each finding). Never throws. */
async function learnFromPostedComments(truth: TruthSink | undefined, gate: ApprovalRow | undefined, posted: ReadonlyArray<{ path: string; line: number }>, taskId: string): Promise<void> {
  const ids = (gate?.requested as { decisions?: { finding_confirm?: unknown } } | undefined)?.decisions?.finding_confirm;
  if (!truth || ids === null || typeof ids !== "object") return;
  const kept = new Set(posted.map((c) => `${c.path}:${c.line}`));
  for (const [at, recordId] of Object.entries(ids)) {
    if (typeof recordId !== "string") continue;
    const real = kept.has(at);
    await truth.learned({ pack: "finding_confirm", recordId, label: { real: { value: real } }, kind: "person", source: real ? "review_comment_kept" : "review_comment_deleted", taskId }).catch(() => false);
  }
}

/** The review route's `shipping`: posts the review the gate carried (APPROVE, REQUEST_CHANGES or COMMENT) with its line comments. */
export function postVerdictRunner(deps: { github: GitHub; truth?: TruthSink; /** Where the card keeps which threads it resolved or left as acknowledged, for the truth later facts give them. */ stateDir?: string }): StageRunner {
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    const gate = context.approvals.filter((a) => a.kind === "awaiting_ship" && a.decision === "approved").at(-1);
    const actions = (gate?.requested as { actions?: RequestedAction[] } | undefined)?.actions ?? [];
    const post = actions.find((a) => a.kind === "pr_review_post");
    const event = post?.payload.event;
    if (!post || (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT")) {
      return { outcome: "fail", detail: { error: "the gate carried no verdict to post" } };
    }
    const body = typeof post.payload.body === "string" ? post.payload.body : "";
    // The line comments ride on the gate since every review waits for the person; a gate stored before that has none.
    // `unsure` is the gate's mark only; GitHub gets the clean comment.
    const comments = Array.isArray(post.payload.comments) ? (post.payload.comments as Array<ReviewPost["comments"][number] & { unsure?: boolean }>).map(({ unsure: _unsure, ...c }) => c) : [];
    try {
      await deps.github.postReview(pr.repo, pr.number, { event, body, comments });
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
    await learnFromPostedComments(deps.truth, gate, comments, context.task.id);
    // A re-review also answers our own threads, after the review: a reply each, and a resolve where the gate says so.
    const replies = Array.isArray(post.payload.threadReplies)
      ? (post.payload.threadReplies as Array<Record<string, unknown>>).flatMap((r) => (typeof r.threadId === "string" && typeof r.body === "string" && r.body !== "" ? [{ threadId: r.threadId, body: r.body, resolve: r.resolve === true }] : []))
      : [];
    if (replies.length === 0) return { outcome: "pass", detail: { posted: event, prUrl: pr.url } };
    const followed = await followUp(deps.github, replies);
    // What was decided about the threads is kept only when every answer reached GitHub: a stopped follow-up leaves no certain resolve to judge.
    if (followed.ok && deps.stateDir) await keepThreadDecisions(deps.stateDir, context.task.id, memoryOf(post.payload));
    const threads = { replied: followed.replied, resolved: followed.resolved, skipped: followed.skipped };
    if (!followed.ok) {
      // The review is out: failing the stage would escalate it, and a retry posts the whole review again. The card watches the PR next, and
      // the next re-review finds the threads that got no answer still open and answers them.
      const did = `${followed.replied} ${followed.replied === 1 ? "reply" : "replies"} posted, ${followed.resolved} ${followed.resolved === 1 ? "thread" : "threads"} resolved`;
      const threadsError = `the review was posted (${event}), but the thread replies stopped: ${followed.error} (${did} before it)`;
      await context.note?.(`${threadsError}; the next re-review answers the threads left`).catch(() => {});
      return { outcome: "pass", detail: { posted: event, prUrl: pr.url, threads, threadsError } };
    }
    return { outcome: "pass", detail: { posted: event, prUrl: pr.url, threads } };
  };
}
