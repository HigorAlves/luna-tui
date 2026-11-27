// The ship watch's answer to a branch that no longer merges: when a rebase stops on a conflict (the default branch, or a stacked card's
// parent, moved under it), the base is merged into the branch on a fresh clone instead, and the conflicts go to the `addressing` pack as one
// thread. The machine merges and makes every commit that ships; the pack only edits the conflicted files. What it resolved is checked by the
// host: it touched only those files, no conflict marker is left, the project's checks pass. One merge commit, with the branch's head and the
// base as its parents and the resolved tree, is brought back to the card and pushed (never forced). The temporary commit the pack started
// from, which holds the markers, never ships. Verify then runs again on the new head.
import { PrAddressAnswer, type CheckSpec, type EvidencePack } from "@hardness/contracts";

import { at } from "../../adapters/git/machine-repo.ts";
import { BASE_REF, HOST_GIT, type GitExec } from "../../adapters/git/worktree.ts";
import { exec as realExec } from "../../adapters/process/exec.ts";
import { LOCKFILES } from "../../domain/env-hash.ts";
import { postable } from "../../domain/postable.ts";
import { messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { pushBranch } from "./deliver.ts";
import { failureGist } from "../../domain/failure-gist.ts";
import { type FixDeps, escalated, headOfWorktree, resetTo, showPushed, subContext } from "./ship-fixes.ts";
import { gatherPr } from "./pr-review.ts";

const SHA = /^[0-9a-f]{40,64}$/;
/** A line git writes for a conflict: the opening, the divider and the closing marker. */
const MARKER = /^(<{7}( .*)?|={7}|>{7}( .*)?)$/m;
const CONFLICTS_SHOWN = 50;
/** Rounds the pack gets to fix what fails only on the merged tree (DISC-53: the second fixed the /docs test and added an import Biome orders elsewhere). */
const MERGE_REPAIR_ROUNDS = 3;
/** A check that holds every file to a rule (lint, types, format): a repair round runs it on its result before committing. */
const GATE_CHECK = /lint|type-?check|tsc|format|fmt|prettier|eslint|biome/i;

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

/** The files a dependency install reads: a lockfile, a package manifest or a package manager's config. */
const MANIFESTS = new Set<string>([...LOCKFILES, "package.json", "pnpm-workspace.yaml", ".yarnrc.yml", ".yarnrc", ".npmrc", "Cargo.toml", "go.mod", "pyproject.toml", "Pipfile", "Gemfile", "composer.json"]);
const installReads = (path: string): boolean => MANIFESTS.has(path.split("/").at(-1) ?? "") || /(^|\/)requirements[^/]*\.txt$/.test(path);

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
  let pr: Awaited<ReturnType<typeof gatherPr>> | null = null;
  const readPr = async (): Promise<StageResult | null> => {
    if (pr) return null;
    try {
      pr = await gatherPr(deps.github, input.slug, input.number);
      return null;
    } catch (error) {
      return escalated(`the PR could not be read: ${messageOf(error)}`);
    }
  };
  /**
   * The addressing pack, asked once in the folder with one machine comment: null when it answered done (an edit it left uncommitted, its commit
   * refused, is committed by the host), else the result to stop with. A pack whose commit or `git status` was refused answers `env_broken` and
   * leaves its edits in the folder; only that escalation, and only with edits left, goes on to the host's commit and the gates after it. A pack
   * that stopped because it could not decide never has its partial edits shipped, however the checks come out.
   */
  const askPack = async (id: string, body: string, label: string, noInstall: boolean, failed: string, paths: string[]): Promise<StageResult | null> => {
    const thread = { id, path: null, line: null, comments: [{ author: "machine", body: body.slice(0, 6000), at: new Date().toISOString() }] };
    const addressed = await deps.loop.runPack("addressing", subContext(ctxWork, label), { threads: { pr: pr!, threads: [thread] }, ...(noInstall ? { install: false as const } : {}) });
    const answer = PrAddressAnswer.safeParse(addressed.detail?.answer);
    const stoppedFor = addressed.outcome === "escalated" ? addressed.detail?.escalation : answer.success && answer.data.kind === "escalated" ? answer.data.escalation : undefined;
    const leftEdits = stoppedFor === "env_broken" && (await git("status", "--porcelain")).stdout.trim() !== "";
    if (!leftEdits) {
      if (addressed.outcome !== "pass") return escalated(`${failed}: ${postable(String(addressed.detail?.error ?? addressed.detail?.reason ?? addressed.outcome), 300)}`, "other", { conflicts: paths.slice(0, 10) });
      if (!answer.success) return escalated("the addressing pack gave no usable answer for the conflicts", "other", { conflicts: paths.slice(0, 10) });
      if (answer.data.kind === "escalated") return escalated(postable(answer.data.reason || answer.data.summary || "the addressing pack asked for a person", 400), answer.data.escalation ?? "other", { conflicts: paths.slice(0, 10) });
    }
    // The pack's own commit can be refused (its tool rules match a plain `git commit`, not `git -C <dir> commit`), leaving the edits uncommitted.
    // The host commits them: the gates and checks read the commit like the pack's own, and only its tree ships.
    if ((await git("status", "--porcelain")).stdout.trim() !== "") {
      await git("add", "-A");
      await git("commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", `luna: ${message} (${id})`);
    }
    return null;
  };

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

    const unread = await readPr();
    if (unread) return stop(unread);
    const listed = conflicted.slice(0, CONFLICTS_SHOWN).map((p) => `- ${p}`).join("\n");
    const body = [
      `The branch conflicts with ${input.base.name} (${input.base.sha.slice(0, 7)}), which moved since the branch left it. The machine merged it; git's conflict markers are committed in:`,
      listed,
      "Resolve every conflict in those files and touch no other file. Keep this card's change. Carry in what the base added or changed: it is newer than the branch, so a fact, a section or a code path the base brought stays, written the way this card writes (its style, its rules). Remove every marker line. A file one side deleted is removed with `git rm <path>`. Then commit. Run git as plain `git status` and `git commit` from the folder you are in; a command that starts `git -C` is refused.",
    ].join("\n");
    // Markers in a manifest or lockfile break the machine's install before the pack begins (DISC-53: packages/ui/package.json, `yarn install
    // --immutable`); the pack then resolves text without the dependencies, and the checks below install on the resolved tree.
    const installBreaks = conflicted.some(installReads);
    const asked = await askPack("resolution", body, `merge-${input.label}`, installBreaks, `the conflicts with ${input.base.name} could not be resolved`, conflicted);
    if (asked) return stop(asked);

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

  /** A repair round: the pack fixes what fails only on the merged tree (it is handed the failures and the checks to run first), then the gates, a new merge commit and the checks again. */
  const repairRound = async (failedChecks: StageResult, round: number): Promise<{ final: string; checked: StageResult } | { stop: StageResult }> => {
    const unread = await readPr();
    if (unread) return { stop: unread };
    const start = await headOfWorktree(run, work);
    if (!start) return { stop: escalated("the merge's head could not be read") };
    const fork = (await git("merge-base", before, input.base.sha)).stdout.trim();
    const cardFiles = SHA.test(fork) ? (await git("diff", "--no-renames", "-z", "--name-only", fork, before)).stdout.split("\0").filter(Boolean) : [];
    const allowed = new Set([...conflicted, ...cardFiles]);
    const findings = (failedChecks.detail?.findings ?? failedChecks.findings ?? []) as Array<{ title?: string; body?: string }>;
    // What the round runs before it commits: the checks that failed, and the repository's lint, type and format checks, so a fix that breaks a
    // rule elsewhere (an import out of order) is caught in the folder, not by the next round of checks.
    const failedNames = findings.map((f) => String(f.title ?? "").replace(/ failed$/, ""));
    const specs = await (async () => ((await deps.policies.for(task.repoPath ?? null)) as { checks?: CheckSpec[] }).checks ?? [])().catch(() => [] as CheckSpec[]);
    const verify = specs.filter((c) => failedNames.includes(c.name) || GATE_CHECK.test(c.name)).map((c) => `- ${c.name}: \`${c.run}\``);
    const failures = findings.length > 0 ? findings.map((f) => `### ${f.title ?? "a check failed"}\n${String(f.body ?? "").slice(-2500)}`).join("\n\n") : String(failedChecks.detail?.error ?? failedChecks.detail?.summary ?? "the checks failed");
    const body = [
      `The machine merged ${input.base.name} (${input.base.sha.slice(0, 7)}) into the branch and the conflicts are resolved, but these checks fail on the merged tree while they pass on the branch before the merge and on ${input.base.name}: the merge itself broke them.`,
      failures.slice(0, 4000),
      ...(verify.length > 0 ? [`Before you commit, run these from the folder you are in and fix what they report in the files you changed (an error in a file you did not touch is not yours):\n${verify.join("\n")}`] : []),
      "Fix them. You may edit the files that had conflicts and the files this card's branch changes; no other file. Keep this card's change and keep what the base brought: where the card deleted or moved code that the base changed, leave it deleted (`git rm <path>`) and carry the base's change to where the card moved that code. Then commit. Run git as plain `git status` and `git commit` from the folder you are in; a command that starts `git -C` is refused.",
    ].join("\n\n");
    const asked = await askPack("merge-fix", body, `merge-fix-${input.label}${round > 1 ? `-${round}` : ""}`, false, `the checks failed after merging ${input.base.name} and the pack could not fix them`, conflicted);
    if (asked) return { stop: asked };
    const after = await headOfWorktree(run, work);
    if (!after || after === start) return { stop: escalated(`the checks failed after merging ${input.base.name} and round ${round} of the repair committed nothing`, "other", { findings }) };
    if ((await git("merge-base", "--is-ancestor", start, after)).code !== 0) return { stop: escalated(`round ${round} of the repair does not build on the merge; nothing was pushed`) };
    const touched = (await git("diff", "--no-renames", "-z", "--name-only", start, after)).stdout.split("\0").filter(Boolean);
    const outside = touched.filter((p) => !allowed.has(p));
    if (outside.length > 0) return { stop: escalated(`round ${round} of the repair changed files that neither conflicted nor are the card's (${outside.slice(0, 5).join(", ")}); nothing was pushed`, "other", { paths: outside.slice(0, 10) }) };
    const left: string[] = [];
    for (const path of touched) {
      const shown = await git("show", `${after}:${path}`);
      if (shown.code === 0 && MARKER.test(shown.stdout)) left.push(path);
    }
    if (left.length > 0) return { stop: escalated(`conflict markers are left in ${left.slice(0, 5).join(", ")}; nothing was pushed`, "other", { conflicts: left.slice(0, 10) }) };
    const tree = (await git("rev-parse", `${after}^{tree}`)).stdout.trim();
    const remade = await git("commit-tree", tree, "-p", before, "-p", input.base.sha, "-m", message);
    const head = remade.stdout.trim();
    if (remade.code !== 0 || !SHA.test(head)) return { stop: escalated(`the merge commit could not be made: ${postable((remade.stderr || remade.stdout).trim(), 300)}`) };
    await git("update-ref", `refs/heads/${branch}`, head);
    await git("reset", "--hard", "--quiet", head);
    const again = await deps.loop.checks!(subContext(ctxWork, `merge-checks-${input.label}-${round + 1}`), before, input.base.sha);
    return { final: head, checked: again };
  };

  // The one commit that ships: the resolved tree, with the branch's head and the base as its parents.
  const made = await git("commit-tree", resolvedTree, "-p", before, "-p", input.base.sha, "-m", message);
  let final = made.stdout.trim();
  if (made.code !== 0 || !SHA.test(final)) return stop(escalated(`the merge commit could not be made: ${postable((made.stderr || made.stdout).trim(), 300)}`));
  await git("merge", "--abort").catch(() => {});
  await git("update-ref", `refs/heads/${branch}`, final);
  await git("reset", "--hard", "--quiet", final);

  // The project's checks run on exactly what will be pushed.
  // A red check is asked again on the base's own tip and on the branch's head from before the merge: a failure either already had is not the
  // merge's (the base red without this card, or the card's own, which CI watch sends back to Build), so the merge ships and only what it broke stops it.
  let checked = deps.loop.checks ? await deps.loop.checks(subContext(ctxWork, `merge-checks-${input.label}`), before, input.base.sha) : null;
  if (!checked) return stop(escalated("no checks runner is wired to prove the merge"));
  // A failure only the merged tree has (DISC-53: develop's audit change to a router the card moved into a lambda, develop's new /docs route
  // against the card's route test) gets up to MERGE_REPAIR_ROUNDS more rounds: the pack sees the failures and may edit the conflicted files and the files the card's
  // branch changes, to carry the base's change to where the card moved that code. The same gates and checks follow; still red, a person decides.
  let rounds = 0;
  while (checked.outcome === "fail" && rounds < MERGE_REPAIR_ROUNDS) {
    rounds++;
    const repaired = await repairRound(checked, rounds);
    if ("stop" in repaired) return stop(repaired.stop);
    final = repaired.final;
    checked = repaired.checked;
  }
  if (checked.outcome === "escalated" && checked.detail?.red_on_base === true) {
    return stop(escalated(`${input.base.name} is red without this card: ${postable(String(checked.detail.reason ?? "its checks fail"), 300)}`, "env_broken", { red_on_base: true, base: input.base.sha, tests: checked.detail.tests ?? [] }));
  }
  if (checked.outcome !== "pass") return stop(escalated(`the checks failed after merging ${input.base.name}${rounds > 0 ? ` and ${rounds} round${rounds === 1 ? "" : "s"} with the pack did not fix them` : ""}: ${failureGist(String(checked.detail?.error ?? checked.detail?.reason ?? checked.detail?.summary ?? checked.outcome), 300)}`, "other", { findings: checked.detail?.findings ?? checked.findings ?? [] }));

  const remoteNow = await deps.github.prHeadSha(input.slug, input.number).catch(() => null);
  if (remoteNow && remoteNow !== before) return stop(escalated(`someone pushed to the PR (${remoteNow.slice(0, 7)}) while the merge was checked; nothing was pushed`, "head_moved"));
  if (fresh) {
    const back = await deps.loop.fresh!.bringBack(wt, fresh.path, branch, before);
    if (!back.ok) return stop(escalated(`the merge could not be brought back to the card: ${postable(back.reason ?? "unknown", 300)}; nothing was pushed`));
  }
  const pushError = await pushBranch(run, branch, wt);
  if (pushError) return stop(escalated(pushError));
  // The merge shows in the user's repository only now, from the card's own workspace: the pack's temporary commit (the markers) never does.
  await showPushed(context, task.repoPath ?? null, wt, branch);
  if (fresh) await deps.loop.fresh!.remove(fresh.path);
  // The card's base is the base it merged: its scope and its diffs are measured from there from now on.
  await run("git", [...HOST_GIT, ...at(wt), "update-ref", BASE_REF, input.base.sha]);

  const resolved = conflicted.slice(0, 10);
  const said = `merged ${input.base.name} into the branch (${final.slice(0, 7)})${resolved.length ? `, resolving the conflicts in ${resolved.join(", ")}` : ""}; Verify runs again`;
  return { ok: true, head: final, resolved, result: escalated(said, "head_moved", { refresh: "verify" }) };
}
