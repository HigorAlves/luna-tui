// The ship monitor: after Ship publishes the pack and readies the PR, this watches the task's own
// PR until it merges. Each poll reads GitHub's facts, the Evidence Pack and the policy; merge
// readiness is a script (domain/merge-readiness.ts), and the merge is sha-guarded and never above
// the policy's risk. A PR a person merges ends the wait the same way. The cursor file lets a
// machine restart resume instead of escalate. Review activity and a red CI are recorded and noted
// here; acting on them is the maintenance loop's.
import { shipSla, quietDays } from "../../domain/ship-sla.ts";
import { PrReplyAnswer, type EvidencePack, type Risk, type ShipContext, type ShipEventClass, type TaskState, eventClassOf } from "@hardness/contracts";

import { HOST_GIT, rebaseOntoDefault } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";

import { lunaYamlFreeze } from "../../adapters/freeze/luna-yaml.ts";
import { type Freeze, type Policy } from "../../domain/policy.ts";
import { shipEvents } from "../../domain/ship-events.ts";
import { ownerApprovals, parseCodeownersChecked, requiredOwners } from "../../domain/codeowners.ts";
import { MAX_DEPENDENCIES, inFreeze, mergeReadiness, parseDependencies } from "../../domain/merge-readiness.ts";
import { type ReviewRule, approvedOnHead, reviewRequirement } from "../../domain/review-rule.ts";
import { fromGraphQl } from "../../domain/pull-request.ts";
import { type GitHub, type PrActivity, type PrReview, messageOf } from "../github.ts";
import type { FreezeSource } from "../freeze.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type ShipCursor, SEEN_CAP, emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";
import { ciContextOf, ciRunIdOf, failedChecks } from "./ci.ts";
import { pushBranch } from "./deliver.ts";
import { type TruthSink, commentIntentTruth, eventClassTruth } from "../decision-truth.ts";
import { type EvidenceHandle, type FixDeps, type ReviewLoop, SECRET_REASON, carriesSecret, escalated, fixRound, headOfWorktree, judgeShip, postable, resetTo, restampPack, subContext } from "./ship-fixes.ts";

const DAY_MS = 86_400_000;
/** The bounds of the loop: fix rounds per thread and per PR, CI re-runs and rebases. Every bound reached asks a person. */
export const MAX_THREAD_FIX_ROUNDS = 2;
export const MAX_PR_FIX_ROUNDS = 3;
export const MAX_CI_RERUNS = 1;
export const MAX_REBASES = 1;
/** Questions answered on one PR; past this a person takes over (a stranger's, or a loop's, appetite for model runs has a limit). */
export const MAX_PR_REPLIES = 10;
/** Comments read by the read step on one PR; past this a person takes over. */
export const MAX_PR_READS = 20;
/** Only these may drive a reply or a fix: GitHub's own word for who the author is to the repo. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** A drafted answer below this confidence is not posted: a person answers. */
const REPLY_MIN_CONFIDENCE = 0.5;
/** Where GitHub reads CODEOWNERS; the monitor reads it at the PR's base branch, never from the PR's own head or the worktree. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
/** A team's members are asked again after this long: a member removed from the team stops counting. */
const TEAM_TTL_MS = 10 * 60_000;

export interface ShipMonitorDeps {
  github: GitHub;
  policies: { for: (repoPath: string | null) => Promise<Policy> };
  /** The Evidence Pack: `load` to watch it; with `save`, `publish` and `store` the loop re-stamps and republishes it after a fix. */
  evidence: EvidenceHandle;
  /** The review loop (slice 5): decisions, sub-run packs and the project's checks. Read at call time, so `decide` can be bound late. Absent, the monitor only notes activity. */
  loop?: ReviewLoop;
  /** The latest finish of a stage on a card (the machine's own `stage_runs` row): the release question reads the finding records Verify kept. */
  latestFinish?: (taskId: string, stage: TaskState) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
  /** Told, when the PR merges, what its outcome says about event_class and comment_intent decisions (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  stateDir: string;
  /** Milliseconds between polls; null: the repository's `ship.poll_minutes` (the machine-wide `MACHINE_SHIP_POLL_INTERVAL`, when set, is passed here as a number and wins). */
  pollMs: number | null;
  /** A bound on the whole wait, for tests; production has none: the quiet clock (`ship.sla.escalate_days`) tells the release owners and the watch goes on. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The Build Report's tests (scenario and file), so a changed test file points to its scenario in a fix's affected set. */
  buildTests?: FixDeps["buildTests"];
  /** The CODEOWNERS text at the PR's base branch, or null; default: the first of the three places the port finds. Tests inject one. */
  readCodeowners?: (slug: string, baseRef: string) => Promise<string | null>;
  /** The freeze calendar; default: the repository's `luna.yaml` `freeze[]`. */
  freeze?: FreezeSource;
  log?: (message: string) => void;
}

export type ShipMonitor = (context: StageContext, pr: { slug: string; number: number; url: string }) => Promise<StageResult>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a poll reads from GitHub, the pack and the policy, and the readiness script's answer on it. */
export interface ShipFacts {
  pr: ReturnType<typeof fromGraphQl>;
  head: string | null;
  pack: EvidencePack | null;
  risk: Risk;
  readiness: ReturnType<typeof mergeReadiness>;
  paths: string[];
  /** The classes GitHub's facts decided at this poll (`shipEvents`). */
  events: ShipEventClass[];
  /** Who answers the release question: `ship.release_owners`, else the CODEOWNERS owners of the PR's paths at the base ref. Facts, never a model's word. */
  releaseOwners: string[];
}

export type ShipFactsDeps = Pick<ShipMonitorDeps, "github" | "policies" | "evidence" | "readCodeowners" | "freeze">;

