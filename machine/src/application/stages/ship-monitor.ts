// The ship monitor: after Ship publishes the pack and readies the PR, this watches the task's own
// PR until it merges. Each poll reads GitHub's facts, the Evidence Pack and the policy; merge
// readiness is a script (domain/merge-readiness.ts), and the merge is sha-guarded and never above
// the policy's risk. A PR a person merges ends the wait the same way. The cursor file lets a
// machine restart resume instead of escalate. Review activity and a red CI are recorded and noted
// here; acting on them is the maintenance loop's.
import { PrReplyAnswer, type EvidencePack, type Risk, type ShipContext } from "@hardness/contracts";

import { HOST_GIT, rebaseOntoDefault } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";

import { type Policy } from "../../domain/policy.ts";
import { ownerApprovals, parseCodeownersChecked, requiredOwners } from "../../domain/codeowners.ts";
import { MAX_DEPENDENCIES, mergeReadiness, parseDependencies } from "../../domain/merge-readiness.ts";
import { fromGraphQl } from "../../domain/pull-request.ts";
import { type GitHub, type PrActivity, type PrReview, messageOf } from "../github.ts";
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
  /** Told, when the PR merges, what its outcome says about event_class and comment_intent decisions (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  stateDir: string;
  pollMs: number;
  /** The longest the monitor waits for a merge before asking a person (default 14 days). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The CODEOWNERS text at the PR's base branch, or null; default: the first of the three places the port finds. Tests inject one. */
  readCodeowners?: (slug: string, baseRef: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export type ShipMonitor = (context: StageContext, pr: { slug: string; number: number; url: string }) => Promise<StageResult>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function shipMonitor(deps: ShipMonitorDeps): ShipMonitor {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const maxWaitMs = deps.maxWaitMs ?? 14 * DAY_MS;
  const readCodeowners =
    deps.readCodeowners ??
    (async (slug: string, baseRef: string) => {
      for (const path of CODEOWNERS_PATHS) {
        const text = await deps.github.fileAtRef(slug, baseRef, path);
        if (text !== null) return text;
      }
      return null;
    });

  return async (context, ref) => {
    // Per run, so a member removed from a team stops counting after the TTL.
    const teamCache = new Map<string, { at: number; members: string[] | null }>();
    const { task, signal } = context;
    const { slug, number, url } = ref;
    const note = async (text: string) => {
      deps.log?.(text);
      await context.note?.(text).catch(() => {});
    };
    let cursor: ShipCursor = (await loadCursor(deps.stateDir, task.id)) ?? emptyCursor({ slug, number });
    if (cursor.pr.slug !== slug || cursor.pr.number !== number) cursor = { ...emptyCursor({ slug, number }), published: cursor.published };
    cursor.startedAt ??= now().toISOString();
    await saveCursor(deps.stateDir, task.id, cursor);
    let mergeErrors = 0;

    /** Whether the latest review of someone is an approval given on `head`: nothing older counts after a fix. */
    const approvedOn = (head: string | null, reviews: PrReview[]): boolean => {
      const latest = new Map<string, PrReview>();
      for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
      return head !== null && [...latest.values()].some((r) => r.state === "APPROVED" && r.commitId === head);
    };

    /** What the repo's CODEOWNERS still wants: null when it has none. A team the token cannot read stays unresolved. */
    const ownersOf = async (head: string | null, baseRef: string, paths: string[], reviewsOf: () => Promise<PrReview[]>) => {
      const text = await readCodeowners(slug, baseRef);
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


    // ---- The review loop (only with `deps.loop`): activity judged and answered, fixes in place, CI red and conflicts. ----
    type Outcome = { result?: StageResult; moved?: boolean };
    type Facts = ReturnType<typeof fromGraphQl>;
    let me: string | null = null;
    const login = async () => (me ??= (await deps.github.viewer()).login.toLowerCase());
    /** The PR merged: the decisions it was waiting on are settled by what happened to their threads. */
    const settleDecisions = async (): Promise<void> => {
      const pending = cursor.decisions ?? [];
      if (!deps.truth || pending.length === 0) return;
      const open = await deps.github.prThreads(slug, number).catch(() => null);
      for (const d of pending) {
        if (d.pack === "event_class") await deps.truth.learned({ pack: "event_class", recordId: d.recordId, label: eventClassTruth(d.further === true), source: "pr_merged", taskId: task.id });
        else if (open && d.threadId && !(cursor.resolvedByMachine ?? []).includes(d.threadId) && !open.some((t) => t.id === d.threadId)) await deps.truth.learned({ pack: "comment_intent", recordId: d.recordId, label: commentIntentTruth(d.choice as "question" | "change_request"), source: "thread_resolved", taskId: task.id });
      }
      cursor.decisions = [];
      await saveCursor(deps.stateDir, task.id, cursor);
    };
    const fixDeps = (): FixDeps => ({ github: deps.github, loop: deps.loop!, policies: deps.policies, evidence: deps.evidence });
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
      const ship: ShipContext = {
        kind: "comment",
        comment: { thread, pack: { summary: pack?.summary ?? "", scenarios: (pack?.scenarios ?? []).map((s) => ({ text: s.text, result: s.result })), howToVerify: pack?.howToVerify ?? "" }, myReplies },
      };
      const intent = await judgeShip(fixDeps(), "comment_intent", ship, task.repoPath);
      if (!intent.ok) return { result: escalated(`a review comment needs a person (${intent.reason}): ${quoted(thread)}`) };
      if (intent.choice === "question") {
        const ran = await deps.loop!.runPack("pr_reply", subContext(context, `reply-${slugId(a.id)}`), ship);
        const drafted = ran.outcome === "pass" ? PrReplyAnswer.safeParse(ran.detail?.answer) : null;
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
      let scope: "in_place" | "re_verify_partial" = "in_place";
      if (intent.choice === "change_request") {
        const sized = await judgeShip(fixDeps(), "fix_scope", ship, task.repoPath);
        if (!sized.ok) return { result: escalated(`a change request needs a person (${sized.reason}): ${quoted(thread)}`) };
        if (sized.choice === "re_plan") return { result: escalated(`the review says the plan is wrong: ${quoted(thread)}`, "plan_wrong", { thread: thread.comments.map((c) => `${c.author}: ${c.body}`).join("\n").slice(0, 20_000) }) };
        if (sized.choice !== "in_place" && sized.choice !== "re_verify_partial") return { result: escalated(`a change request needs a person: ${quoted(thread)}`) };
        scope = sized.choice;
      } else if (intent.choice !== "nit") {
        return { result: escalated(`a review comment needs a person: ${quoted(thread)}`) };
      }
      const fixed = await fix({ id: thread.id, threads: [found], scope, summary: `${thread.path ?? "the PR"}: ${plain(a.body, 120)}`, postReplies: !topLevel, quote: quoted(thread), topLevel }, pack);
      if (fixed.moved && intent.choice === "change_request" && intent.recordId) cursor.decisions = [...(cursor.decisions ?? []), { pack: "comment_intent", recordId: intent.recordId, choice: "change_request", threadId: thread.id }];
      return fixed;
    };

    /** One bounded fix round; the counters are spent before it runs, so a crash cannot loop. */
    const fix = async (
      round: { id: string; threads: Array<NonNullable<Awaited<ReturnType<GitHub["prThreads"]>>>[number]>; scope: "in_place" | "re_verify_partial"; summary: string; postReplies: boolean; quote: string; topLevel?: boolean },
      pack: EvidencePack | null,
    ): Promise<Outcome> => {
      if ((cursor.threads[round.id]?.fixRounds ?? 0) >= MAX_THREAD_FIX_ROUNDS) return { result: escalated(`third round trip on ${round.quote}`) };
      if (cursor.fixRounds >= MAX_PR_FIX_ROUNDS) return { result: escalated(`${MAX_PR_FIX_ROUNDS} fix rounds are spent on this PR: ${round.quote}`) };
      cursor.fixRounds++;
      await bump(round.id, { fixRounds: 1 });
      const out = await fixRound(fixDeps(), context, { slug, number, threads: round.threads, scope: round.scope, threadSummary: round.summary, label: String(cursor.fixRounds), postReplies: round.postReplies, pack });
      if (!out.ok) return { result: out.result };
      if (out.resolvedTo.length > 0) cursor.resolvedByMachine = [...new Set([...(cursor.resolvedByMachine ?? []), ...out.resolvedTo])];
      if (out.replied > 0) await bump(round.id, { replies: out.replied });
      if (out.note) await note(`a reply could not be posted: ${out.note}`);
      if (round.topLevel && out.summary) await deps.github.commentOnIssue(slug, number, postable(out.summary)).catch(() => {});
      cursor.published = { sha: out.head };
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
      const body = a.body.slice(0, 2000);
      const event: ShipContext = { kind: "event", event: { actor: a.actor ?? "ghost", isBot: a.isBot, isMe: false, kind: a.kind === "review" ? "review" : "comment", state: a.state, body, url: a.url } };
      const label = `${a.actor ?? "ghost"} ${a.kind}: ${plain(body, 80)}`;
      // A person's word on the PR after an earlier event means that event drew activity.
      if (!a.isBot && TRUSTED.has(a.association ?? "")) for (const d of cursor.decisions ?? []) if (d.pack === "event_class") d.further = true;
      const cls = await judgeShip(fixDeps(), "event_class", event, task.repoPath);
      if (cls.ok && cls.recordId && (cls.choice === "noise" || cls.choice === "comment")) cursor.decisions = [...(cursor.decisions ?? []), { pack: "event_class", recordId: cls.recordId, choice: cls.choice }];
      if (!cls.ok) return { result: escalated(`a review event needs a person (${cls.reason}): ${label}`) };
      // One row per classified item, by its kind and class (enum values, never the reviewer's words).
      await context.emit?.("ship.event", { kind: a.kind, class: ["noise", "approval", "changes_requested", "push", "comment"].includes(cls.choice) ? cls.choice : "other" }).catch(() => {});
      switch (cls.choice) {
        case "noise":
          return {};
        case "approval":
        case "changes_requested":
          await note(`${a.actor ?? "ghost"} ${cls.choice === "approval" ? "approved" : "asked for changes"}`);
          return {};
        case "push":
          return { result: escalated(`someone else pushed to the branch: ${label}`, "head_moved") };
        case "comment":
          return handleComment(a, pack);
        default:
          return { result: escalated(`a review event needs a person: ${label}`) };
      }
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
      const ran = await deps.loop!.runPack("ci_watch", subContext(context, `ci-${slugId(key.slice(0, 12))}-${runIds[0]}`), { ci: await ciContextOf(deps.github, slug, task.branch ?? "", checks, failed) });
      const answer = ran.detail?.answer && typeof ran.detail.answer === "object" ? (ran.detail.answer as Record<string, unknown>) : {};
      if (ran.outcome !== "pass") return { result: escalated(`CI is red and its cause could not be read: ${plain(String(ran.detail?.error ?? ran.outcome), 300)}`) };
      const verdict = String(answer.verdict ?? "");
      const summary = plain(String(answer.summary ?? ""), 400);
      if (verdict === "green") return {};
      if (verdict === "flake") {
        const reruns = (await deps.policies.for(task.repoPath)).factory.verify.ci_flaky_reruns;
        if (cursor.ciReruns >= reruns) return { result: escalated(`CI is red again after ${reruns === 1 ? "one re-run" : `${reruns} re-runs`}: ${summary}`) };
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
      if (verdict !== "fixable") {
        const reason = plain(String(answer.reason ?? summary ?? verdict), 400);
        return { result: escalated(`CI is red (${verdict || "unknown"}): ${reason}`, "other", { verdict }) };
      }
      const findings = Array.isArray(answer.findings) ? (answer.findings as Array<{ title?: unknown; body?: unknown }>).slice(0, 10).map((f) => `${plain(String(f.title ?? ""), 120)}: ${plain(String(f.body ?? ""), 300)}`) : [];
      const text = [summary, ...findings].filter(Boolean).join("\n");
      const synthetic = { id: "ci", path: null, line: null, comments: [{ author: "ci", body: text.slice(0, 3000), at: now().toISOString() }] };
      return fix({ id: "ci", threads: [synthetic], scope: "in_place", summary: `CI: ${plain(summary || "a failing check", 120)}`, postReplies: false, quote: `CI: ${plain(summary, 200)}` }, pack);
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
        const stamped = await restampPack(fixDeps(), task.id, slug, number, pack, now2, null);
        if (!stamped.ok) return { result: escalated(`the branch is rebased (${now2.slice(0, 7)}); ${stamped.reason}, so Evidence runs again`, "head_moved") };
      }
      cursor.published = now2 ? { sha: now2 } : cursor.published;
      await note(`rebased onto the default branch${now2 ? ` (${now2.slice(0, 7)})` : ""}`);
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
          await settleDecisions().catch(() => {});
          return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: cursor.mergeRequested || cursor.queued ? "machine" : "person" }, prUrl: url, number } };
        }
        if (state.state === "closed") {
          return { outcome: "escalated", detail: { escalation: "other", reason: "the PR was closed without a merge", options: [] } };
        }
        const node = await deps.github.prFacts(slug, number);
        if (!node) {
          await note("GitHub shows no such PR right now; waiting");
        } else {
          const pr = fromGraphQl(node, slug, "", []);
          const head = pr.headSha ?? (await deps.github.prHeadSha(slug, number));
          const pack = await deps.evidence.load(task.id);
          if (pack && head && pack.commitSha !== head) {
            return {
              outcome: "escalated",
              detail: { escalation: "head_moved", reason: `the PR head moved after the evidence pack (${pack.commitSha.slice(0, 7)} → ${head.slice(0, 7)}): Evidence runs again`, options: [] },
            };
          }
          const policy = await deps.policies.for(task.repoPath);
          // No pack fails closed: the highest risk, and the readiness script names the missing pack.
          const risk: Risk = pack?.risk ?? "high";
          const approver = context.approvals.findLast((a) => a.kind === "awaiting_ship" && a.decision === "approved")?.response?.approver;
          const listed = parseDependencies(pr.body);
          const dependencies = await Promise.all(
            listed.slice(0, MAX_DEPENDENCIES).map(async (n) => {
              const dep = await deps.github.prMerged(slug, n).catch(() => null);
              return { number: n, merged: dep?.merged ?? false, closed: dep ? dep.state === "closed" : false };
            }),
          );
          const paths = (await deps.github.prFiles(slug, number)).map((f) => f.path);
          const changesCodeowners = paths.some((p) => CODEOWNERS_PATHS.includes(p));
          // The reviews are read once a poll, for the owners and for the approval a fix needs.
          let reviewsRead: Promise<PrReview[]> | null = null;
          const reviewsOf = () => (reviewsRead ??= deps.github.prReviews(slug, number));
          const owners = await ownersOf(head, pr.baseRef, paths, reviewsOf).catch((error: unknown) => ({ missing: [], unresolved: [`CODEOWNERS could not be checked: ${messageOf(error)}`] }));
          // After a fix the loop made, the approval that counts is one on the fix itself: the latest review of each person, on the head.
          const fixApproval = cursor.fixRounds > 0 ? { approved: await approvedOn(head, await reviewsOf().catch(() => [])) } : null;
          const readiness = mergeReadiness({
            pr,
            packSha: pack?.commitSha ?? null,
            policy: { autoMerge: policy.autoMerge, freeze: policy.freeze },
            risk,
            shipApprover: risk === "high" && typeof approver === "string" && approver ? approver : null,
            now: now(),
            dependencies,
            owners,
            changesCodeowners,
            dependenciesListed: listed.length,
            fixApproval,
            staleDays: policy.factory.ship.stale_days,
          });
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
            if (!moved && pr.mergeable === "CONFLICTING" && head) {
              const out = await watchConflict(head, pack);
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

          if (readiness.ready && !cursor.readyNoted) {
            cursor.readyNoted = true;
            await context.emit?.("ship.ready", {}).catch(() => {});
          }
          if (moved || handled) {
            // The head moved this poll: what was judged ready is not what is there now. The next poll reads it again.
          } else if (cursor.queued) {
            // In the merge queue: the queue merges it. Asking again would only race it.
          } else if (readiness.canAutoMerge && head) {
            try {
              cursor.mergeRequested = true;
              await saveCursor(deps.stateDir, task.id, cursor);
              const result = await deps.github.mergePr(slug, number, { sha: head });
              mergeErrors = 0;
              if (result && "queued" in result) {
                cursor.queued = true;
                await note("the PR is in the merge queue");
              }
              else {
                await settleDecisions().catch(() => {});
                return { outcome: "pass", detail: { merged: { sha: head, at: now().toISOString(), by: "machine" }, prUrl: url, number } };
              }
            } catch (error) {
              cursor.mergeRequested = false;
              mergeErrors++;
              await note(`the merge failed: ${messageOf(error)}`);
              if (mergeErrors >= 2) {
                return { outcome: "escalated", detail: { escalation: "other", reason: `the merge failed twice: ${messageOf(error)}`, options: [] } };
              }
            }
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
      await sleep(deps.pollMs);
    }
  };
}
