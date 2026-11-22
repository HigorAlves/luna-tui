// The ui-designer helper end to end (RFC 0013, phase 5, slice 83). Real git in temp repositories, the real `helperRuns` coordinator, the real build
// watch, the real pack runner and the real factory tools (`lunaHandlers`: slice_delegate, slice_wait, the pick handshake). Only the containers are
// fake: one function plays the implementer's container (it drives the factory's tool handlers against the mailbox in `/out/checks`) and the helper's.
// The fake sandbox is called once per run; the two kinds are told apart by `run.input.pack`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { makeBundler } from "../../../../factory/src/core/bundles.ts";
import { lunaHandlers } from "../../../../factory/src/core/luna-tools.ts";
import { fixedCredentials } from "../../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { machineGitDir } from "../../adapters/git/machine-repo.ts";
import { exec } from "../../adapters/process/exec.ts";
import { DEFAULT_POLICY } from "../../domain/policy.ts";
import type { EventRow, StageRunRow, TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { buildProgressOf, buildReportOf } from "../reports.ts";
import { type AgentDeps, runAgent } from "./pack-runner.ts";
import { type HelperRuns, type HelperRunsDeps, helperRuns } from "./helper-runs.ts";

const FIGMA = "https://www.figma.com/design/ABCDEFGHIJ1234/Price?node-id=1-2";
const TASK = "11111111-2222-3333-4444-555555555555";

/** What the agent does in its own scratch repository in the folder. */
const agent = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
/** git in the user's repository, or in a card's workspace through the machine's repository for it. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...(existsSync(machineGitDir(cwd)) ? ["--git-dir=" + machineGitDir(cwd), "--work-tree=" + cwd] : []), "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

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

const slice = (title: string, touchpoints: string[]) => ({ title, est_loc: 20, touchpoints, acceptance: [`${title} works`] });
const LOGIC = slice("The price api", ["src/api/price.ts"]);
const VIEW = slice("The price view", ["src/ui/Price.tsx"]);
const TOTAL = slice("The total view", ["src/ui/Total.tsx"]);

let root: string;
let repo: string;
/** The card's tests commit: the branch's own history starts here. */
let tests: string;
let stateDir: string;

/** A promise a script opens by hand: the helper waits on it so the test decides when it returns. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "helper-e2e-")));
  repo = join(root, "repo");
  stateDir = join(root, "state");
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  mkdirSync(join(repo, "src", "ui"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/api/price.ts"), "export const price = 1;\n");
  writeFileSync(join(repo, "src/ui/Price.tsx"), "export const Price = () => 'one';\nexport const label = 'a';\n");
  writeFileSync(join(repo, "src/ui/Total.tsx"), "export const Total = () => 'zero';\n");
  writeFileSync(join(repo, "tests/price.test.ts"), "// the card's tests commit\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "tests");
  tests = git(repo, "rev-parse", "HEAD");
});

/** The implementer's container: the factory's own tool handlers over the real mailbox, a scratch repository, a bundler. */
interface Impl {
  run: SandboxRun;
  work: string;
  checks: string;
  /** A factory tool, called as the model would call it. */
  call(tool: string, args?: Record<string, unknown>): Promise<Record<string, any>>;
  /** Writes a file in the folder and commits it; the sha. */
  commit(file: string, text: string, message?: string): string;
  /** Commits `slice` as the model does: the commit, then `slice_set committed`. */
  finish(id: number, file: string, text: string): Promise<string>;
  /** Plays `slice_init` from the plan's slices. */
  init(ids: number[]): Promise<void>;
  /** A request the machine answered, by file prefix. */
  files(prefix: string): string[];
  /** Reads `helper-state-<slice>.json`. */
  state(slice: number): { state: string; attempt: number; summary?: string } | null;
  /** The next `bundleNow` also commits this, as an agent that commits just after bundling does. */
  strayOnNextBundle(file: string, text: string): void;
  /** Writes the output file the container ends with. */
  end(over?: Partial<StageOutput>): void;
}

interface Case {
  plan?: unknown[];
  description?: string;
  policy?: Record<string, unknown>;
  implementer(c: Impl): Promise<void>;
  /** The helper's container: `attempt` is 1, or 2 after a conflict. Commits in `run.worktree`. */
  helper?(run: SandboxRun, attempt: number): Promise<void> | void;
  /** Wraps the machine's own git steps of the coordinator (the pick, the move of the branch). */
  git?: (git: HelperRunsDeps["git"], d: HelperRunsDeps) => HelperRunsDeps["git"];
  checkWaitMs?: number;
  output?: Partial<StageOutput>;
}

async function rig(c: Case) {
  const rows: Array<{ kind: string; payload: Record<string, any> }> = [];
  const notes: string[] = [];
  const containers: string[] = [];
  let coordinator: HelperRuns | undefined;
  const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
    run.onStarted?.(`c${containers.length}`);
    const input = run.input as { pack: string; context: { helper?: { attempt: number } } };
    containers.push(input.pack);
    const out = join(run.runDir, "out");
    mkdirSync(join(out, "bundles"), { recursive: true });
    mkdirSync(join(out, "checks"), { recursive: true });
    if (input.pack === "ui_design") {
      const started = agent(run.worktree, "rev-parse", "HEAD");
      await c.helper?.(run, input.context.helper?.attempt ?? 1);
      if (agent(run.worktree, "rev-parse", "HEAD") !== started) agent(run.worktree, "bundle", "create", join(out, "bundles", "1.bundle"), `${started}..HEAD`);
      writeFileSync(join(out, "result.json"), JSON.stringify(output()));
      writeFileSync(join(out, "events.jsonl"), "");
    } else {
      const bundler = makeBundler({ work: run.worktree, out });
      let stray: { file: string; text: string } | null = null;
      const bundleNow = () => {
        bundler.bundle();
        if (stray) {
          const { file, text } = stray;
          stray = null;
          writeFileSync(join(run.worktree, file), text);
          agent(run.worktree, "add", "-A");
          agent(run.worktree, "commit", "-q", "-m", `stray ${file}`);
        }
      };
      const checks = join(out, "checks");
      const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), ledger: null, decisions: [], emit: () => {}, checksDir: checks, checkWaitMs: c.checkWaitMs ?? 10_000, work: run.worktree, bundleNow, onSliceCommitted: () => void bundler.bundle() });
      const impl: Impl = {
        run,
        work: run.worktree,
        checks,
        // a copy: the ledger the tool answers with is the live one, and later calls change it
        call: async (tool, args = {}) => JSON.parse(JSON.stringify(await luna.call(tool, args))) as Record<string, any>,
        commit: (file, text, message = `add ${file}`) => {
          mkdirSync(join(run.worktree, file, ".."), { recursive: true });
          writeFileSync(join(run.worktree, file), text);
          agent(run.worktree, "add", "-A");
          agent(run.worktree, "commit", "-q", "-m", message);
          return agent(run.worktree, "rev-parse", "HEAD");
        },
        finish: async (id, file, text) => {
          const sha = impl.commit(file, text);
          await impl.call("slice_set", { id, status: "committed", commit: sha });
          return sha;
        },
        init: async (ids) => void (await impl.call("slice_init", { slices: ids.map((id) => ({ id, title: `slice ${id}` })) })),
        files: (prefix) => readdirSync(checks).filter((f) => f.startsWith(prefix)),
        state: (n) => {
          try {
            return JSON.parse(readFileSync(join(checks, `helper-state-${n}.json`), "utf8"));
          } catch {
            return null;
          }
        },
        strayOnNextBundle: (file, text) => void (stray = { file, text }),
        end: () => {},
      };
      let ended: Partial<StageOutput> = {};
      impl.end = (over = {}) => void (ended = over);
      await c.implementer(impl);
      writeFileSync(join(out, "result.json"), JSON.stringify(output({ slices: { done: 2, total: 2 }, ...c.output, ...ended })));
      writeFileSync(join(out, "events.jsonl"), "");
    }
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
  };
  const deps = {
    image: "img",
    qaImage: "qa-img",
    videoImage: "video-img",
    credentials: fixedCredentials({ ANTHROPIC_API_KEY: "x" }),
    worktreesDir: join(root, "worktrees"),
    stateDir,
    watcher: { follow: () => {} } as never,
    sandbox,
    watchEvery: 5,
    // The checkpoint push is real: the card's workspace pushes to `refs/luna/wip/<branch>` of the user's repository.
    hostExec: exec,
    pushSleep: async () => {},
    ...(c.policy ? { policies: { for: async () => ({ ...DEFAULT_POLICY, ...c.policy }) } as never } : {}),
    helperRuns: (d: HelperRunsDeps) => (coordinator = helperRuns(c.git ? { ...d, git: c.git(d.git, d) } : d)),
  } as unknown as AgentDeps;
  const base: StageContext = {
    task: { id: TASK, title: "A price card", description: c.description ?? `Build it. ${FIGMA}`, criteria: ["works"], repoPath: repo, source: null, branch: null, worktreePath: null } as unknown as TaskRow,
    stage: "implementing",
    attempt: 1,
    runId: "run-1",
    approvals: [{ id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: [], assumptions: [], slices: c.plan ?? [LOGIC, VIEW] } } as never],
    signal: new AbortController().signal,
    engine: "claude:sonnet",
    budgetMinutes: 30,
    emit: async (kind, payload) => void rows.push({ kind, payload: payload as Record<string, any> }),
    note: async (text) => void notes.push(text),
  };
  const result = await runAgent(deps, base, "implementing", { testsFiles: ["tests/price.test.ts"] });
  const path = result.workspace?.worktreePath ?? join(root, "worktrees");
  const branch = result.workspace?.branch ?? "";
  return {
    result,
    rows,
    notes,
    containers,
    coordinator: () => coordinator,
    path,
    branch,
    /** The card's branch in the machine's repository, oldest first, after the tests commit. */
    commits: () => git(path, "rev-list", "--reverse", git(path, "rev-parse", `refs/heads/${branch}`), `^${tests}`).split("\n").filter(Boolean),
    tip: () => git(path, "rev-parse", `refs/heads/${branch}`),
    show: (sha: string, file: string) => git(path, "show", `${sha}:${file}`),
    kinds: (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.payload),
  };
}