const defaultReadCodeowners = (github: GitHub) => async (slug: string, baseRef: string): Promise<string | null> => {
  for (const path of CODEOWNERS_PATHS) {
    const text = await github.fileAtRef(slug, baseRef, path);
    if (text !== null) return text;
  }
  return null;
};

/**
 * The facts of one poll: the PR as GitHub shows it now, the pack, the repository's policy, the dependencies, the CODEOWNERS owners and the
 * reviews, and what `mergeReadiness` makes of them. Null when GitHub shows no such PR. The watch (to decide when a merge is due) and the
 * merge (to decide again, at the head GitHub shows then) both read it, so the answer never comes from a stage's memory.
 */
export async function readShipFacts(deps: ShipFactsDeps, context: StageContext, ref: { slug: string; number: number }, cursor: ShipCursor, now: () => Date = () => new Date(), teamCache: Map<string, { at: number; members: string[] | null }> = new Map()): Promise<ShipFacts | null> {
  const { slug, number } = ref;
  const { task } = context;
  const readCodeowners = deps.readCodeowners ?? defaultReadCodeowners(deps.github);
  const node = await deps.github.prFacts(slug, number);
  if (!node) return null;
  const pr = fromGraphQl(node, slug, "", []);
  const head = pr.headSha ?? (await deps.github.prHeadSha(slug, number));
  const pack = await deps.evidence.load(task.id);
  const policy = await deps.policies.for(task.repoPath);
  // No pack fails closed: the highest risk, and the readiness script names the missing pack.
  const risk: Risk = pack?.risk ?? "high";
  // The release question's approval, when a person approved one: the head it was asked about is the one on its own request.
  const askedHead = context.approvals.findLast((a) => a.kind === "awaiting_ship" && a.decision === "approved" && a.requested?.gate === "ship_approval")?.requested?.head;
  const shipApproval = typeof askedHead === "string" ? { head: askedHead } : null;
  const listed = parseDependencies(pr.body);
  const dependencies = await Promise.all(
    listed.slice(0, MAX_DEPENDENCIES).map(async (n) => {
      const dep = await deps.github.prMerged(slug, n).catch(() => null);
      return { number: n, merged: dep?.merged ?? false, closed: dep ? dep.state === "closed" : false };
    }),
  );
  // The calendar is read only through the port; a window the port cannot give counts as frozen (an unreadable date fails closed in `inFreeze`).
  const windows = await (deps.freeze ?? lunaYamlFreeze(deps.policies)).windows(task.repoPath).catch((): Freeze[] => [{ from: "", to: "", reason: "the freeze calendar could not be read" }]);
  const paths = (await deps.github.prFiles(slug, number)).map((f) => f.path);
  const changesCodeowners = paths.some((p) => CODEOWNERS_PATHS.includes(p));
  // The reviews are read once a poll, for the owners and for the approval a fix needs.
  let reviewsRead: Promise<PrReview[]> | null = null;
  const reviewsOf = () => (reviewsRead ??= deps.github.prReviews(slug, number));

  /** Whether the latest review of someone is an approval given on `head`: nothing older counts after a fix. */
  const approvedOn = (onHead: string | null, reviews: PrReview[]): boolean => {
    const latest = new Map<string, PrReview>();
    for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
    return onHead !== null && [...latest.values()].some((r) => r.state === "APPROVED" && r.commitId === onHead);
  };

  /** What the repo's CODEOWNERS still wants: null when it has none. A team the token cannot read stays unresolved. */
  const ownersOf = async (text: string | null) => {
    if (!text) return null;
    const { rules, problems } = parseCodeownersChecked(text);
    const required = requiredOwners(paths, rules);
    if (required.length === 0) return { missing: [], unresolved: problems };
    const reviews = await reviewsOf();
    const latest = new Map<string, (typeof reviews)[number]>();
    for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
    const approvers = [...latest.values()].filter((r) => r.state === "APPROVED" && (r.commitId === null || head === null || r.commitId === head)).map((r) => r.author!);
    const members: Record<string, string[]> = {};
    for (const team of new Set(required.flatMap((r) => r.owners).filter((o) => o.startsWith("@") && o.includes("/")).map((o) => o.slice(1).toLowerCase()))) {
      const cached = teamCache.get(team);
      if (!cached || now().getTime() - cached.at > TEAM_TTL_MS) {
        const [org = "", slugOfTeam = ""] = team.split("/");
        teamCache.set(team, { at: now().getTime(), members: await deps.github.teamMembers(org, slugOfTeam).catch(() => null) });
      }
      const list = teamCache.get(team)!.members;
      if (list) members[team] = list;
    }
    const out = ownerApprovals(required, { approvers, members });
    return { missing: out.missing, unresolved: [...out.unresolved, ...problems] };
  };

  // CODEOWNERS is read once, at the PR's base branch.
  let codeownersText: string | null = null;
  let codeownersError: string | null = null;
  try {
    codeownersText = await readCodeowners(slug, pr.baseRef);
  } catch (error) {
    codeownersError = messageOf(error);
  }
  const owners = await (codeownersError ? Promise.reject(new Error(codeownersError)) : ownersOf(codeownersText)).catch((error: unknown) => ({ missing: [], unresolved: [`CODEOWNERS could not be checked: ${messageOf(error)}`] }));
  // After a fix the loop made, the approval that counts is one on the fix itself: the latest review of each person, on the head.
  const fixApproval = cursor.fixRounds > 0 ? { approved: approvedOn(head, await reviewsOf().catch(() => [])) } : null;
  // Is a review required here, and is a good one on the head? Facts only: the repository's rules, GitHub's own answer, CODEOWNERS at the base ref.
  if (pr.reviewDecision === "REVIEW_REQUIRED") cursor.reviewRequiredSeen = true;
  const rule: ReviewRule = await deps.github.reviewRule(slug, pr.baseRef).catch((error: unknown): ReviewRule => ({ source: "unreadable", why: messageOf(error) }));
  const review = reviewRequirement({ rule, seenRequired: cursor.reviewRequiredSeen === true, owners: codeownersText ? parseCodeownersChecked(codeownersText).rules : null, paths });
  const me = (await deps.github.viewer().catch(() => null))?.login ?? null;
  const onHead = approvedOnHead(await reviewsOf().catch(() => []), head, me);
  const readiness = mergeReadiness({
    pr,
    packSha: pack?.commitSha ?? null,
    policy: { autoMerge: policy.factory.ship.auto_merge, freeze: windows },
    risk,
    now: now(),
    dependencies,
    owners,
    changesCodeowners,
    dependenciesListed: listed.length,
    fixApproval,
    staleDays: policy.factory.ship.stale_days,
    ...(cursor.reverified && head && cursor.reverified.sha === head ? { reverifiedAt: cursor.reverified.at } : {}),
    review,
    approvedOnHead: onHead,
    shipApproval,
  });
  const named = policy.factory.ship.release_owners;
  const fromCodeowners = codeownersText ? [...new Set(requiredOwners(paths, parseCodeownersChecked(codeownersText).rules).flatMap((r) => r.owners))] : [];
  const releaseOwners = (named.length > 0 ? named : fromCodeowners).slice(0, 20);
  const events = shipEvents({ mergeable: pr.mergeable, mergeState: pr.mergeState, frozen: inFreeze(windows, now()) !== null, openDependencies: dependencies.filter((d) => !d.merged && !d.closed).length });
  return { pr, head, pack, risk, readiness, paths, events, releaseOwners };
}

