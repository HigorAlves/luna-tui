// The delivering stage: push the task's branch and open a draft PR on the host, so CI starts
// early. The push is git with your own credentials; the PR is the GitHub port.
import { at } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT, type RebaseResult, branchBase, defaultBranchFile, isBranchName, leaveStack, originSlugOf, rebaseOntoBase, stackOf, unstack as hostUnstack } from "../../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../../adapters/process/exec.ts";
import { PR_TEMPLATE_PATHS, type PrExtra, buildPr, mergePrSection } from "../../domain/prbody.ts";
import { approvedPlan, approvedScenarios } from "../../domain/stage-input.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import type { TaskRow } from "../../domain/task.ts";
import { cardOf } from "../../domain/card-fields.ts";
import { isDocsOnly } from "../../domain/docs-only.ts";
import { looksLikeTestPath } from "../../domain/locked-files.ts";
import type { StackFacts } from "../stack.ts";
import { alreadyMerged } from "./already-merged.ts";
import type { MergeInput, MergeOutcome } from "./ship-merge.ts";

export type ExecFn = (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<ExecResult>;

export interface DeliverDeps {
  /** The repository's PR template (default: read from its default branch); tests pass one. */
  prTemplate?: (repoPath: string | null) => Promise<string | null>;
  exec: ExecFn;
  github: GitHub;
  /** The `owner/name` a worktree pushes to; tests inject one, the default reads the origin remote. */
  slugOf?: (cwd: string) => Promise<string | null>;
  /** The repo's default branch, for the rebase: GitHub's answer for the slug (default: `github.defaultBranch`), never the host's guess; null is unknown. */
  defaultBranch?: (repoPath: string, slug?: string) => Promise<string | null>;
  /** The commit the branch forked from and the one it is at, for the body; absent or null leaves them out. */
  commitsOf?: (worktreePath: string, repoPath: string) => Promise<{ base: string | null; head: string | null } | null>;
  /** A stacked card's parent (`stackFactsOf`), and what to do about it: drop the card's base, rebase, unstack (default: the host git helpers), the base commit the workspace records. Absent, a card's base is not looked at. */
  /** Resolves a conflict the rebase and the plain merge could not (`mergeRound`: the addressing pack resolves the files, the project's checks prove the result, the merge is pushed). Absent, a conflict asks a person. */
  resolveConflicts?: (context: StageContext, input: MergeInput) => Promise<MergeOutcome>;
  stacked?: {
    facts: (slug: string, task: TaskRow) => Promise<StackFacts | null>;
    clearBase: (taskId: string) => Promise<void>;
    rebase?: typeof rebaseOntoBase;
    unstack?: typeof hostUnstack;
    baseSha?: (worktreePath: string) => Promise<string | null>;
  };
}

/** A command's output, or a hint when it produced none. */
export function describe(result: ExecResult): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}`;
}

/** What the machine itself pushed, kept in the card's own repository as `refs/luna/pushed/<name>`: a commit reachable from one is not lost if the workspace goes. */
async function recordPushed(exec: ExecFn, cwd: string, name: string, commit: string): Promise<void> {
  await exec("git", [...HOST_GIT, ...at(cwd), "update-ref", `refs/luna/pushed/${name}`, commit]).catch(() => {});
}

/** What git says when it had no credential to push with (no token in the machine, no tty to ask on). */
const NO_CREDENTIAL = /could not read (?:Username|Password)|terminal prompts disabled|Authentication failed/i;
const NO_CREDENTIAL_SAID = "the machine has no GitHub credential: GH_TOKEN is empty in the machine container; restart it with `pnpm start`";

/** A push failure as the stage's result: a missing credential is the machine's problem (`env_broken`), not something wrong with the card. */
export function pushFailure(error: string): StageResult {
  return { outcome: "fail", detail: error.startsWith(NO_CREDENTIAL_SAID) ? { error, escalation: "env_broken", envBroken: true } : { error } };
}

/** Pushes the task's branch from its worktree. Returns an error message on failure. */
export async function pushBranch(exec: ExecFn, branch: string, cwd: string, options: { force?: boolean; lease?: string } = {}): Promise<string | null> {
  // `--force-with-lease`: after a rebase, only over the head this worktree last saw on the task's own branch.
  // With `lease` (a sha the machine read) the lease is pinned to it, so a concurrent fetch cannot move what it is compared with.
  if (options.lease !== undefined && !/^[0-9a-f]{40,64}$/.test(options.lease)) return "git push refused: the lease is not a commit sha";
  const force = options.force ? [options.lease ? `--force-with-lease=refs/heads/${branch}:${options.lease}` : "--force-with-lease"] : [];
  const pushed = await exec("git", [...HOST_GIT, ...at(cwd), "push", ...force, "-u", "origin", branch]);
  if (pushed.code !== 0) return NO_CREDENTIAL.test(describe(pushed)) ? `${NO_CREDENTIAL_SAID} (git: ${describe(pushed)})` : `git push failed: ${describe(pushed)}`;
  await recordPushed(exec, cwd, branch, `refs/heads/${branch}`);
  return null;
}

const SHA = /^[0-9a-f]{40,64}$/;

/** The worktree's head, read before the machine rewrites the branch (a rebase); null when it cannot be read. */
export async function headSha(exec: ExecFn, cwd: string): Promise<string | null> {
  const out = await exec("git", [...HOST_GIT, ...at(cwd), "rev-parse", "HEAD"]).catch(() => null);
  const sha = out && out.code === 0 ? out.stdout.trim() : "";
  return SHA.test(sha) ? sha : null;
}

/** Puts the worktree back at a head the machine read: after a forced push that failed, the branch is not left rewritten (a later plain push would be refused as non-fast-forward). */
export async function restoreHead(exec: ExecFn, cwd: string, sha: string): Promise<void> {
  if (!SHA.test(sha)) return;
  await exec("git", [...HOST_GIT, ...at(cwd), "reset", "--hard", "--quiet", sha]).catch(() => {});
  await exec("git", [...HOST_GIT, ...at(cwd), "clean", "-fd", "--quiet"]).catch(() => {});
}

/** The ref a Build checkpoint goes to: outside refs/heads and refs/tags, so no CI runs on it and no PR head moves. */
export const checkpointRef = (branch: string): string => `refs/luna/wip/${branch}`;

/** Pushes the worktree's HEAD to the branch's checkpoint ref (forced: the ref is the machine's own). Returns an error message on failure. */
export async function pushCheckpoint(exec: ExecFn, branch: string, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string | null> {
  const pushed = await exec("git", [...HOST_GIT, ...at(cwd), "push", "--force", "origin", `HEAD:${checkpointRef(branch)}`], options);
  if (pushed.code !== 0) return `git push failed: ${describe(pushed)}`;
  await recordPushed(exec, cwd, `wip/${branch}`, "HEAD");
  return null;
}

/** What the record, the plan and the scenarios say, for the machine's section of the body. */
/** The repository's PR template, read from its default branch in the user's checkout (never a card's folder); null when it has none. */
export async function prTemplateOf(repoPath: string | null): Promise<string | null> {
  if (!repoPath) return null;
  return defaultBranchFile(repoPath, PR_TEMPLATE_PATHS, 32_768).catch(() => null);
}

export function prExtraOf(context: StageContext, commits: { base: string | null; head: string | null } | null, template: string | null = null): PrExtra {
  const { task } = context;
  return {
    ...(template ? { template } : {}),
    record: task.record,
    // The plan's version: how many times a plan was approved (a plan sent back and approved again counts).
    planVersion: context.approvals.filter((a) => a.kind === "awaiting_approval" && a.decision === "approved").length || null,
    scenarios: approvedScenarios(context.approvals).map((sc) => ({ id: sc.id ?? "", title: sc.title, criterion: sc.criterion_ref ?? null, test: context.prFacts?.tests.get(sc.id ?? "") ?? null })),
    findings: context.prFacts?.findings ?? [],
    outOfMap: context.prFacts?.outOfMap ?? [],
    ...(commits ?? {}),
  };
}

/** Opens the PR for a task's branch with the caveman body. */
export async function openTaskPr(github: GitHub, slug: string, context: StageContext, draft: boolean, extra?: PrExtra, base?: string) {
  const { task } = context;
  const { title, body } = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug: slug, ...(extra ? { extra } : {}) });
  return github.openPr(slug, { title, body, head: task.branch!, draft, ...(base ? { base } : {}) });
}

/** What a card changed since it forked, split by whether the default branch already holds that exact version of the file. Null when it cannot be read. */
export async function landedOnBase(run: ExecFn, worktreePath: string, baseRef: string): Promise<{ landed: string[]; remaining: string[] } | null> {
  const git = (...args: string[]) => run("git", [...HOST_GIT, ...at(worktreePath), ...args]);
  const fork = await git("merge-base", "HEAD", baseRef);
  const sha = fork.stdout.trim();
  if (fork.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return null;
  const changed = await git("diff", "--no-renames", "-z", "--name-only", sha, "HEAD");
  if (changed.code !== 0) return null;
  const files = changed.stdout.split("\0").filter(Boolean);
  if (files.length === 0) return null;
  const landed: string[] = [];
  const remaining: string[] = [];
  for (const file of files) ((await git("diff", "--quiet", baseRef, "HEAD", "--", file)).code === 0 ? landed : remaining).push(file);
  return { landed, remaining };
}

export function deliverRunner(deps: DeliverDeps): StageRunner {
  /** The default branch for a repository slug, read from GitHub; a failed read is unknown. */
  const defaultFor = (slug: string) => async (repoPath: string): Promise<string | null> =>
    deps.defaultBranch ? await deps.defaultBranch(repoPath, slug).catch(() => null) : await deps.github.defaultBranch(slug).catch(() => null);
  const slugOf = deps.slugOf ?? originSlugOf;
  return async (context) => {
    const { task } = context;
    if (!task.repoPath || !task.branch || !task.worktreePath) {
      return { outcome: "fail", detail: { error: "no branch to deliver; the implementer never ran for real" } };
    }
    // The card's own PR may have merged while the card was outside the ship watch: it shipped, so nothing is rebased, merged or pushed again.
    if (context.recordedPrs?.length) {
      const own = await slugOf(task.worktreePath);
      const shipped = own ? await alreadyMerged(deps.github, own, context.recordedPrs, () => defaultFor(own)(task.repoPath!)) : null;
      if (shipped) return shipped;
    }
    // A stacked card: what its parent is now decides what is pushed, and what the PR targets.
    let parent: StackFacts | null = null;
    let restacked = false;
    if (deps.stacked && cardOf(task).base) {
      const stackSlug = await slugOf(task.worktreePath);
      if (!stackSlug) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
      try {
        parent = await deps.stacked.facts(stackSlug, task);
      } catch (error) {
        return { outcome: "fail", detail: { error: messageOf(error) } };
      }
      const defaultOf = defaultFor(stackSlug);
      if (parent?.parent.state === "gone") {
        const short = parent.parent.id.slice(0, 8);
        return { outcome: "fail", detail: { error: `the card this one is stacked on (${short}) was archived or its PR closed without merging; its commits are in this branch, so a person decides what happens to it`, escalation: "other" } };
      }
      const stopped = (rebased: RebaseResult, what: string): StageResult | null =>
        rebased.ok ? null : { outcome: "fail", detail: { error: rebased.conflicts.length > 0 ? `${what} stopped on: ${rebased.conflicts.join(", ")}` : `${what} could not be done: ${rebased.error}`, conflicts: rebased.conflicts, escalation: "other" } };
      /**
       * A move that stopped on conflicts goes to the merge round, as the CONFLICTING path below does, with the base the move was to land on (the parent's
       * branch, or the default branch once the parent merged): its tip was fetched by the move. "merged" when the round landed it (it pushed the
       * merge itself); a stop to return when the round did not land it; null when it cannot run (no resolver, no PR yet, no usable tip) and the first stop stands.
       */
      const mergeInstead = async (done: RebaseResult, what: string, baseName: string | null): Promise<"merged" | StageResult | null> => {
        if (done.ok || done.conflicts.length === 0 || !deps.resolveConflicts || !baseName || !isBranchName(baseName)) return null;
        const existing = await deps.github.findPr(stackSlug, task.branch!).catch(() => null);
        if (!existing) return null;
        const tip = (await deps.exec("git", [...HOST_GIT, ...at(task.worktreePath!), "rev-parse", "--verify", `refs/remotes/origin/${baseName}^{commit}`])).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/.test(tip)) return null;
        const merged = await deps.resolveConflicts(context, { slug: stackSlug, number: existing.number, base: { sha: tip, name: baseName }, label: "deliver-stack", pack: null });
        if (merged.ok) return "merged";
        const first = stopped(done, what)!;
        return { ...first, detail: { ...first.detail, error: `${String(first.detail?.error)}; merging instead did not resolve it: ${String(merged.result.detail?.reason ?? merged.result.detail?.error ?? "the merge did not land")}` } };
      };
      if (parent?.parent.state === "merged") {
        const what = "moving this card onto the default branch after its parent merged";
        const done = await (deps.stacked.unstack ?? hostUnstack)(deps.exec, task.worktreePath, task.repoPath, defaultOf);
        const instead = await mergeInstead(done, what, await defaultOf(task.repoPath));
        if (instead === "merged") await leaveStack(deps.exec, task.worktreePath);
        else if (instead) return instead;
        else {
          const failed = stopped(done, what);
          if (failed) return failed;
        }
        await deps.stacked.clearBase(task.id);
        restacked = true;
      } else if (parent?.parent.head) {
        const recorded = await (deps.stacked.baseSha ?? (async (path: string) => (await stackOf(path)).sha))(task.worktreePath);
        if (recorded !== parent.parent.head) {
          const what = "the rebase onto the parent's new tip";
          const done = await (deps.stacked.rebase ?? rebaseOntoBase)(deps.exec, task.worktreePath, task.repoPath, defaultOf, parentWinsFor(context));
          const instead = await mergeInstead(done, what, parent.parent.branch);
          if (done.ok && done.resolved?.length) await context.note?.(`rebased onto the parent's new tip; the parent's version kept for ${done.resolved.join(", ")} (not this card's to change)`).catch(() => {});
          if (instead && instead !== "merged") return instead;
          // A rebase is pushed forced; a merge the round landed is already on the PR and descends from it.
          if (!instead) {
            const failed = stopped(done, what);
            if (failed) return failed;
            restacked = true;
          }
        }
      }
    }
    const pushError = await pushBranch(deps.exec, task.branch, task.worktreePath, restacked ? { force: true } : {});
    if (pushError) return pushFailure(pushError);
    const slug = await slugOf(task.worktreePath);
    if (!slug) return { outcome: "fail", detail: { error: "the worktree's origin is not a GitHub repository" } };
    const stackedOn = parent?.parent.state === "open" ? parent.parent : null;
    try {
      const existing = await deps.github.findPr(slug, task.branch);
      const commits = deps.commitsOf ? await deps.commitsOf(task.worktreePath, task.repoPath).catch(() => null) : null;
      const template = await (deps.prTemplate ?? prTemplateOf)(task.repoPath);
      const extra = { ...prExtraOf(context, commits, template), ...(stackedOn?.number ? { stack: { number: stackedOn.number } } : {}) };
      const ref = existing ?? (await openTaskPr(deps.github, slug, context, true, extra, stackedOn?.branch));
      // A PR that exists keeps whatever a person wrote: only the machine's own section is replaced.
      if (existing) {
        const current = await deps.github.prFacts(slug, ref.number).catch(() => null);
        const fresh = buildPr({ task, plan: approvedPlan(context.approvals), repoSlug: slug, extra }).body;
        if (current) await deps.github.updatePrBody(slug, ref.number, mergePrSection(current.body ?? "", fresh)).catch(() => {});
      }
      // A stacked card's PR targets its parent's branch while the parent is open, and the default branch once it left the stack.
      if (existing && deps.stacked && parent && (stackedOn || restacked)) {
        const wanted = stackedOn ? stackedOn.branch : parent.defaultBranch;
        const now = (await deps.github.prFacts(slug, ref.number).catch(() => null))?.baseRefName ?? null;
        if (wanted && now !== null && now !== wanted) await deps.github.retargetPr(slug, ref.number, wanted);
      }
      // GitHub knows whether the branch still merges: once a conflict is reported, rebase it once and push it back.
      const facts = await deps.github.prFacts(slug, ref.number).catch(() => null);
      let rebase: Record<string, unknown> = facts?.mergeable === "UNKNOWN" ? { mergeable: "UNKNOWN" } : {};
      if (facts?.mergeable === "CONFLICTING") {
        const base = defaultFor(slug);
        if ((await base(task.repoPath)) === null) return { outcome: "fail", detail: { error: "the default branch is not known from GitHub: nothing was rebased or pushed again", escalation: "other" } };
        // The head the branch was pushed at: the lease for the forced push, and where the branch goes back to if that push fails.
        const before = await headSha(deps.exec, task.worktreePath);
        const rebased: RebaseResult = await rebaseOntoBase(deps.exec, task.worktreePath, task.repoPath, base);
        if (!rebased.ok) {
          const files = rebased.conflicts.join(", ");
          const baseName = (await base(task.repoPath)) ?? "the default branch";
          const said = rebased.conflicts.length > 0 ? `the branch conflicts with ${baseName} and the rebase stopped on: ${files}` : `the branch conflicts with the default branch and could not be rebased: ${rebased.error}`;
          const stop = (error: string, extra: Record<string, unknown> = {}): StageResult => ({ outcome: "fail", detail: { error, conflicts: rebased.conflicts, escalation: "other", ...extra } });
          if (rebased.conflicts.length === 0 || !isBranchName(baseName)) return stop(said);
          const baseRef = `refs/remotes/origin/${baseName}`;
          // A card whose every changed file is already the default branch's version has nothing left to deliver: say so, run nothing.
          const already = await landedOnBase(deps.exec, task.worktreePath, baseRef);
          if (already && already.remaining.length === 0) {
            return stop(`${said}. Every file this card changed is already on ${baseName} exactly as the card has it (${already.landed.slice(0, 10).join(", ")}): there is nothing left to deliver. Archive the card.`, { verdict: "already_on_base", landed: already.landed, options: ["archive the card"] });
          }
          if (!deps.resolveConflicts) return stop(said);
          const tip = (await deps.exec("git", [...HOST_GIT, ...at(task.worktreePath), "rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
          if (!/^[0-9a-f]{40,64}$/.test(tip)) return stop(said);
          const merged = await deps.resolveConflicts(context, { slug, number: ref.number, base: { sha: tip, name: baseName }, label: "deliver", pack: null });
          if (!merged.ok) return stop(`${said}; merging instead did not resolve it: ${String(merged.result.detail?.reason ?? merged.result.detail?.error ?? "the merge did not land")}`);
          return {
            outcome: "pass",
            detail: { prUrl: ref.url, prNumber: ref.number, draft: ref.isDraft, reused: existing !== null, merged: true, resolved: merged.resolved, onto: `origin/${baseName}` },
            events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url: ref.url, number: ref.number } }],
          };
        }
        const forced = await pushBranch(deps.exec, task.branch, task.worktreePath, { force: true, ...(before ? { lease: before } : {}) });
        if (forced) {
          if (before) await restoreHead(deps.exec, task.worktreePath, before);
          return pushFailure(forced);
        }
        rebase = { rebased: true, onto: rebased.onto, ...(rebased.merged ? { merged: true } : {}) };
      }
      return {
        outcome: "pass",
        detail: { prUrl: ref.url, prNumber: ref.number, draft: ref.isDraft, reused: existing !== null, ...rebase },
        events: [{ at: new Date().toISOString(), kind: "pr.opened", payload: { url: ref.url, number: ref.number } }],
      };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
  };
}

