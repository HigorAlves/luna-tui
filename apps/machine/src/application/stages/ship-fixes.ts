// The shipped PR's fixes in place: what the ship monitor's review loop does once a reviewer's change
// request (or a red CI) is worth a commit. The `addressing` pack runs on the task's own worktree, the
// project's checks run over the delta, and only a green fix is pushed (never forced), replied to and
// folded into the Evidence Pack. Every red resets the worktree to the head it started from.
// Reviewer text is data: it reaches a model inside `ThreadsContext`/`ShipContext` and nothing else,
// never a shell or git argument; what goes back to GitHub is the model's text, flattened.
import { recordIdOf } from "../decision-truth.ts";
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

import { publishBranch } from "../../adapters/git/clone.ts";
import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT, type GitExec, type RebaseResult } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { refreshPackText } from "../../domain/evidence-refresh.ts";
import { affectedScenarios } from "../../domain/affected-scenarios.ts";
import { type FixGuardResult, fixGuard } from "../../domain/fix-guard.ts";
import { carriesSecret, postable } from "../../domain/postable.ts";
import type { PublishEvidence } from "../evidence-publish.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { publishAndReady } from "../evidence-publish.ts";
import { touchesRenderedSurface } from "../../domain/evidence-stale.ts";
import { branchDiffStat, changedPaths } from "../../adapters/git/worktree.ts";
import { pushBranch } from "./deliver.ts";
import { followUp } from "./pr-address.ts";
import { gatherPr } from "./pr-review.ts";

export { REPLY_CAP, carriesSecret, postable } from "../../domain/postable.ts";
/** The longest the sentence a fix adds to the pack's summary may be. */
const SUMMARY_ADD_CAP = 200;
const SHA = /^[0-9a-f]{40,64}$/;

export const SECRET_REASON = "the drafted answer carried a secret-shaped token";

export type ShipDecisionPack = "event_class" | "comment_intent" | "fix_scope" | "evidence_valid" | "worth_learning";
export type ShipDecide = (pack: ShipDecisionPack, ship: ShipContext, repoPath: string | null) => Promise<Record<string, unknown>>;
export type LoopPack = "pr_reply" | "addressing" | "verifying" | "ci_watch";
/** What a sub-run is handed: the ship context for pr_reply; for the others the extra the pack reads. */
export type LoopExtra = ShipContext | { threads?: ThreadsContext; baseCommit?: string; ci?: CiContext };

/** What the review loop needs beyond the monitor's own: the decisions, the packs and the project's checks. */
export interface ReviewLoop {
  /** Bound late, once PackRuns exists; null answers nothing (every decision then goes to a person). */
  decide: ShipDecide | null;
  runPack: (pack: LoopPack, context: StageContext, extra: LoopExtra) => Promise<StageResult>;
  /** The project's checks over what changed since `since` (a commit): a verifying run with no review pack. Absent, no fix is trusted.
   *  A red check is asked again on `base` (a commit the machine read; by default where the branch left the repository's), and red there too comes back `escalated` with `red_on_base`. */
  checks?: (context: StageContext, since: string, base?: string) => Promise<StageResult>;
  /** A fresh clone of the card's clone at the PR's head, where a fix is made; absent, the fix runs in the card's own folder. */
  fresh?: {
    make: (cardPath: string, branch: string, runId: string) => Promise<{ path: string; commit: string }>;
    bringBack: (cardPath: string, freshPath: string, branch: string, from: string) => Promise<{ ok: boolean; reason?: string }>;
    remove: (path: string) => Promise<void>;
    keep?: (path: string, taskId: string, runId: string) => Promise<void>;
  };
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
  /** Where the ship cursor lives: a re-publish compares the PR's section with the hash saved there. */
  stateDir?: string;
  /** The Build Report's tests (scenario and file), for the scenarios a fix's changed test files point to. Optional: without it only the reader's named scenarios count. */
  /** The branch's size and files now, for the pack's text; default: host git through the machine repo's `at()`. */
  branchDiff?: (worktreePath: string, repoPath: string | null) => Promise<{ added: number; removed: number; files: string[] } | null>;
  buildTests?: (taskId: string) => Promise<Array<{ scenario: string; file?: string | null }>>;
}

const defaultBranchDiff = async (wt: string, repoPath: string | null) => {
  if (!repoPath) return null;
  const [stat, files] = await Promise.all([branchDiffStat(wt, repoPath), changedPaths(wt, repoPath)]);
  return stat && files ? { ...stat, files } : null;
};

