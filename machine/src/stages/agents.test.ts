import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../db/entities.ts";
import type { SandboxResult, SandboxRun } from "../sandbox/docker.ts";
import { agentRunners } from "./agents.ts";
import type { StageContext } from "./runner.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();

const output = (over: Partial<StageOutput> = {}): StageOutput => ({
  schema: 1,
  ok: true,
  outcome: "pass",
  summary: "did it",
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [],
  slices: { done: 0, total: 0 },
  commit: null,
  usage: { turns: 7, costUsd: 0.5, durationMs: 100, model: "m" },
  error: null,
  rateLimited: false,
  resetsAt: null,
  ...over,
});

let root: string;
let repo: string;
let stateDir: string;
let seen: SandboxRun | undefined;

/** A sandbox that does what the pack would: leaves files in /out and maybe in the worktree. */
function fakeSandbox(
  result: StageOutput | (() => StageOutput),
  act: (run: SandboxRun) => void = () => {},
  exitCode = 0,
): (run: SandboxRun) => Promise<SandboxResult> {
  return async (run) => {
    seen = run;
    const out = join(run.runDir, "out");
    mkdirSync(out, { recursive: true });
    act(run);
    writeFileSync(join(out, "result.json"), JSON.stringify(typeof result === "function" ? result() : result));
    writeFileSync(
      join(out, "events.jsonl"),
      `${JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: "slice_committed", payload: { id: 1 } })}\n`,
    );
    return { output: null, exitCode, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
  };
}

function runners(sandbox: (run: SandboxRun) => Promise<SandboxResult>) {
  return agentRunners({
    image: "img",
    credential: { name: "ANTHROPIC_API_KEY", value: "x" },
    worktreesDir: join(root, "worktrees"),
    stateDir,
    watcher: { follow: vi.fn() } as never,
    sandbox,
  });
}

const context = (stage: StageContext["stage"]): StageContext => ({
  task: {
    id: "11111111-2222-3333-4444-555555555555",
    title: "Fix it",
    description: "",
    criteria: ["works"],
    repoPath: repo,
    source: null,
    branch: null,
    worktreePath: null,
  } as unknown as TaskRow,
  stage,
  attempt: 1,
  runId: "run-1",
  approvals: [],
  signal: new AbortController().signal,
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agents-")));
  repo = join(root, "repo");
  stateDir = join(root, "state");
  seen = undefined;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});

describe("agent stages through orc packs", () => {
  it("registers a runner for every agent pack", () => {
    const r = runners(fakeSandbox(output()));
    expect(Object.keys(r).sort()).toEqual(
      ["ci_watch", "e2e", "evidence", "implementing", "reviewing_memory", "test_design", "triage", "verifying"],
    );
  });

  it("sends a StageInput to a read-only sandbox and returns outcome, events, artifacts and usage", async () => {
    const run = runners(
      fakeSandbox(
        output({ artifacts: [{ kind: "report", path: "files/r.md", label: "r.md", sha256: "" }] }),
        (r) => {
          mkdirSync(join(r.runDir, "out", "files"), { recursive: true });
          writeFileSync(join(r.runDir, "out", "files", "r.md"), "hello");
        },
      ),
    );
    const result = await run.triage!(context("triage"));
    expect(StageInput.safeParse(seen?.input).success).toBe(true);
    expect(seen?.writable).toBe(false);
    expect(seen?.timeoutMs).toBe(600_000);
    expect(result.outcome).toBe("pass");
    expect(result.usage).toEqual({ turns: 7, costUsd: 0.5 });
    expect(result.events?.map((e) => e.kind)).toEqual(["slice_committed"]);
    expect(result.artifacts).toHaveLength(1);
    expect(existsSync(result.artifacts![0]!.path)).toBe(true);
    expect(result.detail).toMatchObject({ brief: "did it" });
  });

  it("maps needs_input to summary and questions", async () => {
    const questions = [{ question: "which db?", recommended: "pg" }];
    const run = runners(fakeSandbox(output({ outcome: "needs_input", needsInput: questions })));
    const result = await run.triage!(context("triage"));
    expect(result.outcome).toBe("needs_input");
    expect(result.detail).toEqual({ summary: "did it", questions });
  });

  it("records the commit the implementer made and does not commit itself", async () => {
    let made = "";
    const run = runners(
      fakeSandbox(
        () => output({ commit: made }),
        (r) => {
          writeFileSync(join(r.worktree, "b.txt"), "b\n");
          git(r.worktree, "add", "-A");
          git(r.worktree, "commit", "-q", "-m", "slice 1");
          made = git(r.worktree, "rev-parse", "HEAD");
        },
      ),
    );
    const result = await run.implementing!(context("implementing"));
    expect(seen?.writable).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(made);
    expect(git(seen!.worktree, "log", "--format=%s")).toBe("slice 1\ninit");
  });

  it("fails a pass that left uncommitted changes, and resets the worktree", async () => {
    const run = runners(
      fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")),
    );
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "implementer left uncommitted changes" });
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("resets a dirty worktree after a failed run", async () => {
    const run = runners(
      fakeSandbox(output({ ok: false, outcome: "fail", error: "boom" }), (r) =>
        writeFileSync(join(r.worktree, "junk.txt"), "x"),
      ),
    );
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("fails with the transcript hint when the container left no result", async () => {
    const run = runners(async (r) => {
      seen = r;
      return { output: null, exitCode: 137, timedOut: false, aborted: false, transcriptPath: "t" };
    });
    const result = await run.triage!(context("triage"));
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("exit code 137");
  });
});
