import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../../domain/task.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { type AgentDeps, agentRunners, runAgent } from "./pack-runner.ts";
import type { StageContext } from "../ports.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
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
    return { exitCode, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
  };
}

function deps(sandbox: (run: SandboxRun) => Promise<SandboxResult>): AgentDeps {
  return {
    image: "img",
    qaImage: "qa-img",
    credential: { name: "ANTHROPIC_API_KEY", value: "x" },
    worktreesDir: join(root, "worktrees"),
    stateDir,
    watcher: { follow: vi.fn() } as never,
    sandbox,
  };
}

const runners = (sandbox: (run: SandboxRun) => Promise<SandboxResult>) => agentRunners(deps(sandbox));

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
  it("registers a runner for every pack dispatched unmodified; the rest are wrapped in bootstrap", () => {
    const r = runners(fakeSandbox(output()));
    expect(Object.keys(r).sort()).toEqual(["implementing", "test_design", "triage"]);
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

  it("runs e2e in the QA image and every other pack in the base image", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, context("e2e"), "e2e");
    expect(seen?.image).toBe("qa-img");
    await runAgent(d, context("evidence"), "evidence");
    expect(seen?.image).toBe("img");
    await runAgent(d, context("triage"), "triage");
    expect(seen?.image).toBe("img");
  });

  it.each([
    ["an escalated outcome (schema 2)", { schema: 2 as const, outcome: "escalated" as const }],
    ["a pass whose answer escalated (schema 1, orc before the escalated outcome)", { outcome: "pass" as const }],
  ])("reports %s as escalated, with the agent's reason and options", async (_, over) => {
    const answer = { kind: "escalated", summary: "stopped", reason: "needs a new dependency", options: ["add it", "drop it"] };
    const run = runners(fakeSandbox(output({ ...over, summary: "stopped", answer })));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ reason: "needs a new dependency", options: ["add it", "drop it"] });
  });

  it("keeps triage's confidence and risk on the plan, for the timer approval", async () => {
    const answer = { kind: "brief", summary: "s", criteria: ["c"], confidence: "high", risk: "low" };
    const run = runners(fakeSandbox(output({ answer })));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "s", confidence: "high", risk: "low" });
    const bare = await runners(fakeSandbox(output({ answer: { kind: "brief", summary: "s" } }))).triage!(context("triage"));
    expect(bare.detail).not.toHaveProperty("confidence");
  });

  it("keeps the test cases test_design answered, for the test check", async () => {
    const cases = [{ title: "rejects a bad password", criterion: "works", approach: "run a.test.ts, confirm it rejects" }];
    const run = runners(fakeSandbox(output({ answer: { kind: "done", summary: "s", cases } })));
    const result = await run.test_design!(context("test_design"));
    expect(result.detail).toMatchObject({ summary: "did it", cases });
    expect(result.detail).not.toHaveProperty("tests");
  });

  it("keeps test_design's cases away from implementing when the repo's PIPELINE.md holds them out", async () => {
    writeFileSync(join(repo, "PIPELINE.md"), "---\nholdout_cases: true\n---\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "policy");
    const cases = [{ title: "t", criterion: null, approach: "run a.test.ts" }];
    const approvals = [
      { kind: "awaiting_test_check", requested: { cases }, decision: "approved", reason: null, response: null },
    ] as never;
    const run = runners(fakeSandbox(output()));
    await run.implementing!({ ...context("implementing"), approvals });
    expect((seen!.input as unknown as StageInput).context.testCases).toEqual([]);
  });

  it("tells the pack where the branch forked, and hands ci_watch what the host fetched", async () => {
    const ci = { pr: null, checks: [{ name: "lint", state: "FAILURE", url: null }], logs: "boom" };
    await runAgent(deps(fakeSandbox(output())), context("ci_watch"), "ci_watch", { ci });
    const input = seen!.input as unknown as StageInput;
    expect(input.context.ci).toEqual(ci);
    expect(input.context.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
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

  it("hands the latest verifying findings to implementing, keeping only confident ones", async () => {
    const f = (confidence: number, title: string) => ({
      path: "a.ts", line: 1, start_line: null, severity: "bug", title, body: "", suggestion_code: null, confidence,
    });
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "slice");
    }));
    await run.implementing!({ ...context("implementing"), priorFindings: [f(0.9, "keep"), f(0.5, "drop")] });
    expect((seen?.input as { priorFindings: Array<{ title: string }> }).priorFindings.map((x) => x.title)).toEqual(["keep"]);
  });

  describe("locked test files", () => {
    const seedTests = () => {
      mkdirSync(join(repo, "test"), { recursive: true });
      writeFileSync(join(repo, "test", "cart.test.js"), "old\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "tests");
    };
    const commitIn = (cwd: string, msg = "slice") => {
      git(cwd, "add", "-A");
      git(cwd, "commit", "-q", "-m", msg);
      return git(cwd, "rev-parse", "HEAD");
    };
    const expectLocked = async (act: (cwd: string) => void) => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = runners(fakeSandbox(output(), (r) => { act(r.worktree); commitIn(r.worktree); }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
      expect(result.detail).toMatchObject({ lockedFiles: ["test/cart.test.js"] });
      expect(String((result.detail as { error: string }).error)).toContain("test/cart.test.js");
      expect(result.findings).toHaveLength(1);
      expect(result.findings![0]).toMatchObject({ path: "test/cart.test.js", line: 0, severity: "test", confidence: 1 });
    };

    it("fails and undoes a commit that modified an existing test", () =>
      expectLocked((cwd) => writeFileSync(join(cwd, "test", "cart.test.js"), "new\n")));
    it("fails and undoes a commit that deleted an existing test", () =>
      expectLocked((cwd) => git(cwd, "rm", "-q", "test/cart.test.js")));
    it("fails and undoes a commit that renamed an existing test", () =>
      expectLocked((cwd) => git(cwd, "mv", "test/cart.test.js", "src-moved.js")));

    // A test file that existed is allowed to change as long as the tests that were there
    // still pass against the new code: the machine puts the original file back, runs the
    // project's test command, then restores the agent's version.
    const withTestCommand = (argv: string[], sandbox: (run: SandboxRun) => Promise<SandboxResult>) =>
      agentRunners({ ...deps(sandbox), detect: async () => ({ manager: "npm" as const, test: argv }) });

    it("accepts a change to an existing test file when the tests that were there still pass", async () => {
      seedTests();
      let replayedWith: string | undefined;
      const run = withTestCommand(["sh", "-c", "cat test/cart.test.js > ../replayed.txt"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "old\nplus a new case\n");
        writeFileSync(join(r.worktree, "a.txt"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      replayedWith = readFileSync(join(seen!.worktree, "..", "replayed.txt"), "utf8");
      expect(result.outcome).toBe("pass");
      // The original file was what ran, and the agent's version is back afterwards.
      expect(replayedWith).toBe("old\n");
      expect(readFileSync(join(seen!.worktree, "test", "cart.test.js"), "utf8")).toBe("old\nplus a new case\n");
      expect(git(seen!.worktree, "status", "--porcelain")).toBe("");
      expect(result.detail).toMatchObject({ lockedFiles: ["test/cart.test.js"], lockedTestsReplayed: true });
    });

    it("still fails and undoes the commit when the tests that were there no longer pass", async () => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = withTestCommand(["sh", "-c", "exit 1"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "rewritten\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
      expect(String((result.detail as { error: string }).error)).toMatch(/no longer pass/);
      expect(result.findings![0]).toMatchObject({ path: "test/cart.test.js" });
    });

    it("says what the replay saw, and tells a test command that could not run from tests that failed", async () => {
      seedTests();
      const run = withTestCommand(["sh", "-c", "echo 'sh: vitest: not found' >&2; exit 127"], fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "old\nplus a case\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      const error = String((result.detail as { error: string }).error);
      expect(error).toMatch(/test command could not run/);
      expect(error).toContain("sh: vitest: not found");
      expect(result.findings![0]!.body).toContain("sh: vitest: not found");
    });

    it("never accepts a deleted or renamed test file, even with a green test command", async () => {
      seedTests();
      const before = git(repo, "rev-parse", "HEAD");
      const run = withTestCommand(["sh", "-c", "exit 0"], fakeSandbox(output(), (r) => {
        git(r.worktree, "rm", "-q", "test/cart.test.js");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("fail");
      expect(git(seen!.worktree, "rev-parse", "HEAD")).toBe(before);
    });

    it("passes a commit that adds a new test and changes source", async () => {
      seedTests();
      const run = runners(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "new.test.js"), "n\n");
        writeFileSync(join(r.worktree, "a.txt"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await run.implementing!(context("implementing"));
      expect(result.outcome).toBe("pass");
    });

    it("does not apply to a read-only pack", async () => {
      seedTests();
      const run = runners(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "new\n");
        commitIn(r.worktree);
      }));
      const result = await run.test_design!(context("test_design"));
      expect(result.outcome).toBe("pass");
    });

    it("applies to verifying too: touching a locked test fails", async () => {
      seedTests();
      const d = deps(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "changed\n");
        commitIn(r.worktree);
      }));
      const result = await runAgent(d, context("verifying"), "verifying");
      expect(result.outcome).toBe("fail");
      expect(result.detail?.lockedFiles).toEqual(["test/cart.test.js"]);
    });

    it("verifying can add a new test and commit cleanly", async () => {
      seedTests();
      const d = deps(fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "new.test.js"), "n\n");
        commitIn(r.worktree);
      }));
      const result = await runAgent(d, context("verifying"), "verifying");
      expect(result.outcome).toBe("pass");
    });
  });

  it("fails a run the sandbox stopped as stuck, with the detector's reason", async () => {
    const run = runners(async (r) => {
      seen = r;
      mkdirSync(join(r.runDir, "out"), { recursive: true });
      return { exitCode: 137, timedOut: false, aborted: false, stuck: "the same call 4 times in a row: Bash npm test", transcriptPath: "t" };
    });
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "stuck: the same call 4 times in a row: Bash npm test" });
  });

  it("hands the sandbox a line watcher that reads the transcript as it streams", async () => {
    const run = runners(fakeSandbox(output()));
    await run.implementing!(context("implementing"));
    expect(typeof seen!.onLine).toBe("function");
    expect(seen!.onLine!("→ Bash npm test")).toBeNull();
  });

  it("records the commit a writable pass ended on, and mounts a per-task state dir for orc", async () => {
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "a.txt"), "changed\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "slice");
    }));
    const ctx = context("implementing");
    const result = await run.implementing!(ctx);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(git(seen!.worktree, "rev-parse", "HEAD"));
    expect(result.run?.outputCommit).not.toBe(result.run?.inputCommit);
    expect(seen!.stateMount).toBe(join(stateDir, "tasks", ctx.task.id, "orc"));
    expect(existsSync(seen!.stateMount!)).toBe(true);
  });

  it("gives the sandbox the time budget the stage input carries, not the pack's flat default", async () => {
    const run = runners(fakeSandbox(output()));
    const slice = { title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] };
    const planned = {
      ...context("implementing"),
      approvals: [
        { id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: [], assumptions: [], slices: [slice, slice, slice] } } as unknown as StageContext["approvals"][number],
      ],
    };
    await run.implementing!(planned);
    const input = seen!.input as { limits: { timeoutMs: number } };
    expect(input.limits.timeoutMs).toBe(3 * 30 * 60_000);
    expect(seen!.timeoutMs).toBe(input.limits.timeoutMs);
  });

  it("labels the watch tab with the repo's name, so five repos' Build tabs read apart", async () => {
    const follow = vi.fn();
    const d = { ...deps(fakeSandbox(output(), (r) => r.onStarted?.("c1"))), watcher: { follow } as never };
    await runAgent(d, context("triage"), "triage");
    expect(follow).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555", expect.stringMatching(/^#11111111 repo · Fix it$/), expect.any(String), "c1");
  });

  it("fails a verifying pass that left uncommitted changes, resetting the worktree, same as implementing", async () => {
    const d = deps(fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")));
    const result = await runAgent(d, context("verifying"), "verifying");
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "verifying left uncommitted changes: ?? junk.txt" });
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
  });

  it("fails a pass that left uncommitted changes, and resets the worktree", async () => {
    const run = runners(
      fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")),
    );
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "implementer left uncommitted changes: ?? junk.txt" });
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
      return { exitCode: 137, timedOut: false, aborted: false, transcriptPath: "t" };
    });
    const result = await run.triage!(context("triage"));
    expect(result.outcome).toBe("fail");
    expect(String(result.detail?.error)).toContain("exit code 137");
  });

  it("builds the triage approval from the pack answer", async () => {
    const slices = [{ title: "s1", est_loc: 40 }];
    const run = runners(
      fakeSandbox(
        output({
          answer: { kind: "done", summary: "the brief", criteria: ["c1"], assumptions: ["a1"], slices },
        }),
      ),
    );
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "the brief", criteria: ["c1"], assumptions: ["a1"], slices });
  });

  it("falls back to the summary and ticket criteria when triage has no answer", async () => {
    const run = runners(fakeSandbox(output()));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "did it", criteria: ["works"], assumptions: [], slices: [] });
  });

  it("prefers answer.questions on triage needs_input", async () => {
    const questions = [{ question: "q?", recommended: "r" }];
    const run = runners(
      fakeSandbox(output({ outcome: "needs_input", needsInput: [], answer: { kind: "questions", questions } })),
    );
    const result = await run.triage!(context("triage"));
    expect(result.detail).toEqual({ summary: "did it", questions, answer: { kind: "questions", questions } });
  });
});
