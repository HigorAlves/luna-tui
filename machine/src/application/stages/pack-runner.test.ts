import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

  it("keeps the test cases test_design answered, for the test check", async () => {
    const cases = [{ title: "rejects a bad password", criterion: "works", test: "a.test.ts > rejects" }];
    const run = runners(fakeSandbox(output({ answer: { kind: "done", summary: "s", tests: ["a.test.ts"], cases } })));
    const result = await run.test_design!(context("test_design"));
    expect(result.detail).toMatchObject({ tests: ["a.test.ts"], cases });
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

  it("fails a verifying pass that left uncommitted changes, resetting the worktree, same as implementing", async () => {
    const d = deps(fakeSandbox(output(), (r) => writeFileSync(join(r.worktree, "junk.txt"), "x")));
    const result = await runAgent(d, context("verifying"), "verifying");
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: "verifying left uncommitted changes" });
    expect(existsSync(join(seen!.worktree, "junk.txt"))).toBe(false);
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

  it("lists the tests from the answer, the manifest and the test artifacts", async () => {
    const run = runners(
      fakeSandbox(
        output({
          answer: { kind: "done", tests: ["src/a.test.ts"] },
          artifacts: [
            { kind: "test", path: "files/tests/manifest.json", label: "m", sha256: "" },
            { kind: "test", path: "files/tests/src/c.test.ts", label: "c", sha256: "" },
          ],
        }),
        (r) => {
          const dir = join(r.runDir, "out", "files", "tests", "src");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(r.runDir, "out", "files", "tests", "manifest.json"), JSON.stringify({ tests: ["src/b.test.ts", "src/a.test.ts"] }));
          writeFileSync(join(dir, "c.test.ts"), "x");
        },
      ),
    );
    const result = await run.test_design!(context("test_design"));
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      summary: "did it",
      tests: ["src/a.test.ts", "src/b.test.ts", "src/c.test.ts"],
    });
  });

  it("falls back to an empty tests list when test_design reports nothing", async () => {
    const run = runners(fakeSandbox(output()));
    const result = await run.test_design!(context("test_design"));
    expect(result.detail).toMatchObject({ tests: [] });
  });
});
