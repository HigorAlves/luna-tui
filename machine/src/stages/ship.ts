// The ship stage: pushes the task's branch and opens its PR with `gh`, on the host — this
// needs your own git and gh credentials, so unlike triage and the implementer it never runs
// in a sandboxed container.
import { exec } from "../sandbox/exec.ts";
import type { StageRunner } from "./runner.ts";

/** Pushes the task's branch and opens a PR for it, reusing one if it already exists. */
export const shipRunner: StageRunner = async ({ task }) => {
  if (!task.repoPath || !task.branch || !task.worktreePath) {
    return { outcome: "fail", detail: { error: "no branch to ship; the implementer never ran for real" } };
  }
  const cwd = task.worktreePath;

  const pushed = await exec("git", ["-C", cwd, "push", "-u", "origin", task.branch]);
  if (pushed.code !== 0) {
    return { outcome: "fail", detail: { error: `git push failed: ${describe(pushed)}` } };
  }

  // Reuse an existing PR for this branch rather than failing a retry on it.
  const existing = await exec("gh", ["pr", "view", task.branch, "--json", "url"], { cwd });
  if (existing.code === 0) {
    const url: unknown = JSON.parse(existing.stdout).url;
    return { outcome: "pass", detail: { prUrl: url, reused: true } };
  }

  const body = [
    task.description,
    task.criteria.length > 0
      ? `\nAcceptance criteria:\n${task.criteria.map((c) => `- ${c}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const created = await exec(
    "gh",
    ["pr", "create", "--title", task.title, "--body", body, "--head", task.branch],
    { cwd },
  );
  if (created.code !== 0) {
    return { outcome: "fail", detail: { error: `gh pr create failed: ${describe(created)}` } };
  }
  return { outcome: "pass", detail: { prUrl: created.stdout.trim() } };
};

/** A command's output, or a hint when it produced none (e.g. the binary is missing). */
function describe(result: { code: number; stdout: string; stderr: string }): string {
  const text = (result.stderr || result.stdout).trim();
  return text || `exit code ${result.code}; is \`gh\` installed and authenticated? (\`gh auth status\`)`;
}
