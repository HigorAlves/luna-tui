// The shipped PR's fixes in place: what the ship monitor's review loop does once a reviewer's change
// request (or a red CI) is worth a commit. The `addressing` pack runs on the task's own worktree, the
// project's checks run over the delta, and only a green fix is pushed (never forced), replied to and
// folded into the Evidence Pack. Every red resets the worktree to the head it started from.
// Reviewer text is data: it reaches a model inside `ThreadsContext`/`ShipContext` and nothing else,
// never a shell or git argument; what goes back to GitHub is the model's text, flattened.
import {
  type CiContext,
  type DecisionOverrides,
  type EscalationReason,
  type EvidencePack,
  type Finding,
  PACKS,
  PrAddressAnswer,
  type ShipContext,
  type ThreadsContext,
  applyPolicy,
} from "@hardness/contracts";

import { HOST_GIT, type GitExec, type RebaseResult } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { safe } from "../../domain/evidence-markdown.ts";
import type { PublishEvidence } from "../evidence-publish.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { pushBranch } from "./deliver.ts";
import { followUp } from "./pr-address.ts";
import { gatherPr } from "./pr-review.ts";

/** The longest a reply the monitor posts may be, after flattening. */
export const REPLY_CAP = 1500;
/** The longest the sentence a fix adds to the pack's summary may be. */
const SUMMARY_ADD_CAP = 200;
const SHA = /^[0-9a-f]{40,64}$/;

/** A model's text made safe to post: one line, no HTML, no `@mention`, no `#N` auto-link, capped. */
export const postable = (text: string, cap = REPLY_CAP): string => safe(text).slice(0, cap).trim();

export type ShipDecisionPack = "event_class" | "comment_intent" | "fix_scope" | "evidence_valid";
export type ShipDecide = (pack: ShipDecisionPack, ship: ShipContext, repoPath: string | null) => Promise<Record<string, unknown>>;
export type LoopPack = "pr_reply" | "addressing" | "verifying" | "ci_watch";
/** What a sub-run is handed: the ship context for pr_reply; for the others the extra the pack reads. */
export type LoopExtra = ShipContext | { threads?: ThreadsContext; baseCommit?: string; ci?: CiContext };

/** What the review loop needs beyond the monitor's own: the decisions, the packs and the project's checks. */
export interface ReviewLoop {
  /** Bound late, once PackRuns exists; null answers nothing (every decision then goes to a person). */
  decide: ShipDecide | null;
  runPack: (pack: LoopPack, context: StageContext, extra: LoopExtra) => Promise<StageResult>;
  /** The project's checks over what changed since `since` (a commit): a verifying run with no review pack. Absent, no fix is trusted. */
  checks?: (context: StageContext, since: string) => Promise<StageResult>;
  /** Runs git (default: the real one); tests inject a recorder. */
  exec?: GitExec;
  /** Rebases the worktree onto the default branch (default: `rebaseOntoDefault`); tests inject a fake. */
  rebase?: (exec: GitExec, worktreePath: string, repoPath: string) => Promise<RebaseResult>;
}

/** The Evidence Pack's handles: `load` always; `save`, `publish` and `store` to re-stamp it after a fix. */
export interface EvidenceHandle {
  load: (taskId: string) => Promise<EvidencePack | null>;
  save?: (taskId: string, pack: EvidencePack) => Promise<void>;
  publish?: PublishEvidence;
  store?: { dirFor: (taskId: string, sha: string) => string };
}

export interface FixDeps {
  github: GitHub;
  loop: ReviewLoop;
  policies: { for: (repoPath: string | null) => Promise<{ decisions: Record<string, DecisionOverrides> }> };
  evidence: EvidenceHandle;
}

const KEY: Record<ShipDecisionPack, string> = { event_class: "event", comment_intent: "intent", fix_scope: "scope", evidence_valid: "validity" };

/** Asks a ship decision and applies its policy and the repo's overrides; never throws. A failed or unsure answer is `ok: false` with why. */
export async function judgeShip(
  deps: Pick<FixDeps, "loop" | "policies">,
  pack: ShipDecisionPack,
  ship: ShipContext,
  repoPath: string | null,
): Promise<{ ok: true; choice: string } | { ok: false; reason: string }> {
  const decide = deps.loop.decide;
  if (!decide) return { ok: false, reason: `no model is available for ${pack}` };
  try {
    const answer = await decide(pack, ship, repoPath);
    const overrides = (await deps.policies.for(repoPath)).decisions[pack];
    const overall = applyPolicy(PACKS[pack], answer, overrides).overall;
    const choice = (answer[KEY[pack]] as { choice?: unknown } | undefined)?.choice;
    if ((overall === "proceed" || overall === "flag") && typeof choice === "string") return { ok: true, choice };
    return { ok: false, reason: `${pack} was not sure enough (${overall})` };
  } catch (error) {
    return { ok: false, reason: `${pack} failed: ${messageOf(error)}` };
  }
}

