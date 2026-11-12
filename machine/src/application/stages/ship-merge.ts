// The ship watch's answer to a branch that no longer merges: when a rebase stops on a conflict (the default branch, or a stacked card's
// parent, moved under it), the base is merged into the branch on a fresh clone instead, and the conflicts go to the `addressing` pack as one
// thread. The machine merges and makes every commit that ships; the pack only edits the conflicted files. What it resolved is checked by the
// host: it touched only those files, no conflict marker is left, the project's checks pass. One merge commit, with the branch's head and the
// base as its parents and the resolved tree, is brought back to the card and pushed (never forced). The temporary commit the pack started
// from, which holds the markers, never ships. Verify then runs again on the new head.
import { PrAddressAnswer, type EvidencePack } from "@hardness/contracts";

import { at } from "../../adapters/git/machine-repo.ts";
import { BASE_REF, HOST_GIT, type GitExec } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { postable } from "../../domain/postable.ts";
import { messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { pushBranch } from "./deliver.ts";
import { failureGist } from "../../domain/failure-gist.ts";
import { type FixDeps, escalated, headOfWorktree, resetTo, subContext } from "./ship-fixes.ts";
import { gatherPr } from "./pr-review.ts";

const SHA = /^[0-9a-f]{40,64}$/;
/** A line git writes for a conflict: the opening, the divider and the closing marker. */
const MARKER = /^(<{7}( .*)?|={7}|>{7}( .*)?)$/m;
const CONFLICTS_SHOWN = 50;

export interface MergeInput {
  slug: string;
  number: number;
  /** The base's tip, a sha the machine read from its own fetch (never a name from the PR), and how to call it. */
  base: { sha: string; name: string };
  /** Names the sub-runs. */
  label: string;
  pack: EvidencePack | null;
}

export type MergeOutcome =
  | { ok: true; head: string; resolved: string[]; result: StageResult }
  | { ok: false; result: StageResult };

/** Merges `input.base` into the card's branch, resolving any conflict with the `addressing` pack; see the file's head. */
export async function mergeRound(deps: FixDeps, context: StageContext, input: MergeInput): Promise<MergeOutcome> {
  const { task } = context;
  const wt = task.worktreePath;
  const branch = task.branch;
  if (!wt || !branch) return { ok: false, result: escalated("the task has no worktree to merge in") };
  if (!SHA.test(input.base.sha)) return { ok: false, result: escalated("the base's tip is not a commit id; nothing was merged") };
  const run: GitExec = deps.loop.exec ?? realExec;
  const before = await headOfWorktree(run, wt);
  if (!before) return { ok: false, result: escalated("the worktree's head could not be read") };
  const remote = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remote && remote !== before) return { ok: false, result: escalated(`someone pushed to the PR (${remote.slice(0, 7)}); the merge would start from an old head`, "head_moved") };

  const fresh = deps.loop.fresh ? await deps.loop.fresh.make(wt, branch, `${context.runId}-merge-${input.label}`) : null;
  const work = fresh?.path ?? wt;
  const git = (...args: string[]) => run("git", [...HOST_GIT, ...at(work), ...args]);
  const ctxWork: StageContext = fresh ? { ...context, task: { ...task, worktreePath: fresh.path } } : context;
  const stop = async (result: StageResult): Promise<MergeOutcome> => {
    await git("merge", "--abort").catch(() => {});
    if (fresh) await deps.loop.fresh!.keep?.(fresh.path, task.id, context.runId);
    else await resetTo(run, work, before).catch(() => {});
    return { ok: false, result };
  };
  const message = `Merge ${input.base.name} into ${branch}`;

  const merged = await git("merge", "--no-ff", "--no-commit", "--no-verify", input.base.sha);
  const conflicted = (await git("diff", "--name-only", "-z", "--diff-filter=U")).stdout.split("\0").filter(Boolean);
  if (merged.code !== 0 && conflicted.length === 0) return stop(escalated(`merging ${input.base.name} into the branch failed: ${postable((merged.stderr || merged.stdout).trim(), 300)}`));

  let resolvedTree: string;
  if (conflicted.length === 0) {
    resolvedTree = (await git("write-tree")).stdout.trim();
  } else {
    // The markers are committed on a temporary tip the pack starts from (its own git sees only commits); this commit never ships.
    await git("add", "-A");
    const temp = await git("commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", `luna: ${message} (conflicts to resolve)`);
    if (temp.code !== 0) return stop(escalated(`the merge could not be staged for the fix: ${postable((temp.stderr || temp.stdout).trim(), 300)}`));
    const withMarkers = await headOfWorktree(run, work);
    if (!withMarkers) return stop(escalated("the merge's head could not be read"));

    let pr;
    try {
      pr = await gatherPr(deps.github, input.slug, input.number);
    } catch (error) {
      return stop(escalated(`the PR could not be read: ${messageOf(error)}`));
    }
    const listed = conflicted.slice(0, CONFLICTS_SHOWN).map((p) => `- ${p}`).join("\n");
    const body = [
      `The branch conflicts with ${input.base.name} (${input.base.sha.slice(0, 7)}), which moved since the branch left it. The machine merged it; git's conflict markers are committed in:`,
      listed,
      "Resolve every conflict in those files and touch no other file. Keep this card's change. Carry in what the base added or changed: it is newer than the branch, so a fact, a section or a code path the base brought stays, written the way this card writes (its style, its rules). Remove every marker line. Then commit.",
    ].join("\n");
    const thread = { id: "merge", path: null, line: null, comments: [{ author: "machine", body: body.slice(0, 6000), at: new Date().toISOString() }] };
    const addressed = await deps.loop.runPack("addressing", subContext(ctxWork, `merge-${input.label}`), { threads: { pr, threads: [thread] } });
    if (addressed.outcome !== "pass") return stop(escalated(`the conflicts with ${input.base.name} could not be resolved: ${postable(String(addressed.detail?.error ?? addressed.detail?.reason ?? addressed.outcome), 300)}`, "other", { conflicts: conflicted.slice(0, 10) }));
    const answer = PrAddressAnswer.safeParse(addressed.detail?.answer);
    if (!answer.success) return stop(escalated("the addressing pack gave no usable answer for the conflicts", "other", { conflicts: conflicted.slice(0, 10) }));
    if (answer.data.kind === "escalated") return stop(escalated(postable(answer.data.reason || answer.data.summary || "the addressing pack asked for a person", 400), answer.data.escalation ?? "other", { conflicts: conflicted.slice(0, 10) }));

    const after = await headOfWorktree(run, work);
    if (!after || after === withMarkers) return stop(escalated(`the conflicts with ${input.base.name} were not resolved: nothing was committed`, "other", { conflicts: conflicted.slice(0, 10) }));
    if ((await git("merge-base", "--is-ancestor", withMarkers, after)).code !== 0) return stop(escalated("the resolution does not build on the merge; nothing was pushed"));
    // Only the conflicted files: a resolution is not a place for another change.
    const touched = (await git("diff", "--no-renames", "-z", "--name-only", withMarkers, after)).stdout.split("\0").filter(Boolean);
    const outside = touched.filter((p) => !conflicted.includes(p));
    if (outside.length > 0) return stop(escalated(`the resolution changed files that had no conflict (${outside.slice(0, 5).join(", ")}); nothing was pushed`, "other", { paths: outside.slice(0, 10) }));
    // No marker left in a conflicted file that still exists.
    const left: string[] = [];
    for (const path of conflicted) {
      const shown = await git("show", `${after}:${path}`);
      if (shown.code === 0 && MARKER.test(shown.stdout)) left.push(path);
    }
    if (left.length > 0) return stop(escalated(`conflict markers are left in ${left.slice(0, 5).join(", ")}; nothing was pushed`, "other", { conflicts: left.slice(0, 10) }));
    resolvedTree = (await git("rev-parse", `${after}^{tree}`)).stdout.trim();
  }

  // The one commit that ships: the resolved tree, with the branch's head and the base as its parents.
  const made = await git("commit-tree", resolvedTree, "-p", before, "-p", input.base.sha, "-m", message);
  const final = made.stdout.trim();
  if (made.code !== 0 || !SHA.test(final)) return stop(escalated(`the merge commit could not be made: ${postable((made.stderr || made.stdout).trim(), 300)}`));
  await git("merge", "--abort").catch(() => {});
  await git("update-ref", `refs/heads/${branch}`, final);
  await git("reset", "--hard", "--quiet", final);

  // The project's checks run on exactly what will be pushed.
  const checked = deps.loop.checks ? await deps.loop.checks(subContext(ctxWork, `merge-checks-${input.label}`), before) : null;
  if (!checked) return stop(escalated("no checks runner is wired to prove the merge"));
  if (checked.outcome !== "pass") return stop(escalated(`the checks failed after merging ${input.base.name}: ${failureGist(String(checked.detail?.error ?? checked.detail?.summary ?? checked.outcome), 300)}`, "other", { findings: checked.detail?.findings ?? checked.findings ?? [] }));

  const remoteNow = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remoteNow && remoteNow !== before) return stop(escalated(`someone pushed to the PR (${remoteNow.slice(0, 7)}) while the merge was checked; nothing was pushed`, "head_moved"));
  if (fresh) {
    const back = await deps.loop.fresh!.bringBack(wt, fresh.path, branch, before);
    if (!back.ok) return stop(escalated(`the merge could not be brought back to the card: ${postable(back.reason ?? "unknown", 300)}; nothing was pushed`));
  }
  const pushError = await pushBranch(run, branch, wt);
  if (pushError) return stop(escalated(pushError));
  if (fresh) await deps.loop.fresh!.remove(fresh.path);
  // The card's base is the base it merged: its scope and its diffs are measured from there from now on.
  await run("git", [...HOST_GIT, ...at(wt), "update-ref", BASE_REF, input.base.sha]);

  const resolved = conflicted.slice(0, 10);
  const said = `merged ${input.base.name} into the branch (${final.slice(0, 7)})${resolved.length ? `, resolving the conflicts in ${resolved.join(", ")}` : ""}; Verify runs again`;
  return { ok: true, head: final, resolved, result: escalated(said, "head_moved", { refresh: "verify" }) };
}
