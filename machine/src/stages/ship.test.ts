import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import type { ExecResult } from "../sandbox/exec.ts";
import type { StageContext } from "./runner.ts";
import { shipRunnerWith } from "./ship.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function setup(replies: Record<string, ExecResult>) {
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    const argv = [command, ...args];
    calls.push(argv);
    const key = Object.keys(replies).find((k) => argv.join(" ").startsWith(k));
    return key ? replies[key]! : bad("unexpected");
  });
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: [], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null } as unknown as TaskRow,
    stage: "shipping",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: shipRunnerWith({ exec }), context, calls };
}
const view = (isDraft: boolean) => ok(JSON.stringify({ url: "https://x/pull/3", number: 3, isDraft }));

describe("shipping", () => {
  it("marks a draft PR ready", async () => {
    const { run, context, calls } = setup({ "git -C /wt push": ok(), "gh pr view": view(true), "gh pr ready": ok() });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/3", readied: true } });
    expect(calls).toContainEqual(["gh", "pr", "ready", "3"]);
  });

  it("does nothing to a PR that is already ready", async () => {
    const { run, context, calls } = setup({ "git -C /wt push": ok(), "gh pr view": view(false) });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { readied: false } });
    expect(calls.some((c) => c[2] === "ready")).toBe(false);
  });

  it("creates a non-draft PR when delivering never opened one", async () => {
    const { run, context, calls } = setup({
      "git -C /wt push": ok(),
      "gh pr view": bad("no pull requests found"),
      "gh repo view": ok(JSON.stringify({ nameWithOwner: "a/b" })),
      "gh pr create": ok("https://x/pull/9\n"),
    });
    const result = await run(context);
    expect(result).toMatchObject({ outcome: "pass", detail: { prUrl: "https://x/pull/9", readied: false } });
    expect(calls.find((c) => c[2] === "create")).not.toContain("--draft");
  });

  it("fails when marking ready fails", async () => {
    const { run, context } = setup({ "git -C /wt push": ok(), "gh pr view": view(true), "gh pr ready": bad("boom") });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("boom");
  });
});