export const escalated = (reason: string, escalation: EscalationReason = "other", extra: Record<string, unknown> = {}): StageResult => ({
  outcome: "escalated",
  detail: { escalation, reason, options: [], ...extra },
});

/** A sub-run's context: a derived run id, nothing that ties it to the stage's own container or engine. */
export const subContext = (context: StageContext, suffix: string): StageContext => ({ ...context, runId: `${context.runId}-${suffix}`, started: undefined, resume: undefined, engine: undefined });

/** Resets the worktree to a commit the machine itself read (never a name from anywhere else). */
export async function resetTo(run: GitExec, worktreePath: string, ref: string): Promise<void> {
  if (!SHA.test(ref)) return;
  await run("git", [...HOST_GIT, "-C", worktreePath, "reset", "--hard", "--quiet", ref]);
  await run("git", [...HOST_GIT, "-C", worktreePath, "clean", "-fd", "--quiet"]);
}

export async function headOfWorktree(run: GitExec, worktreePath: string): Promise<string | null> {
  const out = await run("git", [...HOST_GIT, "-C", worktreePath, "rev-parse", "HEAD"]);
  const sha = out.code === 0 ? out.stdout.trim() : "";
  return SHA.test(sha) ? sha : null;
}

/** The pack after a change at `sha`: stamped with it, the sentence appended, saved and published (section and comment). */
export async function restampPack(
  deps: Pick<FixDeps, "github" | "evidence">,
  taskId: string,
  slug: string,
  number: number,
  pack: EvidencePack,
  sha: string,
  sentence: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { save, publish, store } = deps.evidence;
  if (!save || !publish || !store) return { ok: false, reason: "the Evidence Pack cannot be re-published from here" };
  const next: EvidencePack = { ...pack, commitSha: sha, ...(sentence ? { summary: `${pack.summary} ${sentence}` } : {}) };
  try {
    const done = await publish({ github: deps.github, slug, number, taskId, pack: next, localDir: store.dirFor(taskId, pack.commitSha) });
    await save(taskId, done.pack);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `re-publishing the Evidence Pack failed: ${messageOf(error)}` };
  }
}

export interface FixInput {
  slug: string;
  number: number;
  /** What the fix answers: a review's threads, or one synthetic thread carrying a red CI's findings. */
  threads: ThreadsContext["threads"];
  scope: "in_place" | "re_verify_partial";
  /** One line for the pack's summary and the evidence_valid decision. */
  threadSummary: string;
  /** Names the sub-runs (`address-<label>`). */
  label: string;
  /** Post the answer's replies (a review's threads) and resolve the ones it marks; false for a CI fix, which has no thread. */
  postReplies: boolean;
  pack: EvidencePack | null;
}

export type FixOutcome =
  | { ok: true; head: string; changed: boolean; replied: number; resolved: number; repliedTo: string[]; summary: string; note?: string }
  | { ok: false; result: StageResult };

const reasonOf = (result: StageResult): string => {
  const d = result.detail ?? {};
  const text = d.error ?? d.reason ?? d.summary;
  return typeof text === "string" && text ? text.slice(0, 400) : result.outcome;
};