const events = (rows: Array<{ kind: string; payload: Record<string, unknown> }>): EventRow[] => rows.map((r, i) => ({ id: String(i), taskId: TASK, stageRunId: null, kind: r.kind, payload: r.payload, at: new Date(1_700_000_000_000 + i * 1000) }));
const limits = { max_iterations: 15, max_tokens: 2_000_000, max_minutes: 90, backoff_minutes: [1, 30] as [number, number], regression_full_suite_minutes: 10 };
const detailOf = (result: StageResult) => result.detail as Record<string, any>;

describe("the ui-designer helper end to end (RFC 0013, phase 5)", () => {
  it("both land: the logic slice and the picked UI slice sit on the branch in order, the machine's rows name the shas, and the checkpoint holds the tip", async () => {
    const release = gate();
    let listed: Record<string, any> = {};
    let running: unknown;
    let waited: Record<string, any> = {};
    let scope: Record<string, any> = {};
    let slice1 = "";
    const r = await rig({
      implementer: async (c) => {
        await c.init([1, 2]);
        const delegated = await c.call("slice_delegate", { slice: 2, message: "build the price view" });
        expect(delegated).toMatchObject({ ok: true, locks: ["src/ui/Price.tsx"] });
        slice1 = await c.finish(1, "src/api/price.ts", "export const price = 2;\n");
        listed = await c.call("slice_list");
        running = c.state(2)?.state;
        release.open();
        waited = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        scope = await c.call("scope_check", { diffSummary: "price api and view", outOfMap: [] });
      },
      helper: async (run) => {
        await release.promise;
        writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'two';\nexport const label = 'a';\n");
        agent(run.worktree, "add", "-A");
        agent(run.worktree, "commit", "-q", "-m", "ui: the price view");
      },
    });
    // the implementer's side, through the real factory tools
    expect(listed.slices.find((s: { id: number }) => s.id === 2)).toMatchObject({ owner: "ui-designer", status: "pending" });
    expect(running).toBe("running");
    expect(waited).toMatchObject({ state: "committed" });
    expect(scope.verdict).not.toBe("flag");
    expect(scope.verdict).not.toBe("wait");
    // the branch: the tests commit, slice 1's commit, then the picked commit
    expect(r.result.outcome).toBe("pass");
    const [first, ...picked] = r.commits();
    expect(first).toBe(slice1);
    const rowsPicked = r.kinds("build.helper_picked");
    expect(rowsPicked).toHaveLength(1);
    expect(rowsPicked[0]!.picked).toEqual(picked);
    expect(picked).toHaveLength(1);
    expect(rowsPicked[0]).toMatchObject({ slice: 2, tip: r.tip(), onto: slice1 });
    expect(git(r.path, "log", "-1", "--format=%s", picked[0]!)).toBe("ui: the price view");
    expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("'two'");
    expect(r.show(r.tip(), "src/api/price.ts")).toContain("price = 2");
    // the importer never reported a moved head, and the machine kept the card's folder in step
    expect(r.notes.join("\n")).not.toContain("head_moved");
    expect(git(r.path, "rev-parse", "HEAD")).toBe(r.tip());
    // the checkpoint ref in the user's repository holds the tip
    expect(git(repo, "rev-parse", `refs/luna/wip/${r.branch}`)).toBe(r.tip());
    // rows: one helper, started once and ended once, nothing refused
    expect(r.kinds("build.helper_started")).toHaveLength(1);
    expect(r.kinds("build.helper_ended")).toEqual([expect.objectContaining({ slice: 2, attempt: 1, outcome: "pass" })]);
    expect(r.kinds("build.helper_refused")).toEqual([]);
    expect(r.containers.filter((p) => p === "ui_design")).toHaveLength(1);
    // what the board reads, built from those rows
    const run = { id: "r", stage: "implementing", attempt: 1, status: "passed", outcome: "pass", engine: "claude:sonnet", inputCommit: null, outputCommit: r.tip(), startedAt: new Date(1_700_000_000_000), endedAt: new Date(1_700_000_060_000) } as unknown as StageRunRow;
    const progress = buildProgressOf([run], events(r.rows), limits)!;
    expect(progress.helper).toMatchObject({ slice: 2, state: "committed", attempt: 1 });
    expect(progress.slices).toContainEqual({ slice: 2, owner: "ui-designer", picked });
    expect(buildReportOf({ branch: r.branch } as TaskRow, [run], [...events(r.rows), { id: "z", taskId: TASK, stageRunId: null, kind: "stage.finished", payload: { stage: "implementing", attempt: 1, status: "passed", outcome: "pass", detail: {} }, at: new Date() }])?.picked).toEqual([{ slice: 2, shas: picked, tip: r.tip() }]);
    expect(detailOf(r.result).helper).toMatchObject({ slice: 2, state: "committed", picked });
  }, 20_000);

  it("a stray commit during the handshake: the machine says retry, the factory bundles again and the pick lands", async () => {
    const r = await rig({
      implementer: async (c) => {
        await c.init([1, 2]);
        await c.call("slice_delegate", { slice: 2 });
        await c.finish(1, "src/api/price.ts", "export const price = 2;\n");
        // the agent commits once more right after the factory bundled, before the machine has seen that commit
        c.strayOnNextBundle("src/api/extra.ts", "export const extra = 1;\n");
        const waited = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        expect(waited).toMatchObject({ state: "committed" });
        expect(c.files("pick-request-")).toHaveLength(2);
        expect(c.files("pick-ack-")).toHaveLength(1);
        c.end({ answer: { outOfMap: [{ path: "src/api/extra.ts", reason: "a helper the price api needs" }] } });
      },
      helper: (run) => {
        writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'two';\nexport const label = 'a';\n");
        agent(run.worktree, "add", "-A");
        agent(run.worktree, "commit", "-q", "-m", "ui");
      },
    });
    expect(r.result.outcome).toBe("pass");
    const picked = r.kinds("build.helper_picked")[0]!;
    // the stray commit is on the branch below the picked ones, and nothing was lost
    expect(r.commits()).toHaveLength(3);
    expect(r.commits().slice(-picked.picked.length)).toEqual(picked.picked);
    expect(r.show(r.tip(), "src/api/extra.ts")).toContain("extra");
    expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("'two'");
    expect(r.notes.join("\n")).not.toContain("head_moved");
  }, 20_000);

  it("a conflict once: the helper runs again on the new head, and its second pick lands", async () => {
    const attempts: number[] = [];
    let first = "";
    const r = await rig({
      implementer: async (c) => {
        await c.init([1, 2]);
        await c.call("slice_delegate", { slice: 2 });
        // both add src/ui/index.ts, a file no slice plans: the helper's copy was made at the old head
        first = c.commit("src/ui/index.ts", "// the implementer's barrel\n");
        await c.call("slice_set", { id: 1, status: "committed", commit: first });
        let waited = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        // the first pick conflicts: the machine started the helper again and the tool says so
        expect(waited.error).toMatch(/conflict/);
        waited = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        expect(waited).toMatchObject({ state: "committed", attempt: 2 });
        c.end({ answer: { outOfMap: [{ path: "src/ui/index.ts", reason: "the barrel for the ui folder" }] } });
      },
      helper: (run, attempt) => {
        attempts.push(attempt);
        if (attempt === 1) writeFileSync(join(run.worktree, "src/ui/index.ts"), "// the helper's barrel\n");
        writeFileSync(join(run.worktree, "src/ui/Price.tsx"), `export const Price = () => 'attempt ${attempt}';\nexport const label = 'a';\n`);
        agent(run.worktree, "add", "-A");
        agent(run.worktree, "commit", "-q", "-m", `ui ${attempt}`);
      },
    });
    expect(attempts).toEqual([1, 2]);
    expect(r.result.outcome).toBe("pass");
    expect(r.kinds("build.helper_conflict")).toEqual([expect.objectContaining({ slice: 2, attempt: 1 })]);
    expect(r.show(r.tip(), "src/ui/index.ts")).toContain("implementer's barrel");
    expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("attempt 2");
    expect(r.kinds("build.helper_picked")).toHaveLength(1);
    expect(r.commits()[0]).toBe(first);
    const run = { id: "r", stage: "implementing", attempt: 1, status: "running", startedAt: new Date(1_700_000_000_000), endedAt: null } as unknown as StageRunRow;
    expect(buildProgressOf([run], events(r.rows), limits)!.helper).toMatchObject({ slice: 2, state: "committed", attempt: 2 });
  }, 20_000);

  it("a conflict twice: the run escalates merge_conflict, whatever the agent answered, and slice 1 is still on the branch", async () => {
    let slice1 = "";
    const r = await rig({
      implementer: async (c) => {
        await c.init([1, 2]);
        await c.call("slice_delegate", { slice: 2 });
        // the implementer edits the helper's file too (no scope check asked): every pick of the view conflicts
        slice1 = await c.finish(1, "src/ui/Price.tsx", "export const Price = () => 'mine';\nexport const label = 'a';\n");
        const first = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        expect(first.error).toMatch(/conflict/);
        // the helper is building again on the new head; the implementer commits over its line before it returns
        c.commit("src/ui/Price.tsx", "export const Price = () => 'mine again';\nexport const label = 'a';\n");
        const second = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        expect(second.error).toMatch(/conflict/);
        c.end({ summary: "all done" });
      },
      helper: (run) => {
        writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'theirs';\nexport const label = 'a';\n");
        agent(run.worktree, "add", "-A");
        agent(run.worktree, "commit", "-q", "-m", "ui");
      },
    });
    expect(r.result.outcome).toBe("escalated");
    expect(detailOf(r.result)).toMatchObject({ escalation: "merge_conflict", escalationFact: "merge_conflict", options: [], helper: { slice: 2, state: "merge_conflict", attempt: 2 } });
    expect(r.kinds("build.helper_conflict").map((c) => c.attempt)).toEqual([1, 2]);
    expect(r.kinds("build.helper_picked")).toEqual([]);
    expect(r.commits()[0]).toBe(slice1);
    expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("mine again");
    const run = { id: "r", stage: "implementing", attempt: 1, status: "running", startedAt: new Date(1_700_000_000_000), endedAt: null } as unknown as StageRunRow;
    const progress = buildProgressOf([run], events(r.rows), limits)!;
    expect(progress.helper?.state).toBe("merge_conflict");
    expect(progress.slices).toContainEqual({ slice: 2, owner: "implementer" });
  }, 25_000);

  it("a lock violation: the implementer commits the helper's file, and the machine's scope check flags a locked_file blocker (the factory itself says wait)", async () => {
    const release = gate();
    let tool: Record<string, any> = {};
    let verdict: Record<string, any> = {};
    const r = await rig({
      implementer: async (c) => {
        await c.init([1, 2]);
        await c.call("slice_delegate", { slice: 2 });
        await c.finish(1, "src/ui/Price.tsx", "export const Price = () => 'not mine';\nexport const label = 'a';\n");
        tool = await c.call("scope_check", { diffSummary: "x", outOfMap: [] });
        // a container that ignores the factory's refusal still meets the machine's own check
        writeFileSync(join(c.checks, "scope-request.json"), JSON.stringify({ diffSummary: "x", outOfMap: [] }));
        for (let i = 0; i < 600 && !existsSync(join(c.checks, "scope.json")); i++) await new Promise((res) => setTimeout(res, 10));
        verdict = JSON.parse(readFileSync(join(c.checks, "scope.json"), "utf8"));
        release.open();
      },
      helper: async () => {
        await release.promise;
      },
    });
    expect(tool).toMatchObject({ verdict: "wait" });
    expect(verdict.verdict).toBe("flag");
    expect(verdict.facts.lockedTouched).toEqual([{ path: "src/ui/Price.tsx", owner: "ui-designer" }]);
    expect(JSON.stringify(verdict.problems)).toContain("src/ui/Price.tsx");
    expect(r.result.outcome).toBe("pass");
  }, 20_000);

  describe("refusals", () => {
    it("a logic slice stays with the implementer, with a row that says why", async () => {
      let answer: Record<string, any> = {};
      const r = await rig({
        implementer: async (c) => {
          await c.init([1, 2]);
          answer = await c.call("slice_delegate", { slice: 1 });
        },
      });
      expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("not a pure UI slice") });
      expect(r.containers).toEqual(["implementing"]);
      expect(r.kinds("build.helper_refused")).toEqual([expect.objectContaining({ slice: 1 })]);
      expect(r.kinds("build.helper_started")).toEqual([]);
    }, 20_000);

    it("a second helper while one is out", async () => {
      const release = gate();
      let second: Record<string, any> = {};
      const r = await rig({
        plan: [LOGIC, VIEW, TOTAL],
        implementer: async (c) => {
          await c.init([1, 2, 3]);
          expect(await c.call("slice_delegate", { slice: 2 })).toMatchObject({ ok: true });
          second = await c.call("slice_delegate", { slice: 3 });
          release.open();
          await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        },
        helper: async (run) => {
          await release.promise;
          writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'two';\nexport const label = 'a';\n");
          agent(run.worktree, "add", "-A");
          agent(run.worktree, "commit", "-q", "-m", "ui");
        },
      });
      expect(second).toMatchObject({ ok: false, error: expect.stringContaining("already building slice 2") });
      expect(r.kinds("build.helper_refused")).toEqual([expect.objectContaining({ slice: 3 })]);
      expect(r.containers.filter((p) => p === "ui_design")).toHaveLength(1);
      expect(r.kinds("build.helper_picked")).toHaveLength(1);
    }, 20_000);

    it("design: off — the implementer is told it may not delegate, no coordinator is built and no helper runs", async () => {
      let answer: Record<string, any> = {};
      let delegation: unknown;
      const r = await rig({
        policy: { design: "off" },
        checkWaitMs: 300,
        implementer: async (c) => {
          delegation = (c.run.input as { context: { delegation?: unknown } }).context.delegation;
          await c.init([1, 2]);
          answer = await c.call("slice_delegate", { slice: 2 });
        },
      });
      expect(delegation).toEqual({ available: false, reason: "design is off for this repo" });
      expect(answer).toMatchObject({ ok: false });
      expect(r.coordinator()).toBeUndefined();
      expect(r.containers).toEqual(["implementing"]);
      expect(r.kinds("build.helper_started")).toEqual([]);
      expect(r.result.outcome).toBe("pass");
    }, 20_000);
  });

  it("the machine's move of the branch is refused after the pick: the factory takes its merge back, asks again, and the second pick lands", async () => {
    let refused = 0;
    let headAfterRefusal = "";
    let before = "";
    let first: Record<string, any> = {};
    const r = await rig({
      git: (real) => ({
        ...real,
        // the card's branch moved between the pick and the acknowledgement
        advanceBranch: async (...args) => {
          if (refused === 0) {
            refused += 1;
            return { ok: false, reason: "moved" } as never;
          }
          return real.advanceBranch(...args);
        },
      }),
      implementer: async (c) => {
        await c.init([1, 2]);
        await c.call("slice_delegate", { slice: 2 });
        before = await c.finish(1, "src/api/price.ts", "export const price = 2;\n");
        first = await c.call("slice_wait", { slice: 2, waitSeconds: 15 });
        headAfterRefusal = agent(c.work, "rev-parse", "HEAD");
        expect(await c.call("slice_wait", { slice: 2, waitSeconds: 15 })).toMatchObject({ state: "committed" });
      },
      helper: (run) => {
        writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'two';\nexport const label = 'a';\n");
        agent(run.worktree, "add", "-A");
        agent(run.worktree, "commit", "-q", "-m", "ui");
      },
    });
    expect(refused).toBe(1);
    expect(first.error).toMatch(/could not move the card's branch/);
    // the factory's merge was taken back: its HEAD is where the pick started
    expect(headAfterRefusal).toBe(before);
    expect(r.result.outcome).toBe("pass");
    const picked = r.kinds("build.helper_picked");
    expect(picked).toHaveLength(1);
    expect(r.commits().slice(-picked[0]!.picked.length)).toEqual(picked[0]!.picked);
    expect(r.tip()).toBe(picked[0]!.tip);
    expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("'two'");
  }, 25_000);

  describe("the end of the run (D7)", () => {
    const helperCommit = (run: SandboxRun) => {
      writeFileSync(join(run.worktree, "src/ui/Price.tsx"), "export const Price = () => 'two';\nexport const label = 'a';\n");
      agent(run.worktree, "add", "-A");
      agent(run.worktree, "commit", "-q", "-m", "ui");
    };

    it("after a pass the machine waits for the helper, picks onto the branch itself and puts the commits in the card's folder", async () => {
      let slice1 = "";
      const r = await rig({
        implementer: async (c) => {
          await c.init([1, 2]);
          await c.call("slice_delegate", { slice: 2 });
          slice1 = await c.finish(1, "src/api/price.ts", "export const price = 2;\n");
          // the agent answers without waiting: the helper is still running
        },
        helper: async (run) => {
          await new Promise((res) => setTimeout(res, 300));
          helperCommit(run);
        },
      });
      expect(r.result.outcome).toBe("pass");
      const picked = r.kinds("build.helper_picked");
      expect(picked).toHaveLength(1);
      expect(picked[0]).toMatchObject({ onto: slice1, tip: r.tip() });
      expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("'two'");
      expect(git(r.path, "rev-parse", "HEAD")).toBe(r.tip());
      expect(readFileSync(join(r.path, "src/ui/Price.tsx"), "utf8")).toContain("'two'");
      expect(detailOf(r.result).helper).toMatchObject({ slice: 2, state: "committed" });
    }, 20_000);

    it.each([
      ["an escalated outcome (schema 2)", { schema: 2 as const, outcome: "escalated" as const, answer: { kind: "escalated", summary: "stopped", reason: "needs a dependency", options: [] } }],
      ["a pass whose answer escalated (a runner before the escalated outcome)", { outcome: "pass" as const, answer: { kind: "escalated", summary: "stopped", reason: "needs a dependency", options: [] } }],
    ])("%s lands nothing: the returned helper is cancelled and its commits stay on its own ref", async (_why, over) => {
      const returned = gate();
      let slice1 = "";
      const r = await rig({
        output: over,
        implementer: async (c) => {
          await c.init([1, 2]);
          await c.call("slice_delegate", { slice: 2 });
          slice1 = await c.finish(1, "src/api/price.ts", "export const price = 2;\n");
          // wait until the machine holds the helper's commits as returned, then answer escalated
          for (let i = 0; i < 600 && c.state(2)?.state !== "returned"; i++) await new Promise((res) => setTimeout(res, 10));
          expect(c.state(2)?.state).toBe("returned");
          returned.open();
        },
        helper: helperCommit,
      });
      await returned.promise;
      expect(r.result.outcome).toBe("escalated");
      expect(r.kinds("build.helper_picked")).toEqual([]);
      expect(r.tip()).toBe(slice1);
      expect(r.show(r.tip(), "src/ui/Price.tsx")).toContain("'one'");
      expect(detailOf(r.result).helper).toMatchObject({ slice: 2, state: "cancelled" });
      // the helper's commits are kept where the machine put them, not on the card's branch
      expect(git(r.path, "rev-parse", `refs/luna/helper/${TASK}/2`)).not.toBe(slice1);
    }, 20_000);
  });
});