const KEY: Record<ShipDecisionPack, string> = { event_class: "event", comment_intent: "intent", fix_scope: "scope", evidence_valid: "validity", worth_learning: "worth" };

/** Asks a ship decision and applies its policy and the repo's overrides; never throws. A failed or unsure answer is `ok: false` with why. */
export async function judgeShip(
  deps: Pick<FixDeps, "loop" | "policies">,
  pack: ShipDecisionPack,
  ship: ShipContext,
  repoPath: string | null,
): Promise<{ ok: true; choice: string; recordId?: string } | { ok: false; reason: string }> {
  const decide = deps.loop.decide;
  if (!decide) return { ok: false, reason: `no model is available for ${pack}` };
  try {
    const answer = await decide(pack, ship, repoPath);
    const overrides = (await deps.policies.for(repoPath)).decisions[pack];
    const overall = applyPolicy(PACKS[pack], answer, overrides).overall;
    const choice = (answer[KEY[pack]] as { choice?: unknown } | undefined)?.choice;
    const recordId = recordIdOf(answer);
    if ((overall === "proceed" || overall === "flag") && typeof choice === "string") return { ok: true, choice, ...(recordId ? { recordId } : {}) };
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
  await run("git", [...HOST_GIT, ...at(worktreePath), "reset", "--hard", "--quiet", ref]);
  await run("git", [...HOST_GIT, ...at(worktreePath), "clean", "-fd", "--quiet"]);
}

/**
 * What the fix changed, read by the host from git and checked by the guard. Fails closed: a diff git cannot give is a refusal.
 */
export async function guardFix(run: GitExec, work: string, before: string, after: string, input: { scope: "in_place" | "re_verify_partial"; prFiles: string[] }): Promise<FixGuardResult> {
  // No rename detection, NUL-separated: a moved file shows both its names (as a deletion and an addition), and no name is quoted or cut at a newline.
  const names = await run("git", [...HOST_GIT, ...at(work), "diff", "--no-renames", "-z", "--name-only", before, after]);
  const numstat = await run("git", [...HOST_GIT, ...at(work), "diff", "--no-renames", "-z", "--numstat", before, after]);
  if (names.code !== 0 || numstat.code !== 0) return { ok: false, paths: [], reason: "the fix's diff could not be read" };
  let added = 0;
  let removed = 0;
  const binary: string[] = [];
  for (const record of numstat.stdout.split("\0")) {
    const [a, r, ...path] = record.split("\t");
    if (a === "-" && r === "-") binary.push(path.join("\t"));
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return fixGuard({ scope: input.scope, changed: names.stdout.split("\0").filter(Boolean), prFiles: input.prFiles, added, removed, binary });
}

/**
 * Shows the card's branch in the user's repository once a round pushed it. A round that ran on a fresh clone shows nothing from there
 * (`isFreshWorkspace`): only what came back to the card and was pushed is shown. A refusal is a note on the card, never a failure.
 */
export async function showPushed(context: StageContext, repoPath: string | null, cardPath: string, branch: string): Promise<void> {
  if (!repoPath) return;
  const shown = await publishBranch(repoPath, cardPath, branch);
  if (!shown.ok) await context.note?.(shown.note).catch(() => {});
}

export async function headOfWorktree(run: GitExec, worktreePath: string): Promise<string | null> {
  const out = await run("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "HEAD"]);
  const sha = out.code === 0 ? out.stdout.trim() : "";
  return SHA.test(sha) ? sha : null;
}

/** The pack after a change at `sha`: stamped with it, the sentence appended, saved and published (section and comment) through `publishAndReady`, the one publisher: the pack check, the head check, the media gate and the record of a person's edit hold here too. */
export async function restampPack(
  deps: Pick<FixDeps, "github" | "evidence" | "stateDir">,
  taskId: string,
  slug: string,
  number: number,
  pack: EvidencePack,
  sha: string,
  sentence: string | null,
  extra: { repoPath?: string | null; emit?: StageContext["emit"] } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { save, publish, store } = deps.evidence;
  if (!save || !publish || !store) return { ok: false, reason: "the Evidence Pack cannot be re-published from here" };
  const next: EvidencePack = { ...pack, commitSha: sha, ...(sentence ? { summary: `${pack.summary} ${sentence}` } : {}) };
  try {
    const done = await publishAndReady({ github: deps.github, publish, save, localDir: (id) => store.dirFor(id, pack.commitSha), ...(deps.stateDir ? { stateDir: deps.stateDir } : {}) }, { task: { id: taskId, repoPath: extra.repoPath ?? null }, slug, number, headSha: sha, draft: false, pack: next, approved: false });
    if (!done.published) return { ok: false, reason: done.reason };
    if (done.edited) await extra.emit?.("evidence.edited", { ...done.edited }).catch(() => {});
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
  /** The scenario ids the reader named (`s1`, `s2`, ... by position in the pack); unknown ones are dropped. */
  named?: string[];
}

export type FixOutcome =
  | { ok: true; head: string; changed: boolean; textNote?: string; affected?: Array<{ id: string; text: string; result: string }>; replied: number; resolved: number; repliedTo: string[]; resolvedTo: string[]; summary: string; note?: string }
  | { ok: false; result: StageResult; checksFailed?: boolean; /** The evidence_valid record and the pack's scenario results, when the answer sent Evidence to run again. */ validity?: { recordId: string; before: Record<string, string> } };

const reasonOf = (result: StageResult): string => {
  const d = result.detail ?? {};
  const text = d.error ?? d.reason ?? d.summary;
  return typeof text === "string" && text ? postable(text, 400) : result.outcome;
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
  const remote = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remote && remote !== before) return { ok: false, result: escalated(`someone pushed to the PR (${remote.slice(0, 7)}); the fix would start from an old head`, "head_moved") };
  // The fix is made on a fresh clone at the head the PR has, never in the folder Build or an earlier fix used.
  const fresh = deps.loop.fresh ? await deps.loop.fresh.make(wt, branch, `${context.runId}-fix-${input.label}`) : null;
  const work = fresh?.path ?? wt;
  const ctxWork: StageContext = fresh ? { ...context, task: { ...task, worktreePath: fresh.path } } : context;
  const finish = async (): Promise<void> => {
    if (fresh) await deps.loop.fresh!.remove(fresh.path);
  };
  const stop = async (result: StageResult): Promise<FixOutcome> => {
    // The fresh clone is kept as it is after an escalation (the machine runs no git in it again until the stamp is checked); the rest resets.
    if (fresh) await deps.loop.fresh!.keep?.(fresh.path, task.id, context.runId);
    else await resetTo(run, work, before).catch(() => {});
    return { ok: false, result };
  };

  let pr;
  try {
    pr = await gatherPr(deps.github, input.slug, input.number);
  } catch (error) {
    return { ok: false, result: escalated(`the PR could not be read: ${messageOf(error)}`) };
  }
  const addressed = await deps.loop.runPack("addressing", subContext(ctxWork, `address-${input.label}`), { threads: { pr, threads: input.threads } });
  if (addressed.outcome !== "pass") return stop(escalated(`the fix could not be made: ${reasonOf(addressed)}`));
  const parsed = PrAddressAnswer.safeParse(addressed.detail?.answer);
  if (!parsed.success) return stop(escalated("the addressing pack gave no usable answer"));
  const answer = parsed.data;
  if (answer.kind === "escalated") return stop(escalated(postable(answer.reason || answer.summary || "the addressing pack asked for a person", 400), answer.escalation ?? "other"));

  const after = await headOfWorktree(run, work);
  if (!after) return stop(escalated("the worktree's head could not be read after the fix"));
  // A reply or summary that needed redacting is not posted, pushed or published: a person answers.
  if (carriesSecret(answer.summary) || answer.replies.some((r) => carriesSecret(r.body))) return stop(escalated(SECRET_REASON));
  const known = new Set(input.threads.map((t) => t.id));
  const replies = input.postReplies
    ? answer.replies.filter((r) => known.has(r.threadId)).map((r) => ({ threadId: r.threadId, body: postable(r.body), resolve: r.resolve })).filter((r) => r.body)
    : [];

  if (after !== before) {
    // The guard runs on what was committed, before any check: only the PR's own files and test files, no control-plane path, within the size of the scope.
    const prFiles = (await deps.github.prFiles(input.slug, input.number).catch(() => [])).flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path]));
    const guarded = await guardFix(run, work, before, after, { scope: input.scope, prFiles });
    if (!guarded.ok) return stop(escalated(`${postable(guarded.reason, 400)}; nothing was pushed`, "other", { paths: guarded.paths.slice(0, 10) }));
  }

  if (after === before) {
    // Nothing committed: an explanation is all there is. A CI fix with no change is no fix.
    if (!input.postReplies) return stop(escalated("the addressing pack made no change for the failing check"));
    await resetTo(run, work, before).catch(() => {});
    await finish();
    const posted = await followUp(deps.github, replies);
    return { ok: true, head: before, changed: false, replied: posted.replied, resolved: posted.resolved, repliedTo: replies.map((r) => r.threadId), resolvedTo: replies.filter((r) => r.resolve).map((r) => r.threadId), summary: answer.summary, ...(posted.ok ? {} : { note: posted.error }) };
  }

  // The checks run on exactly what will be pushed: the committed head, with whatever the pack left uncommitted gone.
  await resetTo(run, work, after);
  const checked = deps.loop.checks ? await deps.loop.checks(subContext(ctxWork, `checks-${input.label}`), before) : null;
  if (!checked) return stop(escalated("no checks runner is wired to prove the fix"));
  if (checked.outcome !== "pass") {
    // `checksFailed` is a fact the caller may teach fix_scope with: the fix was not as local as it was judged.
    const stopped = await stop(escalated(`the checks failed after the fix: ${reasonOf(checked)}`, "other", { findings: (checked.detail?.findings as Finding[] | undefined) ?? checked.findings ?? [] }));
    return stopped.ok ? stopped : { ...stopped, checksFailed: true };
  }
  let reviewedFindings: unknown[] | undefined;
  if (input.scope === "re_verify_partial") {
    const reviewed = await deps.loop.runPack("verifying", subContext(ctxWork, `verify-${input.label}`), { baseCommit: before });
    if (reviewed.outcome !== "pass") {
      return stop(escalated(`the review of the fix found a problem: ${reasonOf(reviewed)}`, "other", { findings: (reviewed.detail?.findings as Finding[] | undefined) ?? reviewed.findings ?? [] }));
    }
    reviewedFindings = (reviewed.detail?.findings as unknown[] | undefined) ?? reviewed.findings ?? [];
  }

  // The push is of what was checked: the head must still be the one the checks ran on, a descendant of the one we started from, with the PR's head where it was.
  const now = await headOfWorktree(run, work);
  const descends = (await run("git", [...HOST_GIT, ...at(work), "merge-base", "--is-ancestor", before, now ?? ""])).code === 0;
  if (now !== after || !descends) return stop(escalated("the branch changed while the fix was being checked; nothing was pushed"));
  // The push is of the branch's ref: it must be the checked commit, and HEAD must be that branch (refs are writable in the pack's container).
  const onBranch = await run("git", [...HOST_GIT, ...at(work), "symbolic-ref", "-q", "HEAD"]);
  const tip = await run("git", [...HOST_GIT, ...at(work), "rev-parse", `refs/heads/${branch}`]);
  if (onBranch.stdout.trim() !== `refs/heads/${branch}` || tip.stdout.trim() !== after) return stop(escalated("the branch ref is not the checked commit; nothing was pushed"));
  const remoteNow = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remoteNow && remoteNow !== before) return stop(escalated(`someone pushed to the PR (${remoteNow.slice(0, 7)}) while the fix was checked; nothing was pushed`, "head_moved"));
  if (fresh) {
    const back = await deps.loop.fresh!.bringBack(wt, fresh.path, branch, before);
    if (!back.ok) return stop(escalated(`what the fix committed could not be brought back to the card: ${postable(back.reason ?? "unknown", 300)}; nothing was pushed`));
  }
  const pushError = await pushBranch(run, branch, wt);
  if (pushError) return stop(escalated(pushError));
  await showPushed(context, task.repoPath ?? null, wt, branch);
  await finish();

  // From here the commit is on the PR: no reset, whatever else goes wrong.
  const posted = replies.length > 0 ? await followUp(deps.github, replies) : { ok: true as const, replied: 0, resolved: 0, skipped: [] as string[] };
  const out = { ok: true as const, head: after, changed: true, replied: posted.replied, resolved: posted.resolved, repliedTo: replies.map((r) => r.threadId), resolvedTo: replies.filter((r) => r.resolve).map((r) => r.threadId), summary: answer.summary, ...(posted.ok ? {} : { note: posted.error }) };

  const pack = input.pack;
  if (!pack) return out;
  const names = await run("git", [...HOST_GIT, ...at(wt), "diff", "--no-renames", "-z", "--name-only", before, after]);
  const stat = await run("git", [...HOST_GIT, ...at(wt), "diff", "--stat", "--no-color", before, after]);
  const changedNames = names.stdout.split("\0").filter(Boolean).slice(0, 200);
  const knownScenarios = pack.scenarios.map((s, i) => ({ id: `s${i + 1}`, text: s.text, result: s.result }));
  const tests = ((await deps.buildTests?.(task.id).catch(() => [])) ?? []).map((t) => ({ scenario: knownScenarios.find((k) => k.id === t.scenario || k.text === t.scenario)?.id ?? t.scenario, file: t.file }));
  const affected = affectedScenarios({ named: input.named ?? [], changed: changedNames, tests, known: knownScenarios });
  const ship: ShipContext = {
    kind: "fix",
    fix: {
      changed: changedNames,
      ...(affected.length > 0 ? { affected } : {}),
      diffSummary: stat.stdout.slice(0, 4000),
      scenarios: pack.scenarios.map((s) => ({ text: s.text, result: s.result })),
      threadSummary: input.threadSummary.slice(0, 500),
    },
  };
  const valid = await judgeShip(deps, "evidence_valid", ship, task.repoPath);
  // Unsure whether the pack is still true: Evidence runs again, the safe side.
  if (!valid.ok) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); ${valid.reason}, so Evidence runs again`, "head_moved") };
  let choice = valid.choice;
  let textNote: string | undefined;
  if (choice === "refresh_media") {
    // Honoured only when a scenario may have changed or a rendered surface did; otherwise it is read as refresh_text, and the note says so.
    if (affected.length > 0 || touchesRenderedSurface(changedNames)) return { ok: false, ...(valid.recordId ? { validity: { recordId: valid.recordId, before: Object.fromEntries(knownScenarios.map((k) => [k.id, k.result])) } } : {}), result: escalated(`the fix is pushed (${after.slice(0, 7)}) and changes what the scenarios show: the browser runs again at the new head and Evidence re-makes the media`, "head_moved", { refresh: "media" }) };
    choice = "refresh_text";
    textNote = "refresh_media was read as refresh_text: no scenario is affected and no rendered surface changed";
  }
  if (choice === "refresh_text") {
    const delta = ((reviewedFindings ?? []) as Array<{ id?: unknown; title?: unknown; severity?: unknown }>).flatMap((f) => (typeof f.title === "string" ? [{ id: String(f.id ?? f.title), title: postable(f.title, 200), severity: String(f.severity ?? "info"), resolution: "found in the delta review of the fix" }] : []));
    const diff = await (deps.branchDiff ?? defaultBranchDiff)(wt, task.repoPath).catch(() => null);
    const next = refreshPackText(pack, { sha: after, fix: { scope: input.scope, summary: input.threadSummary, at: new Date().toISOString() }, delta, diff, now: new Date().toISOString() });
    const { save, publish, store } = deps.evidence;
    if (!save || !publish || !store) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); the Evidence Pack cannot be re-published from here, so Evidence runs again`, "head_moved") };
    const done = await publishAndReady({ github: deps.github, publish, save, localDir: (id) => store.dirFor(id, pack.commitSha), ...(deps.stateDir ? { stateDir: deps.stateDir } : {}) }, { task: { id: task.id, repoPath: task.repoPath ?? null }, slug: input.slug, number: input.number, headSha: after, draft: false, pack: next, approved: false }).catch((error: unknown) => ({ published: false as const, reason: `re-publishing the Evidence Pack failed: ${messageOf(error)}` }));
    if (!done.published) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); ${done.reason}, so Evidence runs again`, "head_moved") };
    if (done.edited) await context.emit?.("evidence.edited", { ...done.edited }).catch(() => {});
    return { ...out, affected, ...(textNote ? { textNote } : {}) };
  }
  const stamped = await restampPack(deps, task.id, input.slug, input.number, pack, after, null, { repoPath: task.repoPath ?? null, emit: context.emit });
  if (!stamped.ok) return { ok: false, result: escalated(`the fix is pushed (${after.slice(0, 7)}); ${stamped.reason}, so Evidence runs again`, "head_moved") };
  return { ...out, affected };
}