/** One fix round on the task's worktree. A red anywhere resets to the head it started from and escalates with why. */
export async function fixRound(deps: FixDeps, context: StageContext, input: FixInput): Promise<FixOutcome> {
  const { task } = context;
  const wt = task.worktreePath;
  const branch = task.branch;
  if (!wt || !branch) return { ok: false, result: escalated("the task has no worktree to fix in") };
  const run = deps.loop.exec ?? realExec;
  const before = await headOfWorktree(run, wt);
  if (!before) return { ok: false, result: escalated("the worktree's head could not be read") };
  const stop = async (result: StageResult): Promise<FixOutcome> => {
    await resetTo(run, wt, before).catch(() => {});
    return { ok: false, result };
  };
  const remote = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remote && remote !== before) return { ok: false, result: escalated(`someone pushed to the PR (${remote.slice(0, 7)}); the fix would start from an old head`, "head_moved") };

  let pr;
  try {
    pr = await gatherPr(deps.github, input.slug, input.number);
  } catch (error) {
    return { ok: false, result: escalated(`the PR could not be read: ${messageOf(error)}`) };
  }
  const addressed = await deps.loop.runPack("addressing", subContext(context, `address-${input.label}`), { threads: { pr, threads: input.threads } });
  if (addressed.outcome !== "pass") return stop(escalated(`the fix could not be made: ${reasonOf(addressed)}`));
  const parsed = PrAddressAnswer.safeParse(addressed.detail?.answer);
  if (!parsed.success) return stop(escalated("the addressing pack gave no usable answer"));
  const answer = parsed.data;
  if (answer.kind === "escalated") return stop(escalated(answer.reason || answer.summary || "the addressing pack asked for a person", answer.escalation ?? "other"));

  const after = await headOfWorktree(run, wt);
  if (!after) return stop(escalated("the worktree's head could not be read after the fix"));
  const known = new Set(input.threads.map((t) => t.id));
  const replies = input.postReplies
    ? answer.replies.filter((r) => known.has(r.threadId)).map((r) => ({ threadId: r.threadId, body: postable(r.body), resolve: r.resolve })).filter((r) => r.body)
    : [];

  if (after === before) {
    // Nothing committed: an explanation is all there is. A CI fix with no change is no fix.
    if (!input.postReplies) return stop(escalated("the addressing pack made no change for the failing check"));
    await resetTo(run, wt, before).catch(() => {});
    const posted = await followUp(deps.github, replies);
    return { ok: true, head: before, changed: false, replied: posted.replied, resolved: posted.resolved, repliedTo: replies.map((r) => r.threadId), summary: answer.summary, ...(posted.ok ? {} : { note: posted.error }) };
  }

  const checked = deps.loop.checks ? await deps.loop.checks(subContext(context, `checks-${input.label}`), before) : null;
  if (!checked) return stop(escalated("no checks runner is wired to prove the fix"));
  if (checked.outcome !== "pass") {
    return stop(escalated(`the checks failed after the fix: ${reasonOf(checked)}`, "other", { findings: (checked.detail?.findings as Finding[] | undefined) ?? checked.findings ?? [] }));
  }
  if (input.scope === "re_verify_partial") {
    const reviewed = await deps.loop.runPack("verifying", subContext(context, `verify-${input.label}`), { baseCommit: before });
    if (reviewed.outcome !== "pass") {
      return stop(escalated(`the review of the fix found a problem: ${reasonOf(reviewed)}`, "other", { findings: (reviewed.detail?.findings as Finding[] | undefined) ?? reviewed.findings ?? [] }));
    }
  }

  // The push is of what was checked: the head must still be the one the checks ran on, a descendant of the one we started from, with the PR's head where it was.
  const now = await headOfWorktree(run, wt);
  const descends = (await run("git", [...HOST_GIT, "-C", wt, "merge-base", "--is-ancestor", before, now ?? ""])).code === 0;
  if (now !== after || !descends) return stop(escalated("the branch changed while the fix was being checked; nothing was pushed"));
  const remoteNow = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remoteNow && remoteNow !== before) return stop(escalated(`someone pushed to the PR (${remoteNow.slice(0, 7)}) while the fix was checked; nothing was pushed`, "head_moved"));
  const pushError = await pushBranch(run, branch, wt);
  if (pushError) return stop(escalated(pushError));

  // From here the commit is on the PR: no reset, whatever else goes wrong.
  const posted = replies.length > 0 ? await followUp(deps.github, replies) : { ok: true as const, replied: 0, resolved: 0, skipped: [] as string[] };
  const out = { ok: true as const, head: after, changed: true, replied: posted.replied, resolved: posted.resolved, repliedTo: replies.map((r) => r.threadId), summary: answer.summary, ...(posted.ok ? {} : { note: posted.error }) };

  const pack = input.pack;
  if (!pack) return out;
  const names = await run("git", [...HOST_GIT, "-C", wt, "diff", "--name-only", before, after]);
  const stat = await run("git", [...HOST_GIT, "-C", wt, "diff", "--stat", "--no-color", before, after]);
  const ship: ShipContext = {
    kind: "fix",
    fix: {
      changed: names.stdout.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 200),
      diffSummary: stat.stdout.slice(0, 4000),
      scenarios: pack.scenarios.map((s) => ({ text: s.text, result: s.result })),
      threadSummary: input.threadSummary.slice(0, 500),
    },
  };
  const valid = await judgeShip(deps, "evidence_valid", ship, task.repoPath);
  // Unsure whether the pack is still true: Evidence runs again, the safe side.
  if (!valid.ok) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); ${valid.reason}, so Evidence runs again`, "head_moved") };
  if (valid.choice === "refresh_media") return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}) and changes what the scenarios show: Evidence runs again`, "head_moved") };
  const stamped = await restampPack(deps, task.id, input.slug, input.number, pack, after, `Fixed after review: ${postable(input.threadSummary, SUMMARY_ADD_CAP)}.`);
  if (!stamped.ok) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); ${stamped.reason}, so Evidence runs again`, "head_moved") };
  return out;
}
