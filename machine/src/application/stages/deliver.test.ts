import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { ExecResult } from "../../adapters/process/exec.ts";
import { deliverRunner } from "./deliver.ts";
import type { StageContext } from "../ports.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const bad = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function setup(replies: Record<string, ExecResult>, over: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (command: string, args: string[]) => {
    const argv = [command, ...args];
    calls.push(argv);
    const key = Object.keys(replies).find((k) => argv.join(" ").startsWith(k));
    return key ? replies[key]! : bad("unexpected");
  });
  const context = {
    task: { id: "t1", title: "feat: thing", description: "d", criteria: ["c"], branch: "hardness/t1", worktreePath: "/wt", repoPath: "/repo", source: null, ...over } as unknown as TaskRow,
    stage: "delivering",
    attempt: 1,
    runId: "r1",
    approvals: [],
    signal: new AbortController().signal,
  } as StageContext;
  return { run: deliverRunner({ exec }), context, calls };
}

describe("delivering", () => {
  it("pushes and opens a draft PR, logging pr.opened", async () => {
    const { run, context, calls } = setup({
      "git -c core.hooksPath=/dev/null -C /wt push": ok(),
      "gh pr view hardness/t1": bad("no pull requests found"),
      "gh repo view": ok(JSON.stringify({ nameWithOwner: "acme/widgets" })),
      "gh pr create": ok("https://github.com/acme/widgets/pull/7\n"),
    });
    const result = await run(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ prUrl: "https://github.com/acme/widgets/pull/7", prNumber: 7, draft: true, reused: false });
    expect(result.events).toMatchObject([{ kind: "pr.opened", payload: { url: "https://github.com/acme/widgets/pull/7", number: 7 } }]);
    const create = calls.find((c) => c[1] === "pr" && c[2] === "create")!;
    expect(create).toContain("--draft");
    expect(create.slice(create.indexOf("--head"))[1]).toBe("hardness/t1");
  });

  it("reuses an existing PR", async () => {
    const { run, context, calls } = setup({
      "git -c core.hooksPath=/dev/null -C /wt push": ok(),
      "gh pr view hardness/t1": ok(JSON.stringify({ url: "https://x/pull/3", number: 3, isDraft: true })),
    });
    const result = await run(context);
    expect(result.detail).toMatchObject({ prUrl: "https://x/pull/3", prNumber: 3, reused: true });
    expect(calls.some((c) => c[2] === "create")).toBe(false);
  });

  it("fails with the push error and does not open a PR", async () => {
    const { run, context, calls } = setup({ "git -c core.hooksPath=/dev/null -C /wt push": bad("rejected: non-fast-forward") });
    const result = await run(context);
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("rejected: non-fast-forward");
    expect(calls).toHaveLength(1);
  });

  it("fails when the task has no branch", async () => {
    const { run, context } = setup({}, { branch: null });
    expect((await run(context)).outcome).toBe("fail");
  });
});