/** The PR merged: the decisions it was waiting on are settled by what happened to their threads. Called wherever a merge is recorded. */
export async function settleDecisions(deps: Pick<ShipMonitorDeps, "github" | "truth" | "stateDir">, taskId: string, cursor: ShipCursor, slug: string, number: number): Promise<void> {
  const pending = cursor.decisions ?? [];
  if (!deps.truth || pending.length === 0) return;
  const open = await deps.github.prThreads(slug, number).catch(() => null);
  for (const d of pending) {
    if (d.pack === "event_class") await deps.truth.learned({ pack: "event_class", recordId: d.recordId, label: eventClassTruth(d.further === true), source: "pr_merged", taskId });
    else if (open && d.threadId && !(cursor.resolvedByMachine ?? []).includes(d.threadId) && !open.some((t) => t.id === d.threadId)) await deps.truth.learned({ pack: "comment_intent", recordId: d.recordId, label: commentIntentTruth(d.choice as "question" | "change_request"), source: "thread_resolved", taskId });
  }
  cursor.decisions = [];
  await saveCursor(deps.stateDir, taskId, cursor);
}

export function shipMonitor(deps: ShipMonitorDeps): ShipMonitor {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const maxWaitMs = deps.maxWaitMs ?? Number.POSITIVE_INFINITY;
  return async (context, ref) => {
    const { task, signal } = context;
    const { slug, number, url } = ref;
    const note = async (text: string) => {
      deps.log?.(text);
      await context.note?.(text).catch(() => {});
    };
    // Per run, so a member removed from a team stops counting after the TTL.
    const teamCache = new Map<string, { at: number; members: string[] | null }>();
    let cursor: ShipCursor = (await loadCursor(deps.stateDir, task.id)) ?? emptyCursor({ slug, number });
    if (cursor.pr.slug !== slug || cursor.pr.number !== number) cursor = { ...emptyCursor({ slug, number }), published: cursor.published };
    cursor.startedAt ??= now().toISOString();
    cursor.lastActivityAt ??= now().toISOString();
    await saveCursor(deps.stateDir, task.id, cursor);

    // ---- The review loop (only with `deps.loop`): activity judged and answered, fixes in place, CI red and conflicts. ----
    type Outcome = { result?: StageResult; moved?: boolean };
    type Facts = ReturnType<typeof fromGraphQl>;
    let me: string | null = null;
    const login = async () => (me ??= (await deps.github.viewer()).login.toLowerCase());
    const settle = () => settleDecisions(deps, task.id, cursor, slug, number);
    const fixDeps = (): FixDeps => ({ github: deps.github, loop: deps.loop!, policies: deps.policies, evidence: deps.evidence, stateDir: deps.stateDir, ...(deps.buildTests ? { buildTests: deps.buildTests } : {}) });
    const runOf = () => deps.loop?.exec ?? realExec;
    const plain = (text: string, cap: number) => postable(text, cap);
    const slugId = (id: string) => id.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    const bump = async (id: string, change: { replies?: number; fixRounds?: number }) => {
      const t = cursor.threads[id] ?? { replies: 0, lastAt: now().toISOString() };
      cursor.threads[id] = { ...t, replies: t.replies + (change.replies ?? 0), fixRounds: (t.fixRounds ?? 0) + (change.fixRounds ?? 0), lastAt: now().toISOString() };
      await saveCursor(deps.stateDir, context.task.id, cursor);
    };
    type Thread = NonNullable<ShipContext["comment"]>["thread"];
    const quoted = (thread: Thread) => {
      const last = thread.comments.at(-1);
      return `${thread.path ?? "the PR"}${thread.line ? `:${thread.line}` : ""}: ${last ? `${last.author}: "${plain(last.body, 300)}"` : "(no comment)"}`;
    };

    /** The review says the plan is wrong: back to the planner, with the thread and what the reader said it asks (flattened by `replanOf`). */
    const replan = (thread: Thread, asks?: string): StageResult =>
      escalated(`the review says the plan is wrong: ${quoted(thread)}`, "plan_wrong", { thread: [...thread.comments.map((c) => `${c.author}: ${c.body}`), ...(asks ? [`The reader's summary of what it asks: ${asks}`] : [])].join("\n").slice(0, 20_000) });

    /** A review comment becomes a question to answer, a change to make or a person's call. */
    const handleComment = async (a: PrActivity, pack: EvidencePack | null): Promise<Outcome> => {
      const mine = await login();
      const author = (a.actor ?? "ghost").toLowerCase();
      const open = await deps.github.prThreads(slug, number);
      let found = open.find((t) => t.comments.some((c) => c.body === a.body && c.at === a.at && c.author.toLowerCase() === author));
      const topLevel = !found && a.kind === "comment";
      if (!found && !topLevel) {
        await note(`the comment from ${a.actor ?? "ghost"} is on no open thread; nothing to answer`);
        return {};
      }
      found ??= { id: a.id, path: null, line: null, comments: [{ author: a.actor ?? "ghost", body: a.body, at: a.at }] };
      const thread: Thread = { id: found.id, path: found.path, line: found.line, comments: found.comments.slice(-50).map((c) => ({ author: c.author, body: c.body.slice(0, 4000), at: c.at })) };
      const answered = Object.values(cursor.threads).reduce((sum, t) => sum + t.replies, 0);
      if (answered >= MAX_PR_REPLIES) return { result: escalated("ten questions answered on this PR; a person takes over") };
      const myReplies = Math.max(found.comments.filter((c) => c.author.toLowerCase() === mine).length, cursor.threads[thread.id]?.replies ?? 0);
      if (myReplies >= 2) return { result: escalated(`third round trip on ${thread.path ?? "the PR"}: ${quoted(thread)}`) };
      const reads = cursor.reads ?? 0;
      if (reads >= MAX_PR_READS) return { result: escalated(`${MAX_PR_READS} comments read on this PR; a person takes over`) };
      cursor.reads = reads + 1;
      await saveCursor(deps.stateDir, task.id, cursor);
      const ship: ShipContext = {
        kind: "comment",
        comment: { thread, pack: { summary: pack?.summary ?? "", scenarios: (pack?.scenarios ?? []).map((s, i) => ({ id: `s${i + 1}`, text: s.text, result: s.result })), howToVerify: pack?.howToVerify ?? "" }, myReplies },
      };
      // The read step: the pack reads the thread against the pack, the plan and the diff before anything is decided. A failed read leaves the reading out.
      const ran = await deps.loop!.runPack("pr_reply", subContext(context, `read-${slugId(a.id)}`), ship);
      const read = ran.outcome === "pass" ? PrReplyAnswer.safeParse(ran.detail?.answer) : null;
      const named = read?.success ? (read.data.scenarios ?? []) : [];
      if (read?.success && (read.data.asks || read.data.proposedFix)) ship.comment!.reading = { asks: plain(read.data.asks ?? "", 300), proposedFix: plain(read.data.proposedFix ?? "", 600) };
      const intent = await judgeShip(fixDeps(), "comment_intent", ship, task.repoPath);
      if (!intent.ok) return { result: escalated(`a review comment needs a person (${intent.reason}): ${quoted(thread)}`) };
      if (intent.choice === "question") {
        const drafted = read;
        if (!drafted?.success) return { result: escalated(`a question needs a person: no usable answer was drafted: ${quoted(thread)}`) };
        if (carriesSecret(drafted.data.reply)) return { result: escalated(SECRET_REASON) };
        const text = postable(drafted.data.reply);
        if (drafted.data.confidence < REPLY_MIN_CONFIDENCE || !text) return { result: escalated(`a question needs a person: the drafted answer is not confident enough: ${quoted(thread)}`) };
        try {
          // A reply never resolves the thread: the reviewer does.
          if (topLevel) await deps.github.commentOnIssue(slug, number, text);
          else await deps.github.replyToThread(thread.id, text);
        } catch (error) {
          return { result: escalated(`the answer could not be posted: ${messageOf(error)}`) };
        }
        await bump(thread.id, { replies: 1 });
        if (intent.recordId) cursor.decisions = [...(cursor.decisions ?? []), { pack: "comment_intent", recordId: intent.recordId, choice: "question", threadId: thread.id }];
        await note(`answered ${a.actor ?? "ghost"}'s question from the pack`);
        return {};
      }
      if (intent.choice === "disagreement") return { result: escalated(`a reviewer disagrees: ${quoted(thread)}`) };
      if (intent.choice !== "change_request" && intent.choice !== "nit") return { result: escalated(`a review comment needs a person: ${quoted(thread)}`) };
      // A nit is sized like any other change request: it can still need a new plan.
      const sized = await judgeShip(fixDeps(), "fix_scope", ship, task.repoPath);
      if (!sized.ok) return { result: escalated(`a change request needs a person (${sized.reason}): ${quoted(thread)}`) };
      if (sized.choice === "re_plan") return { result: replan(thread, ship.comment!.reading?.asks) };
      if (sized.choice !== "in_place" && sized.choice !== "re_verify_partial") return { result: escalated(`a change request needs a person: ${quoted(thread)}`) };
      const scope = sized.choice;
      const fixed = await fix({ id: thread.id, threads: [found], scope, summary: `${thread.path ?? "the PR"}: ${plain(a.body, 120)}`, postReplies: !topLevel, quote: quoted(thread), topLevel, named }, pack);
      if (fixed.moved && intent.choice === "change_request" && intent.recordId) cursor.decisions = [...(cursor.decisions ?? []), { pack: "comment_intent", recordId: intent.recordId, choice: "change_request", threadId: thread.id }];
      return fixed;
    };

    /** One bounded fix round; the counters are spent before it runs, so a crash cannot loop. */
    const fix = async (
      round: { id: string; threads: Array<NonNullable<Awaited<ReturnType<GitHub["prThreads"]>>>[number]>; scope: "in_place" | "re_verify_partial"; summary: string; postReplies: boolean; quote: string; topLevel?: boolean; named?: string[] },
      pack: EvidencePack | null,
    ): Promise<Outcome> => {
      if ((cursor.threads[round.id]?.fixRounds ?? 0) >= MAX_THREAD_FIX_ROUNDS) return { result: escalated(`third round trip on ${round.quote}`) };
      if (cursor.fixRounds >= MAX_PR_FIX_ROUNDS) return { result: escalated(`${MAX_PR_FIX_ROUNDS} fix rounds are spent on this PR: ${round.quote}`) };
      cursor.fixRounds++;
      await bump(round.id, { fixRounds: 1 });
      const out = await fixRound(fixDeps(), context, { slug, number, threads: round.threads, scope: round.scope, threadSummary: round.summary, label: String(cursor.fixRounds), postReplies: round.postReplies, pack, named: round.named ?? [] });
      if (!out.ok) return { result: out.result };
      if (out.resolvedTo.length > 0) cursor.resolvedByMachine = [...new Set([...(cursor.resolvedByMachine ?? []), ...out.resolvedTo])];
      if (out.replied > 0) await bump(round.id, { replies: out.replied });
      if (out.note) await note(`a reply could not be posted: ${out.note}`);
      if (out.textNote) await note(out.textNote);
      if (round.topLevel && out.summary) await deps.github.commentOnIssue(slug, number, postable(out.summary)).catch(() => {});
      cursor.published = { sha: out.head };
      if (out.changed) cursor.fixes = [...(cursor.fixes ?? []), { sha: out.head, scope: round.scope, summary: round.summary.slice(0, 300), affected: out.affected ?? [] }].slice(-20);
      await note(out.changed ? `fixed and pushed ${out.head.slice(0, 7)}: ${round.summary}` : `answered without a change: ${round.summary}`);
      return { moved: out.changed };
    };

    /** One review event: classified, then acted on. */
    const handleActivity = async (a: PrActivity, pack: EvidencePack | null): Promise<Outcome> => {
      if (a.actor !== null && a.actor.toLowerCase() === (await login())) return {};
      // Only the repo's own people drive a reply or a fix; a stranger's comment is noted and left, never an escalation (it must not page anyone).
      if (!TRUSTED.has(a.association ?? "")) {
        await note(`skipped a ${a.kind} from ${a.actor ?? "ghost"}: not a collaborator`);
        return {};
      }
      // An approving review with nothing to answer is noted, never asked about.
      if (a.kind === "review" && a.state === "APPROVED" && a.body.trim() === "") {
        await note(`${a.actor ?? "ghost"} approved`);
        return {};
      }
      const body = a.body.slice(0, 2000);
      const event: ShipContext = { kind: "event", event: { actor: a.actor ?? "ghost", isBot: a.isBot, isMe: false, kind: a.kind === "review" ? "review" : "comment", state: a.state, body, url: a.url } };
      const label = `${a.actor ?? "ghost"} ${a.kind}: ${plain(body, 80)}`;
      // A person's word on the PR after an earlier event means that event drew activity.
      if (!a.isBot && TRUSTED.has(a.association ?? "")) for (const d of cursor.decisions ?? []) if (d.pack === "event_class") d.further = true;
      const cls = await judgeShip(fixDeps(), "event_class", event, task.repoPath);
      if (!cls.ok) return { result: escalated(`a review event needs a person (${cls.reason}): ${label}`) };
      // Only two answers are accepted for an activity item; a label read through `eventClassOf` (an old stored one included).
      const klass = eventClassOf(cls.choice);
      if (klass !== "review_comment" && klass !== "noise") return { result: escalated(`a review event needs a person: ${label}`) };
      if (cls.recordId) cursor.decisions = [...(cursor.decisions ?? []), { pack: "event_class", recordId: cls.recordId, choice: klass }];
      // One row per classified item, by its kind and class (enum values, never the reviewer's words).
      await context.emit?.("ship.event", { kind: a.kind, class: klass }).catch(() => {});
      return klass === "noise" ? {} : handleComment(a, pack);
    };

    /** A red CI on the head: the ci_watch pack says what kind of red, then a fix round, one re-run or a person. */
    const watchCi = async (head: string, pack: EvidencePack | null): Promise<Outcome> => {
      const checks = await deps.github.prChecks(slug, head);
      const failed = failedChecks(checks);
      const runIds = [...new Set(failed.map(ciRunIdOf).filter((id): id is string => Boolean(id)))].sort();
      if (failed.length === 0 || runIds.length === 0) return {};
      const key = `${head}:${runIds.join(",")}`;
      if (cursor.ciKey === key && !cursor.ciCycled) return {};
      cursor.ciKey = key;
      cursor.ciCycled = false;
      await saveCursor(deps.stateDir, task.id, cursor);
      // What kind of red this is: a typed decision on data (the job and the log's tail, flattened by the machine); only three answers are accepted.
      const flat = (text: string) => text.replace(/\s+/g, " ").trim();
      const detail = await ciContextOf(deps.github, slug, task.branch ?? "", checks, failed);
      const event: ShipContext = { kind: "event", event: { actor: "ci", isBot: true, isMe: false, kind: "ci", state: "failure", body: plain(failed.map((c) => c.name).join(", "), 500), url: null, job: plain(failed[0]!.name, 200), log: flat(detail.logs ?? "").slice(-4000) } };
      const cls = await judgeShip(fixDeps(), "event_class", event, task.repoPath);
      if (!cls.ok) return { result: escalated(`a red CI needs a person (${cls.reason}): ${plain(failed[0]!.name, 120)}`) };
      const klass = eventClassOf(cls.choice);
      if (cls.recordId) cursor.decisions = [...(cursor.decisions ?? []), { pack: "event_class", recordId: cls.recordId, choice: klass ?? cls.choice }];
      await context.emit?.("ship.event", { kind: "ci", class: klass ?? "noise" }).catch(() => {});
      if (klass === "ci_flaky") {
        const reruns = (await deps.policies.for(task.repoPath)).factory.verify.ci_flaky_reruns;
        if (cursor.ciReruns >= reruns) return { result: escalated(`CI is red again after ${reruns === 1 ? "one re-run" : `${reruns} re-runs`}: ${plain(failed[0]!.name, 120)}`) };
        cursor.ciReruns++;
        await saveCursor(deps.stateDir, task.id, cursor);
        try {
          await deps.github.rerunFailedJobs(slug, runIds[0]!);
        } catch (error) {
          return { result: escalated(`CI looks like a flake but the re-run failed: ${messageOf(error)}`) };
        }
        await note("CI is red and looks like a flake: the failed jobs run again");
        return {};
      }
      if (klass === "base_moved") return baseMoved(head, pack);
      if (klass !== "ci_real") return { result: escalated(`a red CI needs a person: ${plain(failed[0]!.name, 120)}`) };
      // A real failure: ci_watch only describes the fix (its findings); its own verdict is not read.
      const ran = await deps.loop!.runPack("ci_watch", subContext(context, `ci-${slugId(key.slice(0, 12))}-${runIds[0]}`), { ci: detail });
      const answer = ran.detail?.answer && typeof ran.detail.answer === "object" ? (ran.detail.answer as Record<string, unknown>) : {};
      if (ran.outcome !== "pass") return { result: escalated(`CI is red and its cause could not be read: ${plain(String(ran.detail?.error ?? ran.outcome), 300)}`) };
      const summary = plain(String(answer.summary ?? ""), 400);
      const findings = Array.isArray(answer.findings) ? (answer.findings as Array<{ title?: unknown; body?: unknown }>).slice(0, 10).map((f) => `${plain(String(f.title ?? ""), 120)}: ${plain(String(f.body ?? ""), 300)}`) : [];
      const text = [summary, ...findings].filter(Boolean).join("\n");
      const synthetic = { id: "ci", path: null, line: null, comments: [{ author: "ci", body: text.slice(0, 3000), at: now().toISOString() }] };
      // A real failure is sized like any change.
      const ciShip: ShipContext = { kind: "comment", comment: { thread: { id: "ci", path: null, line: null, comments: [{ author: "ci", body: text.slice(0, 3000), at: now().toISOString() }] }, pack: { summary: pack?.summary ?? "", scenarios: (pack?.scenarios ?? []).map((s, i) => ({ id: `s${i + 1}`, text: s.text, result: s.result })), howToVerify: pack?.howToVerify ?? "" }, myReplies: 0 } };
      const sizedCi = await judgeShip(fixDeps(), "fix_scope", ciShip, task.repoPath);
      if (!sizedCi.ok) return { result: escalated(`a red CI needs a person (${sizedCi.reason}): ${plain(summary, 200)}`) };
      if (sizedCi.choice === "re_plan") return { result: replan(ciShip.comment!.thread) };
      if (sizedCi.choice !== "in_place" && sizedCi.choice !== "re_verify_partial") return { result: escalated(`a red CI needs a person: ${plain(summary, 200)}`) };
      return fix({ id: "ci", threads: [synthetic], scope: sizedCi.choice, summary: `CI: ${plain(summary || "a failing check", 120)}`, postReplies: false, quote: `CI: ${plain(summary, 200)}` }, pack);
    };

    /** The base moved and the PR conflicts: rebase once, push with a lease, re-stamp the pack; a second time is a person's. */
    const watchConflict = async (head: string, pack: EvidencePack | null): Promise<Outcome> => {
      const stuck = (why: string): Outcome => ({ result: escalated(why, "other", { verdict: "conflict_unresolvable", options: ["rebase the branch by hand and approve", "merge the default branch into the branch and approve"] }) });
      const rebases = (await deps.policies.for(task.repoPath)).factory.verify.auto_rebase;
      if (cursor.rebases >= rebases) return stuck(`the branch still conflicts with the default branch after ${rebases === 1 ? "one rebase" : `${rebases} rebases`}`);
      const wt = task.worktreePath;
      const branch = task.branch;
      if (!wt || !branch) return stuck("the task has no worktree to rebase");
      const run = runOf();
      const local = await headOfWorktree(run, wt);
      if (!local || local !== head) return { result: escalated("the worktree is not at the PR's head; the branch is not rebased", "head_moved") };
      cursor.rebases++;
      await saveCursor(deps.stateDir, task.id, cursor);
      const rebase = deps.loop?.rebase ?? ((r, w, repo) => rebaseOntoDefault(r, w, repo));
      const result = await rebase(run, wt, task.repoPath ?? wt);
      if (!result.ok) return stuck(result.conflicts.length > 0 ? `the default branch moved and the rebase stops on: ${result.conflicts.join(", ")}` : `the branch conflicts with the default branch and could not be rebased: ${result.error}`);
      const pushError = await pushBranch(run, branch, wt, { force: true, lease: local });
      if (pushError) {
        await resetTo(run, wt, local).catch(() => {});
        return { result: escalated(pushError) };
      }
      const now2 = await headOfWorktree(run, wt);
      if (pack && now2) {
        const stamped = await restampPack(fixDeps(), task.id, slug, number, pack, now2, null, { repoPath: task.repoPath ?? null, emit: context.emit });
        if (!stamped.ok) return { result: escalated(`the branch is rebased (${now2.slice(0, 7)}); ${stamped.reason}, so Evidence runs again`, "head_moved") };
      }
      cursor.published = now2 ? { sha: now2 } : cursor.published;
      await note(`rebased onto the default branch${now2 ? ` (${now2.slice(0, 7)})` : ""}`);
      return { moved: true };
    };

    /** The base moved: rebase while the rebases allowed last; after that the card keeps waiting and the checklist says so. */
    const baseMoved = async (head: string, pack: EvidencePack | null): Promise<Outcome> => {
      const allowed = (await deps.policies.for(task.repoPath)).factory.verify.auto_rebase;
      if (cursor.rebases >= allowed) {
        await note("waiting: the base branch moved and the rebases allowed are spent");
        return {};
      }
      return watchConflict(head, pack);
    };

    /** A stale head, proved once: rebase when the base moved and `verify.auto_rebase` allows (the rebase pushes with a lease and re-stamps the pack), run the project's checks, keep `cursor.reverified`. Failing checks, or a moved base with no rebase left, go to a person. */
    const reverifyStale = async (head: string, pack: EvidencePack | null, baseMoved_: boolean): Promise<Outcome> => {
      const stale = (why: string, extra: Record<string, unknown> = {}): Outcome => ({ result: escalated(`the head is stale: ${why}`, "other", extra) });
      let current = head;
      if (baseMoved_) {
        const allowed = (await deps.policies.for(task.repoPath)).factory.verify.auto_rebase;
        if (cursor.rebases >= allowed) return stale("the base branch moved and the rebases allowed are spent, so it cannot be proved on a current base");
        const out = await watchConflict(head, pack);
        if (out.result) return out;
        const wt = task.worktreePath;
        current = (wt ? await headOfWorktree(runOf(), wt) : null) ?? head;
      }
      if (!deps.loop!.checks) return stale("no checks runner is wired to prove it");
      // On a fresh workspace made from the card's at the head (wave 11a): never in the card's own folder, which a container may have written. `since` is the head itself, an empty delta, which the runner reads as "every check".
      const wt = task.worktreePath;
      const branch = task.branch;
      const freshLoop = deps.loop!.fresh;
      const fresh = freshLoop && wt && branch ? await freshLoop.make(wt, branch, `${context.runId}-stale-${current.slice(0, 7)}`).catch(() => null) : null;
      if (freshLoop && !fresh) return stale("a fresh workspace could not be made to prove it");
      if (fresh && fresh.commit !== current) {
        await freshLoop!.remove(fresh.path).catch(() => {});
        return stale("the fresh workspace is not at the PR's head, so the checks would prove another commit");
      }
      const checkContext = fresh ? { ...context, task: { ...task, worktreePath: fresh.path } } : context;
      let checked: StageResult;
      try {
        checked = await deps.loop!.checks(subContext(checkContext, `stale-${current.slice(0, 7)}`), current);
      } finally {
        if (fresh) await freshLoop!.remove(fresh.path).catch(() => {});
      }
      if (checked.outcome !== "pass") {
        const detail = checked.detail ?? {};
        const findings = Array.isArray(detail.findings) ? (detail.findings as Array<{ title?: unknown; body?: unknown }>).slice(0, 10).map((f) => ({ title: plain(String(f.title ?? ""), 120), body: plain(String(f.body ?? ""), 300) })) : [];
        return stale(`the checks failed over the change (${plain(String(detail.error ?? detail.reason ?? checked.outcome), 300)})`, { findings });
      }
      cursor.reverified = { sha: current, at: now().toISOString() };
      await saveCursor(deps.stateDir, task.id, cursor);
      await note(`the head was ${cursor.reverified.sha.slice(0, 7)} for more than the stale limit: the checks ran over the change and passed`);
      return { moved: true };
    };

    for (;;) {
      if (signal.aborted) return { outcome: "fail", detail: { error: "aborted" } };
      if (now().getTime() - Date.parse(cursor.startedAt!) > maxWaitMs) {
        const days = Math.round(maxWaitMs / DAY_MS);
        return { outcome: "escalated", detail: { escalation: "other", reason: `the PR has waited ${days} days`, options: [] } };
      }
      try {
        const state = await deps.github.prMerged(slug, number);
        if (state.merged) {
          await settle().catch(() => {});
          return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: cursor.mergeRequested || cursor.queued ? "machine" : "person" }, prUrl: url, number } };
        }
        if (state.state === "closed") {
          // GitHub's own `closed` state, never a comment's word: the pipeline archives the card (`pr_closed`).
          return { outcome: "fail", detail: { prClosed: true } };
        }
        const facts = await readShipFacts(deps, context, { slug, number }, cursor, now, teamCache);
        if (!facts) {
          await note("GitHub shows no such PR right now; waiting");
        } else {
          const { pr, head, pack, readiness } = facts;
          if (pack && head && pack.commitSha !== head) {
            return {
              outcome: "escalated",
              detail: { escalation: "head_moved", reason: `the PR head moved after the evidence pack (${pack.commitSha.slice(0, 7)} → ${head.slice(0, 7)}): Evidence runs again`, options: [] },
            };
          }
          // The classes facts decide: one `ship.event` per change; freeze and blocked_by_other_pr are items on the checklist and the watch waits.
          const classes = facts.events;
          const before = cursor.lastEvents ?? [];
          for (const c of classes) if (!before.includes(c)) await context.emit?.("ship.event", { kind: "poll", class: c }).catch(() => {});
          cursor.lastEvents = classes;
          // A checks run that left failure and came back is a new red even under the same run id.
          if (deps.loop && pr.checks.state !== "failure") cursor.ciCycled = true;

          // Review activity: with the loop, each new item is judged and acted on; without it, recorded and noted.
          let moved = false;
          // Readiness was read before the activity: whatever was handled, the merge waits for the next poll.
          let handled = false;
          if (deps.loop) {
            // A failure here ends the poll (and the merge with it): nothing is merged past activity that was not read.
            const fresh = (await deps.github.prActivity(slug, number, cursor.since)).filter((a) => !cursor.seen.includes(a.id));
            handled = fresh.length > 0;
            for (const a of fresh) {
              // A throw escalates once and the item is marked seen: it is not judged again every poll for two weeks.
              const out = await handleActivity(a, pack).catch((error: unknown): Outcome => ({ result: escalated(`a review event could not be handled: ${postable(messageOf(error), 300)}`) }));
              cursor.seen = [...cursor.seen, a.id].slice(-SEEN_CAP);
              cursor.since = a.at || cursor.since;
              await saveCursor(deps.stateDir, task.id, cursor);
              if (out.result) return out.result;
              if (out.moved) {
                moved = true;
                break;
              }
            }
            if (!moved && classes.includes("conflict") && head) {
              const out = await watchConflict(head, pack);
              if (out.result) return out.result;
              moved = out.moved ?? false;
            } else if (!moved && classes.includes("base_moved") && head) {
              const out = await baseMoved(head, pack);
              if (out.result) return out.result;
              moved = out.moved ?? false;
            }
            if (!moved && pr.checks.state === "failure" && head) {
              const out = await watchCi(head, pack);
              if (out.result) return out.result;
              moved = out.moved ?? false;
            }
          } else {
            const activity = (await deps.github.prActivity(slug, number, cursor.since).catch(() => [])).filter((a) => !cursor.seen.includes(a.id));
            if (activity.length > 0) {
              cursor.seen = [...cursor.seen, ...activity.map((a) => a.id)].slice(-SEEN_CAP);
              cursor.since = activity.at(-1)!.at || cursor.since;
              await note(`${activity.length} new item${activity.length === 1 ? "" : "s"} on the PR: ${activity.map((a) => `${a.actor ?? "ghost"} ${a.kind}`).join(", ")}`);
            }
          }

          // The quiet clock: anything that happened on the PR starts the period again; a reminder and an escalation are said once per period, with fixed words.
          {
            const sig = [head ?? "", pr.checks.state, cursor.fixRounds, cursor.seen.at(-1) ?? ""].join("|");
            if (cursor.activitySig !== undefined && cursor.activitySig !== sig) {
              cursor.lastActivityAt = now().toISOString();
              cursor.remindedAt = null;
              cursor.escalatedAt = null;
            }
            cursor.activitySig = sig;
            const ship = (await deps.policies.for(task.repoPath)).factory.ship;
            const due = shipSla({ lastActivityAt: cursor.lastActivityAt!, remindedAt: cursor.remindedAt ?? null, escalatedAt: cursor.escalatedAt ?? null, now: now(), reminderDays: ship.sla.reminder_days, escalateDays: ship.sla.escalate_days });
            if (due === "remind") {
              cursor.remindedAt = now().toISOString();
              await context.emit?.("sla.reminder", { gate: "awaiting_ship", quietDays: quietDays(cursor.lastActivityAt!, now()) }).catch(() => {});
            } else if (due === "escalate") {
              cursor.escalatedAt = now().toISOString();
              await context.emit?.("sla.escalated", { gate: "awaiting_ship", afterDays: ship.sla.escalate_days, to: facts.releaseOwners }).catch(() => {});
            }
          }
          // A head older than `ship.stale_days` is proved again once: the base is brought up if it moved (while rebases last), the project's checks run, and the clock starts over.
          if (deps.loop && !moved && !handled && head && readiness.checklist.some((i) => i.id === "stale" && !i.ok)) {
            const out = await reverifyStale(head, pack, classes.includes("base_moved") || classes.includes("conflict"));
            if (out.result) return out.result;
            moved = out.moved ?? false;
          }
          if (readiness.ready && !cursor.readyNoted) {
            cursor.readyNoted = true;
            await context.emit?.("ship.ready", {}).catch(() => {});
          }
          if (moved || handled) {
            // The head moved this poll: what was judged ready is not what is there now. The next poll reads it again.
          } else if (cursor.queued) {
            // In the merge queue: the queue merges it; `shipping` waits for it.
            await saveCursor(deps.stateDir, task.id, cursor);
            return { outcome: "pass", detail: { queued: true, prUrl: url, number } };
          } else if (readiness.canAutoMerge && head) {
            // The watch does not merge: it says the merge is due, at this head. `shipping` reads the facts again and merges.
            await saveCursor(deps.stateDir, task.id, cursor);
            return { outcome: "pass", detail: { ready: { head }, prUrl: url, number } };
          } else if (readiness.needsShipApproval && head && pack) {
            // Ready, and a person must say "safe to release now?" for this head. The gate opens after review and CI, never before.
            await saveCursor(deps.stateDir, task.id, cursor);
            await context.emit?.("ship.approval_needed", {}).catch(() => {});
            const classified = (await deps.latestFinish?.(task.id, "verifying").catch(() => null))?.detail?.classified;
            const records = (Array.isArray(classified) ? classified : []).flatMap((row: { recordId?: unknown }) => (typeof row?.recordId === "string" ? [row.recordId] : []));
            return {
              outcome: "needs_input",
              detail: {
                gate: "ship_approval",
                head,
                prUrl: url,
                number,
                risk: facts.risk,
                checklist: readiness.checklist,
                question: "safe to release now?",
                releaseOwners: facts.releaseOwners,
                evidence: { format: pack.format, summary: pack.summary, media: pack.media.map((m) => ({ label: m.label, url: m.url })), commitSha: pack.commitSha, risk: pack.risk, ...(pack.video ? { video: pack.video } : {}) },
                ...(records.length > 0 ? { decisions: { finding_classify: records } } : {}),
              },
            };
          } else if (!readiness.ready) {
            const text = readiness.blockers.join("; ");
            if (text !== cursor.lastBlockers) {
              cursor.lastBlockers = text;
              await note(`waiting: ${text}`);
            }
          } else if (cursor.lastBlockers !== readiness.reason) {
            cursor.lastBlockers = readiness.reason;
            // Ready, but not for the machine to merge: a person has to.
            await context.emit?.("ship.approval_needed", {}).catch(() => {});
            await note(readiness.reason);
          }
          await saveCursor(deps.stateDir, task.id, cursor);
        }
      } catch (error) {
        await note(`could not read the PR: ${messageOf(error)}`);
      }
      await sleep(deps.pollMs ?? (await deps.policies.for(task.repoPath)).factory.ship.poll_minutes * 60_000);
    }
  };
}