/** The real runner needs the GitHub port, which main.ts builds from the token. */
export const realDeliverRunner = (github: GitHub, stacked?: DeliverDeps["stacked"], resolveConflicts?: DeliverDeps["resolveConflicts"]): StageRunner => deliverRunner({
    exec: realExec,
    github,
    ...(stacked ? { stacked } : {}),
    ...(resolveConflicts ? { resolveConflicts } : {}),
    commitsOf: async (worktreePath, repoPath) => {
      const head = await realExec("git", [...HOST_GIT, ...at(worktreePath), "rev-parse", "HEAD"]).catch(() => null);
      return { base: await branchBase(worktreePath, repoPath).catch(() => null), head: head && head.code === 0 ? head.stdout.trim() : null };
    },
  });

/** Which files in a rebase conflict the parent's version wins, from the card's approved plan: a file the plan does not touch is not the card's,
 *  and on a docs-only plan neither is a test (a docs card stacked on another kept both editing the first card's prose test, and every rebase
 *  stopped on it). A file the plan touches still stops the rebase: settling it needs judgement. With no plan, nothing is settled by itself. */
export function parentWinsFor(context: Pick<StageContext, "approvals">): { parentWins?: (path: string) => boolean } {
  const plan = approvedPlan(context.approvals);
  const touched = (plan?.slices ?? []).flatMap((s) => (s as { touchpoints?: string[] }).touchpoints ?? []);
  if (touched.length === 0) return {};
  const planned = new Set(touched);
  const docs = isDocsOnly(touched);
  return { parentWins: (path) => !planned.has(path) || (docs && looksLikeTestPath(path)) };
}

