import { RepoImageError } from "../repo-images.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { FACTORY_DEFAULTS, PACKS, StageInput, type StageOutput } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialWaitError, type Credentials, NoCredentialError, fixedCredentials } from "../../adapters/credentials/index.ts";
import { envHash } from "../../domain/env-hash.ts";
import { machineGitDir } from "../../adapters/git/machine-repo.ts";
import { HOST_GIT, headCommit } from "../../adapters/git/worktree.ts";
import { ensureClone } from "../../adapters/git/clone.ts";
import { helperWorkspace } from "../../adapters/git/helper.ts";
import { DEFAULT_POLICY } from "../../domain/policy.ts";
import type { TaskRow } from "../../domain/task.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { EgressUnsupportedError } from "../../adapters/docker/egress.ts";
import { RuntimeUnavailableError } from "../../adapters/docker/runtimes.ts";
import { SeccompUnavailableError } from "../../adapters/docker/seccomp.ts";
import type { SecretStore } from "../secrets.ts";
import { noEconomy } from "../economy.ts";
import { type AgentDeps, agentRunners, runAgent } from "./pack-runner.ts";
import type { StageContext } from "../ports.ts";
import type { Graph, GraphStamp } from "../graph.ts";
import { noTokenMcp, type Mcp } from "../mcp.ts";
import { createMcp } from "../../adapters/mcp/client.ts";
import { engineBudgetGate, gatedCredentials, runtimeKillSwitch } from "../engine-gates.ts";

/** What the agent does in its own repository, in the folder's own .git (the one the machine made for it). */
const agent = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

/** git in a repository of the user's, or, for a card's workspace, in the machine's repository for it (the agent's commits arrive there). */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...(existsSync(machineGitDir(cwd)) ? ["--git-dir=" + machineGitDir(cwd), "--work-tree=" + cwd] : []), "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
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
    // The factory's job in the container: the agent's commits leave as a bundle from the tip the run started at.
    const scratchHead = () => {
      try {
        return agent(run.worktree, "rev-parse", "HEAD");
      } catch {
        return null;
      }
    };
    const started = scratchHead();
    act(run);
    const ended = scratchHead();
    if (started && ended && ended !== started) {
      mkdirSync(join(out, "bundles"), { recursive: true });
      agent(run.worktree, "bundle", "create", join(out, "bundles", "1.bundle"), `${started}..HEAD`);
    }
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
    videoImage: "video-img",
    credentials: fixedCredentials({ ANTHROPIC_API_KEY: "x" }),
    worktreesDir: join(root, "worktrees"),
    stateDir,
    watcher: { follow: vi.fn() } as never,
    sandbox,
  };
}

/** The mounts a run has besides the worktree's own `.git` file. */
const extraMounts = (run: SandboxRun) => (run.mounts ?? []).filter((m) => m.container !== "/work/.git");

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

describe("agent stages through packs", () => {
  it("registers a runner for every pack dispatched unmodified; the rest are wrapped in bootstrap", () => {
    const r = runners(fakeSandbox(output()));
    expect(Object.keys(r).sort()).toEqual(["implementing", "triage"]);
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
    expect(seen?.timeoutMs).toBe(300_000);
    expect(result.outcome).toBe("pass");
    expect(result.usage).toEqual({ turns: 7, costUsd: 0.5, tokens: null });
    expect(result.events?.map((e) => e.kind)).toEqual(["slice_committed"]);
    expect(result.artifacts).toHaveLength(1);
    expect(existsSync(result.artifacts![0]!.path)).toBe(true);
    expect(result.detail).toMatchObject({ brief: "did it" });
  });

  it("hands the sandbox the run's trace context as extra env, and nothing when there is none", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, { ...context("triage"), traceEnv: { LMNR_SPAN_CONTEXT: "ctx" } }, "triage");
    expect(seen?.extraEnv).toEqual({ LMNR_SPAN_CONTEXT: "ctx" });
    await runAgent(d, context("triage"), "triage");
    expect(seen?.extraEnv).toEqual({});
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

  it("runs recording in the video image (the QA image when there is none) and the other video packs in the base image", async () => {
    const d = deps(fakeSandbox(output()));
    await runAgent(d, context("evidence"), "recording");
    expect(seen?.image).toBe("video-img");
    await runAgent({ ...d, videoImage: undefined }, context("evidence"), "recording");
    expect(seen?.image).toBe("qa-img");
    for (const pack of ["video_script", "video_fix", "video_qa"] as const) {
      await runAgent(d, context("evidence"), pack);
      expect(seen?.image, pack).toBe("img");
    }
  });

  it("hands the recorder only the target the film is recorded against, never the whole luna.yaml list", async () => {
    const d = deps(fakeSandbox(output({})));
    const target = { name: "staging", baseUrl: "https://staging.example", credential: null };
    const video = { scenarios: [], record: null, pack: { summary: "s", howToVerify: "h", risk: null }, steps: [], chapters: [], target, narration: null, timeline: null, report: null, transcript: null, sheets: [], fixCards: [] };
    await runAgent(d, context("evidence"), "recording", { video });
    expect((seen?.input as { context: { qaTargets?: unknown } }).context.qaTargets).toEqual([target]);
    await runAgent(d, context("evidence"), "recording", { video: { ...video, target: null } });
    expect((seen?.input as { context: { qaTargets?: unknown } }).context.qaTargets).toEqual([]);
  });

  it("hands a video pack its VideoContext and mounts what the caller asks for, after the worktree's own mounts", async () => {
    const d = deps(fakeSandbox(output()));
    const video = { scenarios: [], record: null, pack: { summary: "s", howToVerify: "h", risk: null }, steps: [], chapters: [], target: null, narration: null, timeline: null, report: null, transcript: null, sheets: ["/evidence/sheets/beats_sheet.jpg"], fixCards: [] };
    const mounts = [{ host: join(root, "state", "runs", "run-1-video", "files", "video"), container: "/evidence", readOnly: true }];
    await runAgent(d, context("evidence"), "video_qa", { video, mounts });
    expect((seen?.input as { context: { video?: unknown } }).context.video).toEqual(video);
    expect(extraMounts(seen!)).toContainEqual(mounts[0]);
    await runAgent(d, context("evidence"), "triage", { video, mounts });
    expect((seen?.input as { context: { video?: unknown } }).context.video).toBeUndefined();
  });

  it.each([
    ["an escalated outcome (schema 2)", { schema: 2 as const, outcome: "escalated" as const }],
    ["a pass whose answer escalated (schema 1, runners before the escalated outcome)", { outcome: "pass" as const }],
  ])("reports %s as escalated, with the agent's reason and options", async (_, over) => {
    const answer = { kind: "escalated", summary: "stopped", reason: "needs a new dependency", options: ["add it", "drop it"] };
    const run = runners(fakeSandbox(output({ ...over, summary: "stopped", answer })));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ reason: "needs a new dependency", options: ["add it", "drop it"], escalation: "other" });
  });

  it("leaves an escalated run's clone exactly as the agent left it, saves the uncommitted work on refs/luna/kept/<run>, and names the folder", async () => {
    const answer = { kind: "escalated", summary: "stopped", reason: "needs a new dependency", options: [] };
    const run = runners(fakeSandbox(output({ summary: "stopped", answer }), (r) => writeFileSync(join(r.worktree, "half.txt"), "half done\n")));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("escalated");
    const path = seen!.worktree;
    expect(readFileSync(join(path, "half.txt"), "utf8")).toBe("half done\n");
    expect(git(path, "status", "--porcelain")).toBe("?? half.txt");
    expect(git(path, "show", "refs/luna/kept/run-1:half.txt")).toBe("half done");
    expect(result.detail).toMatchObject({ keptSandbox: { path, ref: "refs/luna/kept/run-1", keepHours: 24, until: expect.any(String) } });
    expect(existsSync(join(stateDir, "kept", "run-1.json"))).toBe(true);
  });

  it("still resets a failed run, which the next attempt starts over from", async () => {
    const run = runners(fakeSandbox(output({ outcome: "fail", ok: false } as never), (r) => writeFileSync(join(r.worktree, "half.txt"), "x\n")));
    await run.implementing!(context("implementing"));
    expect(existsSync(join(seen!.worktree, "half.txt"))).toBe(false);
  });

  it("sizes the container from the repository's sandbox section, two CPUs and four gigabytes without one", async () => {
    await runners(fakeSandbox(output())).triage!(context("triage"));
    expect(seen!.limits).toEqual({ cpu: 2, memoryGb: 4, pids: 1024, cacheTrust: "trusted" });
    const small = { ...deps(fakeSandbox(output())), policies: { for: async () => ({ ...DEFAULT_POLICY, factory: { ...FACTORY_DEFAULTS, sandbox: { ...FACTORY_DEFAULTS.sandbox, cpu: 2, memory_gb: 3 } } }) } as never };
    await agentRunners(small).triage!(context("triage"));
    expect(seen!.limits).toEqual({ cpu: 2, memoryGb: 3, pids: 1024, cacheTrust: "trusted" });
  });

  it("runs at the bounded size and the owner's seccomp profile, and leaves a note on the task for a capped size", async () => {
    const bounds = { notes: ["sandbox.cpu 16 is capped at 4 by the machine's sandbox policy (limits.max_cpu)"], egress: [], image: [], seccomp: "/etc/luna/seccomp.json", runtime: { default: "runc", untrusted: "runc" }, maxPids: 1024, splitCache: true };
    const capped = { ...deps(fakeSandbox(output())), policies: { for: async () => ({ ...DEFAULT_POLICY, bounds, factory: { ...FACTORY_DEFAULTS, sandbox: { ...FACTORY_DEFAULTS.sandbox, cpu: 4, memory_gb: 4 } } }) } as never };
    const note = vi.fn(async () => {});
    await agentRunners(capped).triage!({ ...context("triage"), note });
    expect(seen!.limits).toEqual({ cpu: 4, memoryGb: 4, pids: 1024, cacheTrust: "trusted", seccomp: "/etc/luna/seccomp.json" });
    expect(note).toHaveBeenCalledWith(bounds.notes[0]);
  });

  describe("a card from outside the repository's people", () => {
    const stranger = (ctx: StageContext, authorAssociation = "NONE"): StageContext => ({ ...ctx, task: { ...ctx.task, id: `stranger-${authorAssociation}-${Math.random()}`, source: { kind: "github", repo: "o/a", number: 9, url: "u", authorAssociation } } as unknown as TaskRow });
    const bounds = { notes: [], egress: [], image: [], seccomp: null, runtime: { default: "runc", untrusted: "runsc" }, maxPids: 300, splitCache: true };
    const withBounds = (over = {}) => ({ ...deps(fakeSandbox(output())), policies: { for: async () => ({ ...DEFAULT_POLICY, bounds: { ...bounds, ...over } }) } as never });

    it("gets its own cache volume and the policy's runtime, and says so on the task once", async () => {
      const note = vi.fn(async (_text: string) => {});
      const runner = agentRunners(withBounds());
      const ctx = { ...stranger(context("triage")), note };
      await runner.triage!(ctx);
      expect(seen!.cacheVolume).toBe("hardness-cache-repo-untrusted");
      expect(seen!.limits).toMatchObject({ runtime: "runsc", pids: 300, cacheTrust: "untrusted" });
      await runner.triage!(ctx);
      expect(note.mock.calls.filter(([text]) => String(text).includes("runs untrusted"))).toEqual([["This card runs untrusted (its GitHub author is not an owner, member or collaborator): its own cache volume and the runsc container runtime."]]);
    });

    it("keeps the shared cache when the policy does not split, and a trusted card keeps runc", async () => {
      await agentRunners(withBounds({ splitCache: false })).triage!(stranger(context("triage")));
      expect(seen!.cacheVolume).toBe("hardness-cache-repo");
      await agentRunners(withBounds()).triage!(stranger(context("triage"), "MEMBER"));
      expect(seen!.cacheVolume).toBe("hardness-cache-repo");
      expect(seen!.limits).not.toHaveProperty("runtime");
    });
  });

  it("carries the agent's typed escalation reason, and reads one off the enum as other", async () => {
    const answer = { kind: "escalated", summary: "stopped", reason: "the plan names a module that does not exist", options: [], escalation: "plan_wrong" };
    const wrong = await runners(fakeSandbox(output({ schema: 2 as const, outcome: "escalated" as const, summary: "stopped", answer }))).implementing!(context("implementing"));
    expect(wrong.detail).toMatchObject({ escalation: "plan_wrong" });
    const off = await runners(fakeSandbox(output({ schema: 2 as const, outcome: "escalated" as const, summary: "stopped", answer: { ...answer, escalation: "gremlins" } }))).implementing!(context("implementing"));
    expect(off.detail).toMatchObject({ escalation: "other" });
  });

  it("refuses to write on a branch the pipeline does not own, whatever the task row says", async () => {
    const sandbox = vi.fn(fakeSandbox(output()));
    const tampered = { ...context("implementing"), task: { ...context("implementing").task, branch: "main", worktreePath: repo } };
    const result = await runners(sandbox).implementing!(tampered);
    expect(result).toMatchObject({ outcome: "fail", detail: { error: "refusing to run implementing on branch main: the pipeline only writes task/* branches (or the branch it named for a Jira-linked task)" } });
    expect(sandbox).not.toHaveBeenCalled();
    // A read-only pack is refused too: a folder that is not a card's workspace (the repository's own checkout) is nobody's to run in.
    const read = await runners(sandbox).triage!({ ...tampered, stage: "triage" });
    expect(read).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("not a card's workspace") } });
    expect(sandbox).not.toHaveBeenCalled();
  });

  it("keeps a linked task on the branch it already works on, even after Jira renamed the issue type", async () => {
    // The first run named bug/PLAT-123; the issue is a Story now, so the pattern would say story/PLAT-123.
    const linked = {
      ...context("implementing"),
      task: {
        ...context("implementing").task,
        branch: "bug/PLAT-123",
        worktreePath: join(root, "worktrees", "repo", "bug-PLAT-123"),
        jira: { key: "PLAT-123", url: "u", issueType: "Story", status: null, priority: null, dueAt: null, syncedAt: null, blocked: null },
      },
    };
    const result = await runners(fakeSandbox(output())).implementing!(linked);
    expect(result.outcome).toBe("pass");
    expect(result.workspace).toEqual({ branch: "bug/PLAT-123", worktreePath: linked.task.worktreePath });
    expect(seen!.worktree).toBe(linked.task.worktreePath);
    expect(git(seen!.worktree, "branch", "--show-current")).toBe("bug/PLAT-123");
    // A persisted branch that is none of the pipeline's is still refused.
    const main = { ...linked, task: { ...linked.task, branch: "main", worktreePath: repo } };
    expect(await runners(fakeSandbox(output())).implementing!(main)).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("refusing to run implementing on branch main") } });
  });

  describe("the code graph", () => {
    const stamp: GraphStamp = { schema: 1, commit: "c".repeat(40), builtAt: "2026-11-04T10:00:00Z", nodes: 3, edges: 2, communities: 1, graphify: "0.9.34" };
    const graphOf = (has: boolean, fresh = true): Graph => ({
      stampOf: async () => (has ? stamp : null),
      currentDir: () => (has ? "/state/graphs/repo/current" : null),
      build: async () => stamp,
      isFresh: async () => fresh,
      recordMisses: async () => {},
      locate: async () => null,
      impact: async () => null,
      owners: async () => null,
    });
    const withGraph = (graph: Graph, ensure?: (repo: string) => void) => agentRunners({ ...deps(fakeSandbox(output())), graph, ensureGraph: ensure });

    it("mounts the repo's current graph read-only at /graph, points LUNA_GRAPH at it and says how fresh it is", async () => {
      await withGraph(graphOf(true)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([{ host: "/state/graphs/repo/current", container: "/graph", readOnly: true }]);
      expect(seen!.extraEnv).toMatchObject({ LUNA_GRAPH: "/graph/graphify-out/graph.json" });
      expect((seen!.input as unknown as StageInput).context.graph).toEqual({ path: "/graph/graphify-out/graph.json", commit: stamp.commit, builtAt: stamp.builtAt, fresh: true });
    });

    it("marks a graph older than the base commit stale", async () => {
      await withGraph(graphOf(true, false)).triage!(context("triage"));
      expect((seen!.input as unknown as StageInput).context.graph).toMatchObject({ fresh: false });
    });

    it("mounts nothing and says so when the repo has no graph, and asks for a first build", async () => {
      const ensured: string[] = [];
      await withGraph(graphOf(false), (repo) => ensured.push(repo)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([]);
      expect(seen!.extraEnv?.LUNA_GRAPH).toBeUndefined();
      expect((seen!.input as unknown as StageInput).context.graph).toBeNull();
      expect(ensured).toEqual([repo]);
    });

    it("leaves the graph out when the repo's luna.yaml turns it off", async () => {
      writeFileSync(join(repo, "luna.yaml"), "policy:\n  graph: off\n");
      await withGraph(graphOf(true)).triage!(context("triage"));
      expect(extraMounts(seen!)).toEqual([]);
      expect((seen!.input as unknown as StageInput).context.graph).toBeNull();
    });
  });

  it("runs a new card in its own clone: the repository's git dir is not mounted and its branches stay as they were", async () => {
    const refs = () => execFileSync("git", ["-C", repo, "for-each-ref"], { encoding: "utf8" });
    const before = refs();
    await runners(fakeSandbox(output())).implementing!(context("implementing"));
    expect(seen!.writable).toBe(true);
    expect(statSync(join(seen!.worktree, ".git")).isDirectory()).toBe(true);
    expect(seen!.gitDir).toBeNull();
    expect(seen!.mounts).not.toContainEqual(expect.objectContaining({ container: "/work/.git" }));
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
    expect(refs()).toBe(before);
  });

  it("moves a card still on a linked worktree to a workspace of its own before its next run, read-only or not, work and commits kept, and mounts no git dir", async () => {
    const path = join(root, "worktrees", "repo", "task-linked");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "task/linked", path]);
    writeFileSync(join(path, "wip.txt"), "uncommitted\n");
    const linked = (stage: StageContext["stage"]) => ({ ...context(stage), task: { ...context(stage).task, branch: "task/linked", worktreePath: path } }) as StageContext;
    let carried = "";
    await runners(fakeSandbox(output(), (run) => void (carried = readFileSync(join(run.worktree, "wip.txt"), "utf8")))).triage!(linked("triage"));
    expect(carried).toBe("uncommitted\n");
    expect(seen!.gitDir).toBeNull();
    expect(seen!.mounts).not.toContainEqual(expect.objectContaining({ container: "/work/.git" }));
    expect(existsSync(machineGitDir(path))).toBe(true);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" })).not.toContain("task-linked");
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("task/linked");
  });

  it("gives the sandbox the repo's cache volume, so a retry or the next task of the repo installs warm", async () => {
    await runners(fakeSandbox(output())).triage!(context("triage"));
    expect(seen!.cacheVolume).toBe("hardness-cache-repo");
  });

  it("keeps triage's outcome, record and reply on the stage detail, and defaults the outcome to plan", async () => {
    const record = { kind: "question", goal: "answer how to run the board", size: "tiny", urgency: "normal", risk: "none", reason: "asks how, changes nothing" };
    const conversation = { kind: "brief", summary: "s", outcome: "conversation", record, reply: "Use `pnpm dev`." };
    const talked = await runners(fakeSandbox(output({ answer: conversation }))).triage!(context("triage"));
    expect(talked.detail).toMatchObject({ outcome: "conversation", record, reply: "Use `pnpm dev`.", brief: "s" });
    const archived = await runners(fakeSandbox(output({ answer: { kind: "brief", summary: "s", outcome: "archive", archiveReason: "duplicate" } }))).triage!(context("triage"));
    expect(archived.detail).toMatchObject({ outcome: "archive", archiveReason: "duplicate" });
    const bare = await runners(fakeSandbox(output({ answer: { kind: "brief", summary: "s", criteria: ["c"] } }))).triage!(context("triage"));
    expect(bare.detail).toMatchObject({ outcome: "plan", criteria: ["c"] });
    expect(bare.detail).not.toHaveProperty("assumptions");
    expect(bare.detail).not.toHaveProperty("confidence");
  });

  it("reads a council member's answer: the summary and the findings ride on the detail", async () => {
    const finding = { path: "plan", line: 1, severity: "security", title: "No auth", body: "Anyone can export.", confidence: 0.9 };
    const heard = await runAgent(deps(fakeSandbox(output({ answer: { summary: "one gap", findings: [finding] } }))), context("test_design"), "council_security");
    expect(heard.outcome).toBe("pass");
    expect(heard.detail).toMatchObject({ summary: "one gap", findings: [finding] });
  });

  it("tells the machine a council member's container, and the question council's, since a sub-run's own `started` is withheld", async () => {
    for (const [pack, state] of [["council_security", "test_design"], ["council_second", "test_design"], ["question_council", "triage"]] as const) {
      const subStarted = vi.fn(async (_facts: { container: string }) => {});
      await runAgent(deps(fakeSandbox(output({ answer: { summary: "s", findings: [], answers: [] } }))), { ...context(state), subStarted }, pack);
      expect(subStarted, pack).toHaveBeenCalledTimes(1);
      expect(subStarted.mock.calls[0]![0].container, pack).toMatch(/^hardness-[0-9a-f]{8}-/);
      expect(seen!.name).toBe(subStarted.mock.calls[0]![0].container);
    }
  });

  it("does not report a sub-run container for a pack that is a stage of its own, or for a re-attached council run", async () => {
    const subStarted = vi.fn(async (_facts: { container: string }) => {});
    await runAgent(deps(fakeSandbox(output())), { ...context("triage"), subStarted }, "triage");
    expect(subStarted).not.toHaveBeenCalled();
    await runAgent(deps(fakeSandbox(output({ answer: { answers: [] } }))), { ...context("triage"), subStarted, resume: { container: "hardness-abcd1234-question-council-1", inputCommit: null } }, "question_council");
    expect(subStarted).not.toHaveBeenCalled();
  });

  it("reads the question council's answer: the answers ride on the detail", async () => {
    const answers = [{ id: "q1", answer: "pnpm", confidence: 0.9, evidence: ["package.json:3"] }, { id: "q2", answer: null, confidence: 0, evidence: [] }];
    const heard = await runAgent(deps(fakeSandbox(output({ answer: { answers } }))), context("triage"), "question_council");
    expect(heard.outcome).toBe("pass");
    expect(heard.detail).toMatchObject({ answers });
  });

  it("answers the question council's card_search from the task's own repository, as triage's is", async () => {
    const asked: Array<{ repoPath: string; query: string }> = [];
    const cards = { search: async (q: { repoPath: string; query: string }) => (asked.push(q), [{ id: "c1", title: "Export CSV", state: "triage" }]) };
    const inner = fakeSandbox(output({ answer: { answers: [] } }));
    let answer: unknown = null;
    const sandbox = async (run: SandboxRun) => {
      run.onStarted?.("c1");
      const checks = join(run.runDir, "out", "checks");
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, "card-search-request.json"), JSON.stringify({ query: "csv export", repoPath: "/some/other/repo" }));
      for (let i = 0; i < 200 && !existsSync(join(checks, "card-search.json")); i++) await new Promise((r) => setTimeout(r, 10));
      answer = existsSync(join(checks, "card-search.json")) ? JSON.parse(readFileSync(join(checks, "card-search.json"), "utf8")) : null;
      return inner(run);
    };
    const d = { ...deps(sandbox), cards: cards as never, watchEvery: 5 };
    await runAgent(d, context("triage"), "question_council");
    expect(asked).toEqual([expect.objectContaining({ query: "csv export", repoPath: context("triage").task.repoPath })]);
    expect(answer).toMatchObject({ verdict: "ok", cards: [{ id: "c1" }] });
  });

  it("reads the v2.2 plan answer: steps become the slices Build reads (files are the touchpoints) and ride along with out of scope, migration and flags", async () => {
    const answer = {
      kind: "done", summary: "s", brief: "b", criteria: ["c1"], assumptions: [], rollback: "revert", outOfScope: ["refunds"], migration: "add a column", flags: ["f1"],
      steps: [{ description: "Cap a coupon", files: ["src/cart.ts", { path: "src/cap.ts", new: true }], done_when: ["c1 holds"], est_loc: 30 }],
    };
    const result = await runAgent(deps(fakeSandbox(output({ answer }))), { ...context("test_design"), runId: "r1-plan" }, "plan", {});
    expect(result.detail).toMatchObject({
      slices: [{ title: "Cap a coupon", est_loc: 30, touchpoints: ["src/cart.ts", "src/cap.ts"], acceptance: ["c1 holds"] }],
      steps: [{ description: "Cap a coupon", files: ["src/cart.ts", "src/cap.ts"], new_files: ["src/cap.ts"], done_when: ["c1 holds"] }],
      outOfScope: ["refunds"], migration: "add a column", flags: ["f1"],
    });
    // A v1 answer (slices only) has no steps, and its slices pass through.
    const v1 = await runAgent(deps(fakeSandbox(output({ answer: { kind: "done", summary: "s", slices: [{ title: "s1", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }] } }))), { ...context("test_design"), runId: "r1-plan" }, "plan", {});
    expect(v1.detail).toMatchObject({ slices: [{ title: "s1", touchpoints: ["a.ts"] }] });
    expect(v1.detail).not.toHaveProperty("steps");
    expect(v1.detail).not.toHaveProperty("migration");
  });

  it("stores the designer's v2 scenarios as cases (S ids, the criterion's text by its id, the round as version) and a v1 answer's cases as they are", async () => {
    const plan = { record: null, brief: "", criteria: ["A coupon applies once", "An expired coupon is refused"], assumptions: [], slices: [], round: 2 };
    const scenarios = [
      { criterion_ref: "C2", type: "failure", given: "an expired coupon", when: "it is applied", then: "the cart shows the expiry error", layer: "integration" },
      { criterion_ref: "C1", type: "happy", given: "a cart", when: "applied twice", then: "the discount counts once", data_needs: ["a coupon"], layer: "unit" },
    ];
    const result = await runAgent(deps(fakeSandbox(output({ answer: { kind: "done", summary: "s", scenarios } }))), { ...context("test_design"), runId: "r1-tests-2" }, "test_design", { plan });
    expect(result.detail?.cases).toEqual([
      expect.objectContaining({ id: "S1", title: "the cart shows the expiry error", criterion: "An expired coupon is refused", criterion_ref: "C2", type: "failure", layer: "integration", version: 2 }),
      expect.objectContaining({ id: "S2", title: "the discount counts once", criterion: "A coupon applies once", criterion_ref: "C1", data_needs: ["a coupon"], given: "a cart", when: "applied twice", then: "the discount counts once" }),
    ]);
    const v1 = [{ title: "t", criterion: "A coupon applies once", approach: "run it" }];
    const old = await runAgent(deps(fakeSandbox(output({ answer: { kind: "done", summary: "s", cases: v1 } }))), { ...context("test_design"), runId: "r1-tests-1" }, "test_design", { plan });
    expect(old.detail?.cases).toEqual(v1);
  });

  it("flattens and caps what the planner says it changed before it is stored on the gate: one line, no markup, no mention, no issue reference", async () => {
    const answer = { kind: "done", summary: "s", brief: "b", criteria: ["c"], slices: [{ title: "s", est_loc: 1, touchpoints: ["a.ts"], acceptance: ["c"] }], changed: `dropped x\n<img src=x> @everyone closes #12 [t](https://evil.example) ${"w".repeat(2000)}` };
    const result = await runAgent(deps(fakeSandbox(output({ answer }))), { ...context("test_design"), runId: "r1-plan" }, "plan", {});
    const changed = String(result.detail?.changed);
    expect(changed.length).toBeLessThanOrEqual(1000);
    expect(changed).not.toMatch(/\n|<img|@everyone|#12|\]\(/);
    expect(changed.startsWith("dropped x")).toBe(true);
  });

  it("runs the plan pack in the test_design state: its own pack and limits in the input, its own container, the plan under review in context", async () => {
    const plan = { record: null, brief: "b", criteria: ["c"], assumptions: [], slices: [], round: 2, gaps: ["c"] };
    const answer = { kind: "done", summary: "s", brief: "the brief", criteria: ["c1"], assumptions: ["a1"], slices: [{ title: "s1", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["ok"] }], rollback: "revert" };
    const result = await runAgent(deps(fakeSandbox(output({ answer }))), { ...context("test_design"), runId: "r1-plan" }, "plan", { plan });
    const input = seen!.input as unknown as StageInput;
    expect(input).toMatchObject({ stage: "test_design", pack: "plan", context: { plan }, plan: { brief: "b" } });
    expect(input.limits.maxTurns).toBe(30);
    expect(seen!.name).toMatch(/-plan-1$/);
    expect(seen!.runDir).toMatch(/runs\/r1-plan$/);
    expect(result.detail).toMatchObject({ brief: "the brief", criteria: ["c1"], assumptions: ["a1"], rollback: "revert", slices: [{ title: "s1" }] });
    expect(result.detail).not.toHaveProperty("outcome");
  });

  it("keeps the test cases test_design answered, for the test check", async () => {
    const cases = [{ title: "rejects a bad password", criterion: "works", approach: "run a.test.ts, confirm it rejects" }];
    const result = await runAgent(deps(fakeSandbox(output({ answer: { kind: "done", summary: "s", cases } }))), context("test_design"), "test_design");
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

  it("hands implementing the repo's checks from its luna.yaml", async () => {
    writeFileSync(join(repo, "luna.yaml"), "checks:\n  - name: board tests\n    run: cargo test\n    cwd: board\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "config");
    const run = runners(fakeSandbox(output()));
    await run.implementing!(context("implementing"));
    expect((seen!.input as unknown as StageInput).context.checks).toEqual([{ name: "board tests", run: "cargo test", cwd: "board" }]);
  });

  it("hands the run what the economy gives it, and nothing when there is none", async () => {
    const guard = { mode: "record" as const, judge: true, envelope: null, judgeConfidence: 0.8, redirects: 1, backstopMult: 1.5 };
    const asked: unknown[][] = [];
    const economy = { ...noEconomy(), inputFor: async (...args: unknown[]) => (asked.push(args), { guard }) };
    await runAgent({ ...deps(fakeSandbox(output())), economy }, context("implementing"), "implementing");
    expect((seen!.input as unknown as StageInput).context.economy).toEqual({ guard });
    expect(asked[0]![0]).toBe(repo);
    expect(asked[0]![1]).toBe("implementing");
    expect(asked[0]![2]).toMatchObject({ loop_guard: "on" });
    await runAgent({ ...deps(fakeSandbox(output())), economy: noEconomy() }, context("implementing"), "implementing");
    expect("economy" in (seen!.input as unknown as StageInput).context).toBe(false);
    await runAgent(deps(fakeSandbox(output())), context("implementing"), "implementing");
    expect("economy" in (seen!.input as unknown as StageInput).context).toBe(false);
  });

  it("starts the run without the economy's input when the economy fails", async () => {
    const economy = { ...noEconomy(), inputFor: async () => Promise.reject(new Error("disk")) };
    await runAgent({ ...deps(fakeSandbox(output())), economy }, context("implementing"), "implementing");
    expect("economy" in (seen!.input as unknown as StageInput).context).toBe(false);
  });

  describe("folding each container run into the economy", () => {
    const folding = () => {
      const folded: Array<Parameters<ReturnType<typeof noEconomy>["afterRun"]>[0]> = [];
      return { folded, economy: { ...noEconomy(), afterRun: async (run: (typeof folded)[number]) => void folded.push(run) } };
    };

    it("folds the run under its own pack and run folder, with the card, the runtime, the outcome and the tokens", async () => {
      const { folded, economy } = folding();
      const run = { runtime: "claude", engine: "claude:sonnet", modelId: "claude-sonnet-5-5", sdk: { name: "s", version: "1" }, fingerprint: "a".repeat(64) };
      const tokens = { input: 10, output: 2, cached: 5 };
      await runAgent({ ...deps(fakeSandbox(output({ run, usage: { turns: 7, costUsd: 0.5, durationMs: 100, model: "m", tokens } }))), economy }, { ...context("implementing"), runId: "run-fold-1" }, "code_map");
      expect(folded).toHaveLength(1);
      expect(folded[0]).toMatchObject({ repoPath: repo, runId: "run-fold-1", folder: "run-fold-1", pack: "code_map", cardId: "11111111-2222-3333-4444-555555555555", outcome: "pass", runtime: "claude", tokens: { input: 10, output: 2, cached: 5 } });
      expect(folded[0]!.fold).not.toBe(false);
    });

    it("keeps a record for a run that was aborted: no tokens, no fold", async () => {
      const { folded, economy } = folding();
      const sandbox = async (r: SandboxRun) => (mkdirSync(join(r.runDir, "out"), { recursive: true }), { exitCode: 137, timedOut: false, aborted: true, transcriptPath: join(r.runDir, "t.log") });
      await runAgent({ ...deps(sandbox), economy }, { ...context("implementing"), runId: "run-fold-2" }, "code_map");
      expect(folded).toHaveLength(1);
      expect(folded[0]).toMatchObject({ runId: "run-fold-2", pack: "code_map", outcome: "fail", tokens: null, fold: false });
    });

    it("records no run when no container started", async () => {
      const { folded, economy } = folding();
      const credentials: Credentials = { check: async () => ({ available: false, reason: "none" }), prepare: async () => Promise.reject(new NoCredentialError("none")) };
      const d = { ...deps(fakeSandbox(output())), economy, credentials };
      await runAgent(d, { ...context("implementing"), runId: "run-fold-3" }, "code_map");
      expect(folded).toEqual([]);
    });

    it("tells the containers that share one run folder apart, each folded on its own events", async () => {
      const { folded, economy } = folding();
      const seenEvents: string[] = [];
      const sandbox = (name: string) => async (r: SandboxRun) => {
        const result = await fakeSandbox(output())(r);
        writeFileSync(join(r.runDir, "out", "events.jsonl"), `${JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: name, payload: {} })}\n`);
        return result;
      };
      const folderEvents = (economyRun: (typeof folded)[number]) => economyRun.folder;
      const both = { ...economy, afterRun: async (run: (typeof folded)[number]) => (seenEvents.push(readFileSync(join(stateDir, "runs", run.folder!, "out", "events.jsonl"), "utf8")), economy.afterRun(run)) };
      const ctx = { ...context("implementing"), runId: "run-shared" };
      await runAgent({ ...deps(sandbox("first")), economy: both }, ctx, "build_tests");
      await runAgent({ ...deps(sandbox("second")), economy: both }, ctx, "build_tests");
      expect(folded.map((f) => f.runId)).toEqual(["run-shared", "run-shared#2"]);
      expect(folded.map(folderEvents)).toEqual(["run-shared", "run-shared"]);
      expect(seenEvents[0]).toContain("first");
      expect(seenEvents[1]).toContain("second");
    });
  });

  it("runs the repo's services from its luna.yaml beside the stage container", async () => {
    writeFileSync(join(repo, "luna.yaml"), "services:\n  postgres:\n    image: postgres:16\n    exports: { DATABASE_URL: x }\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "config");
    await runners(fakeSandbox(output())).implementing!(context("implementing"));
    expect(seen!.services).toEqual({ postgres: { image: "postgres:16", exports: { DATABASE_URL: "x" } } });
  });

  it("tells the pack where the branch forked, and hands ci_watch what the host fetched", async () => {
    const ci = { pr: null, checks: [{ name: "lint", state: "FAILURE", url: null }], logs: "boom" };
    await runAgent(deps(fakeSandbox(output())), context("ci_watch"), "ci_watch", { ci });
    const input = seen!.input as unknown as StageInput;
    expect(input.context.ci).toEqual(ci);
    expect(input.context.baseCommit).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("lets the caller name the base commit a pack reads its diff against (a fix round's verifying: only the delta)", async () => {
    const before = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "later.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    await runAgent(deps(fakeSandbox(output())), context("verifying"), "verifying", { baseCommit: before });
    expect((seen!.input as unknown as StageInput).context.baseCommit).toBe(before);
  });

  it("hands pr_reply the ship context the host built, and nothing for another pack", async () => {
    const ship = { kind: "comment" as const, comment: { thread: { id: "T1", path: null, line: null, comments: [] }, pack: { summary: "s", scenarios: [], howToVerify: "h" }, myReplies: 0 } };
    await runAgent(deps(fakeSandbox(output())), context("shipping"), "pr_reply", { ship });
    expect((seen!.input as unknown as StageInput).context.ship).toEqual(ship);
    await runAgent(deps(fakeSandbox(output())), context("ci_watch"), "ci_watch", { ship });
    expect((seen!.input as unknown as StageInput).context.ship).toBeUndefined();
  });

  it("keeps a finished answer that was also flagged rate-limited; only a run with no answer pauses", async () => {
    // The SDK's usage warning used to arrive with a complete brief; the answer is paid for.
    const finished = await runners(fakeSandbox(output({ rateLimited: true, resetsAt: "1793080800", answer: { kind: "brief", summary: "s" } }))).triage!(context("triage"));
    expect(finished.outcome).toBe("pass");
    expect(finished.rateLimited).toBeUndefined();
    expect(finished.detail).toMatchObject({ brief: "s", usageWindow: { resetsAt: "1793080800" } });

    const cut = await runners(fakeSandbox(output({ ok: false, outcome: "fail", rateLimited: true, resetsAt: "1793080800", error: "usage limit" }))).triage!(context("triage"));
    expect(cut).toMatchObject({ outcome: "fail", rateLimited: true });
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
          agent(r.worktree, "add", "-A");
          agent(r.worktree, "commit", "-q", "-m", "slice 1");
          made = agent(r.worktree, "rev-parse", "HEAD");
        },
      ),
    );
    const result = await run.implementing!(context("implementing"));
    expect(seen?.writable).toBe(true);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(made);
    expect(git(seen!.worktree, "log", "--format=%s")).toBe("slice 1\ninit");
  });

  it("runs the stage in the repository's own image, and records that image's id", async () => {
    let made = "";
    let seen: SandboxRun | undefined;
    const d = { ...deps(fakeSandbox(() => output({ commit: made }), (r) => {
      seen = r;
      writeFileSync(join(r.worktree, "pnpm-lock.yaml"), "lock\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      made = agent(r.worktree, "rev-parse", "HEAD");
    })), imageId: async (image: string) => `sha256:id-of-${image}`, repoImages: { ensure: async () => ({ image: "hardness-runner-shop:abc" }) } };
    const result = await agentRunners(d).implementing!(context("implementing"));
    expect(seen?.image).toBe("hardness-runner-shop:abc");
    expect((result.detail?.env as { image: string }).image).toBe("sha256:id-of-hardness-runner-shop:abc");
  });

  it("records the image the sandbox ran in, not the one the repository resolves to after the run", async () => {
    let made = "";
    let resolved = 0;
    const d = { ...deps(fakeSandbox(() => output({ commit: made }), (r) => {
      writeFileSync(join(r.worktree, "pnpm-lock.yaml"), "lock\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      made = agent(r.worktree, "rev-parse", "HEAD");
    })), imageId: async (image: string) => `sha256:id-of-${image}`, repoImages: { ensure: async () => ({ image: `hardness-runner-shop:${++resolved === 1 ? "A" : "B"}` }) } };
    const result = await agentRunners(d).implementing!(context("implementing"));
    expect((result.detail?.env as { image: string }).image).toBe("sha256:id-of-hardness-runner-shop:A");
    expect(resolved).toBe(1);
  });

  it("makes triage wait for the repository's graph, and escalates as an environment problem when it cannot be built", async () => {
    const sandbox = vi.fn();
    const failing = { ...deps(sandbox), graphReady: async () => ({ state: "failed" as const, reason: "exit code 1" }) };
    const result = await agentRunners(failing).triage!(context("triage"));
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "env_broken", envBroken: true, step: "graph" } });
    expect(sandbox).not.toHaveBeenCalled();
    const seen: boolean[] = [];
    const going = { ...deps(fakeSandbox(output())), graphReady: async (i: { skip: boolean }) => (seen.push(i.skip), { state: "ready" as const }) };
    await agentRunners(going).triage!(context("triage"));
    expect(seen).toEqual([false]);
  });

  it("escalates as an environment problem, with the reason, when the repository's image cannot be built", async () => {
    const sandbox = vi.fn();
    const d = { ...deps(sandbox), repoImages: { ensure: async () => { throw new RepoImageError("step 3 failed: no such package"); } } };
    const result = await agentRunners(d).implementing!(context("implementing"));
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true, reason: expect.stringContaining("no such package") });
    expect(sandbox).not.toHaveBeenCalled();
  });

  it("records the environment a passing Build ran in: the image id, the lockfiles at the head, the head, and their hash", async () => {
    let made = "";
    const d = { ...deps(fakeSandbox(() => output({ commit: made }), (r) => {
      writeFileSync(join(r.worktree, "pnpm-lock.yaml"), "lock\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      made = agent(r.worktree, "rev-parse", "HEAD");
    })), imageId: async (image: string) => `sha256:id-of-${image}` };
    const result = await agentRunners(d).implementing!(context("implementing"));
    expect(result.outcome).toBe("pass");
    const env = result.detail?.env as { hash: string; image: string; commit: string; lockfiles: Record<string, string> };
    expect(env).toMatchObject({ image: "sha256:id-of-img", commit: made });
    expect(Object.keys(env.lockfiles)).toEqual(["pnpm-lock.yaml"]);
    expect(env.hash).toBe(envHash(env));
  });

  it("records no environment for a Build that did not pass", async () => {
    const d = { ...deps(fakeSandbox(output({ outcome: "fail", ok: false } as never))), imageId: async () => "sha256:x" };
    const result = await agentRunners(d).implementing!(context("implementing"));
    expect(result.outcome).not.toBe("pass");
    expect(result.detail).not.toHaveProperty("env");
  });

  it("takes the run's commits in as a fast-forward of the card's branch in the machine's repository, whatever the agent's own repository says", async () => {
    let made = "";
    const run = runners(fakeSandbox(() => output({ commit: made }), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      made = agent(r.worktree, "rev-parse", "HEAD");
    }));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(made);
    expect(git(seen!.worktree, "rev-parse", "refs/heads/" + result.workspace!.branch)).toBe(made);
    // And the branch shows in the user's repository, written by the machine.
    expect(execFileSync("git", ["-C", repo, "rev-parse", result.workspace!.branch], { encoding: "utf8" }).trim()).toBe(made);
  });

  it("escalates head_moved, and takes nothing in, when the run's commits do not descend from the card's branch", async () => {
    const run = runners(fakeSandbox(output(), (r) => {
      // The machine moved the card's branch while the agent worked; the agent committed on the old tip.
      writeFileSync(join(r.worktree, "machine.txt"), "m\n");
      git(r.worktree, "add", "-A");
      git(r.worktree, "commit", "-q", "-m", "the machine's own");
      writeFileSync(join(r.worktree, "agent.txt"), "a\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "agent");
    }));
    const result = await run.implementing!(context("implementing"));
    expect(result).toMatchObject({ outcome: "escalated", detail: { escalation: "head_moved" } });
    expect(git(seen!.worktree, "log", "--format=%s", "-1")).toBe("the machine's own");
  });

  it("fails the run on a bundle it cannot read", async () => {
    const cut = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      mkdirSync(join(r.runDir, "out", "bundles"), { recursive: true });
      writeFileSync(join(r.runDir, "out", "bundles", "9.bundle"), "# v2 git bundle\nnot a bundle");
    }));
    const result = await cut.implementing!(context("implementing"));
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("could not be taken in") } });
  });

  it("fails the run, before any host git reads the folder, when the agent left a nested repository: it is removed by plain file removal and its filter never runs", async () => {
    const marker = join(root, "nested-filter-ran");
    const run = runners(fakeSandbox(output(), (r) => {
      const sub = join(r.worktree, "sub");
      mkdirSync(sub);
      execFileSync("git", ["init", "-q", sub]);
      writeFileSync(join(sub, "f.txt"), "f\n");
      writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
      execFileSync("git", ["config", "--file", join(sub, ".git", "config"), "filter.x.clean", `touch ${marker}; cat`]);
    }));
    const result = await run.implementing!(context("implementing"));
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("nested repository") } });
    expect(JSON.stringify(result.detail)).toContain("sub/.git");
    expect(existsSync(join(seen!.worktree, "sub", ".git"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails the run when the folder differs from the branch tip after the commits came in", async () => {
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice 1");
      // Left in the folder after the commit: not what the bundle carries.
      writeFileSync(join(r.worktree, "b.txt"), "changed after the commit\n");
    }));
    const result = await run.implementing!(context("implementing"));
    expect(result.outcome).toBe("fail");
    expect(JSON.stringify(result.detail)).toContain("uncommitted changes");
  });

  it("hands the latest verifying findings to implementing, keeping only confident ones", async () => {
    const f = (confidence: number, title: string) => ({
      path: "a.ts", line: 1, start_line: null, severity: "bug", title, body: "", suggestion_code: null, confidence,
    });
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "b.txt"), "b\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice");
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
      agent(cwd, "add", "-A");
      agent(cwd, "commit", "-q", "-m", msg);
      return agent(cwd, "rev-parse", "HEAD");
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
      expectLocked((cwd) => agent(cwd, "rm", "-q", "test/cart.test.js")));
    it("fails and undoes a commit that renamed an existing test", () =>
      expectLocked((cwd) => agent(cwd, "mv", "test/cart.test.js", "src-moved.js")));

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
        agent(r.worktree, "rm", "-q", "test/cart.test.js");
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
      const sandbox = fakeSandbox(output(), (r) => {
        writeFileSync(join(r.worktree, "test", "cart.test.js"), "new\n");
        commitIn(r.worktree);
      });
      const result = await runAgent(deps(sandbox), context("test_design"), "test_design");
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

  it("records the commit a writable pass ended on, and mounts a per-task session dir", async () => {
    const run = runners(fakeSandbox(output(), (r) => {
      writeFileSync(join(r.worktree, "a.txt"), "changed\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice");
    }));
    const ctx = context("implementing");
    const result = await run.implementing!(ctx);
    expect(result.outcome).toBe("pass");
    expect(result.run?.outputCommit).toBe(git(seen!.worktree, "rev-parse", "HEAD"));
    expect(result.run?.outputCommit).not.toBe(result.run?.inputCommit);
    expect(seen!.sessionMount).toBe(join(stateDir, "tasks", ctx.task.id, "session"));
    expect(existsSync(seen!.sessionMount!)).toBe(true);
  });

  it("gives the verifier no session folder of the card's, and no slice_list tool", async () => {
    await runAgent(deps(fakeSandbox(output())), context("verifying"), "verifying");
    expect(seen!.sessionMount).toBeUndefined();
    expect(PACKS.verifying.access.luna ?? []).not.toContain("slice_list");
  });

  it("runs the verifier on another family than the implementer's when that credential is there, and says so on the run", async () => {
    const started = vi.fn(async () => {});
    await runAgent(deps(fakeSandbox(output())), { ...context("verifying"), started }, "verifying");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex:sol" }));
  });

  it("caps the run's time at the minutes Build's budget has left, when that is smaller than its own limit", async () => {
    const run = runners(fakeSandbox(output()));
    await run.implementing!({ ...context("implementing"), budgetMinutes: 7 });
    expect((seen!.input as { limits: { timeoutMs: number } }).limits.timeoutMs).toBe(7 * 60_000);
    expect(seen!.timeoutMs).toBe(7 * 60_000);
    await run.implementing!({ ...context("implementing"), budgetMinutes: 1000 });
    expect((seen!.input as { limits: { timeoutMs: number } }).limits.timeoutMs).toBe(30 * 60_000);
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
    const run = runners(fakeSandbox(output({ answer: { kind: "brief", summary: "the brief", criteria: ["c1"] } })));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "the brief", criteria: ["c1"], outcome: "plan" });
    expect(result.detail).not.toHaveProperty("assumptions");
  });

  it("falls back to the summary and ticket criteria when triage has no answer", async () => {
    const run = runners(fakeSandbox(output()));
    const result = await run.triage!(context("triage"));
    expect(result.detail).toMatchObject({ brief: "did it", criteria: ["works"], outcome: "plan" });
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

describe("the engine a stage runs on", () => {
  /** Credentials that record what was prepared and released; `missing` engines are not configured. */
  function recordingCredentials(missing: string[] = []) {
    const log: string[] = [];
    const credentials: Credentials = {
      check: async (engine) => (missing.includes(engine) ? { available: false, reason: `no ${engine} here` } : { available: true }),
      prepare: async (engine) => {
        if (missing.includes(engine)) throw new NoCredentialError(`no ${engine} here`);
        log.push(`prepare ${engine}`);
        return { env: { [`KEY_FOR_${engine.replace(/\W/g, "_").toUpperCase()}`]: "v" }, mounts: [], release: async () => void log.push(`release ${engine}`) };
      },
    };
    return { credentials, log };
  }

  it("runs the pack's default, names it in the stage input, gives the sandbox only that engine's credential and releases it after", async () => {
    const { credentials, log } = recordingCredentials();
    const started = vi.fn(async () => {});
    const sandbox = fakeSandbox(output(), () => log.push("sandbox"));
    const result = await runAgent({ ...deps(sandbox), credentials }, { ...context("triage"), started }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(seen!.credential).toEqual({ env: { KEY_FOR_CLAUDE_OPUS: "v" }, mounts: [] });
    expect(log).toEqual(["prepare claude:opus", "sandbox", "release claude:opus"]);
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude:opus" }));
    expect(result.events?.map((e) => e.kind)).toEqual(["slice_committed"]);
  });

  it("releases the credential when a step between its preparation and the container throws, so the real token is not left on disk", async () => {
    const { credentials, log } = recordingCredentials();
    const sandbox = fakeSandbox(output(), () => log.push("sandbox"));
    const d: AgentDeps = { ...deps(sandbox), credentials, egress: { for: async () => { throw new Error("policy broke"); } } };
    await expect(runAgent(d, context("triage"), "triage")).rejects.toThrow("policy broke");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
  });

  it("never runs an engine the pack does not allow: the task's override is passed over and the reason logged", async () => {
    const { credentials, log } = recordingCredentials();
    const task = { ...context("triage").task, stages: { triage: "openai:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toEqual({
      pack: "triage",
      engine: "claude:opus",
      reason: expect.stringMatching(/^the task's openai:sol is not allowed for triage/),
    });
  });

  describe("an effort the runner image may not honour", () => {
    const runInfo = (effort?: string) => ({ runtime: "claude", engine: "claude:opus", modelId: "m", ...(effort ? { effort } : {}), sdk: { name: "s", version: "1" }, fingerprint: "a".repeat(64) }) as StageOutput["run"];
    const asked = () => writeFileSync(join(repo, "luna.yaml"), "effort:\n  triage: low\n");

    it("says on the task, and in the run's events, when the result ran at another effort than the input set", async () => {
      asked();
      const note = vi.fn(async (_text: string) => {});
      const result = await runAgent(deps(fakeSandbox(output({ run: runInfo("high") }))), { ...context("triage"), note }, "triage");
      expect((seen!.input as unknown as StageInput).effort).toBe("low");
      const reason = "triage was asked to run at low effort and ran at high: the runner image may be older than this build (pnpm images)";
      expect(note).toHaveBeenCalledWith(reason);
      expect(result.events?.find((e) => e.kind === "engine")?.payload).toEqual({ pack: "triage", engine: "claude:opus", reason });
    });

    it("says so when the result reports no effort at all (an old image strips the key)", async () => {
      asked();
      const note = vi.fn(async (_text: string) => {});
      await runAgent(deps(fakeSandbox(output({ run: runInfo() }))), { ...context("triage"), note }, "triage");
      expect(note).toHaveBeenCalledWith("triage was asked to run at low effort and reported none: the runner image may be older than this build (pnpm images)");
    });

    it("says nothing on a re-attached run: its container started with the input of before the restart, not the luna.yaml of now", async () => {
      asked();
      const note = vi.fn(async (_text: string) => {});
      const result = await runAgent(deps(fakeSandbox(output({ run: runInfo("high") }))), { ...context("triage"), note, resume: { container: "hardness-abcd1234-triage-1", inputCommit: null, engine: "claude:opus" } }, "triage");
      expect(note).not.toHaveBeenCalled();
      expect(result.events?.find((e) => e.kind === "engine")).toBeUndefined();
    });

    it("says nothing when the result ran at the effort asked for, or no effort was set", async () => {
      asked();
      const note = vi.fn(async (_text: string) => {});
      const same = await runAgent(deps(fakeSandbox(output({ run: runInfo("low") }))), { ...context("triage"), note }, "triage");
      expect(same.events?.find((e) => e.kind === "engine")).toBeUndefined();
      writeFileSync(join(repo, "luna.yaml"), "policy:\n  graph: off\n");
      await runAgent(deps(fakeSandbox(output({ run: runInfo("high") }))), { ...context("triage"), note }, "triage");
      expect(note).not.toHaveBeenCalled();
    });
  });

  it("runs the engine a re-attached run started on, whatever the task or luna.yaml say now", async () => {
    const { credentials } = recordingCredentials();
    const resume = { container: "hardness-x", inputCommit: null, engine: "claude:opus" as const };
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), resume }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
  });

  it("runs the fallback engine the machine hands it, over the task's pick, and gives the sandbox that engine's credential", async () => {
    const { credentials, log } = recordingCredentials();
    const started = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, started, engine: "claude:opus" }, "triage");
    expect((seen!.input as unknown as StageInput).engine).toBe("claude:opus");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude:opus" }));
    expect(log).toContain("prepare claude:opus");
    // The machine logs the fallback itself; the runner adds no engine event of its own.
    expect(result.events?.find((e) => e.kind === "engine")).toBeUndefined();
  });

  it("says on the task's activity when the engine asked for gave way to the default for want of its credential", async () => {
    const { credentials, log } = recordingCredentials(["codex:sol"]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith("triage ran on claude:opus: codex:sol has no Codex login on this machine");
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toMatchObject({ engine: "claude:opus", reason: expect.stringMatching(/^codex:sol has no credential/) });
  });

  it("refuses a handed engine that cannot read images for a pack that needs them, before any container starts (RFC 0013)", async () => {
    seen = undefined;
    const { credentials, log } = recordingCredentials();
    await expect(runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("e2e"), engine: "openai:sol" }, "design_parity")).rejects.toThrow("openai:sol cannot read images, which design_parity needs: refused before the container started");
    expect(seen).toBeUndefined();
    expect(log).toEqual([]);
  });

  it("runs the default and says so on the task when the engine asked for is on a runtime MACHINE_DISABLE_RUNTIMES turned off", async () => {
    const { credentials: inner, log } = recordingCredentials();
    const credentials = gatedCredentials(inner, [runtimeKillSwitch(["eve"])]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith("triage ran on claude:opus: codex:sol is disabled by MACHINE_DISABLE_RUNTIMES");
    expect(result.events?.find((e) => e.kind === "engine")?.payload).toMatchObject({ engine: "claude:opus", reason: "codex:sol is disabled by MACHINE_DISABLE_RUNTIMES; ran claude:opus, the pack's default" });
  });

  it("runs the default and says so on the task when the engine asked for is at its monthly cap in the task's repo", async () => {
    const { credentials: inner, log } = recordingCredentials();
    const spend = { engineSpendSinceUsd: async (_since: Date, repo?: string) => new Map(repo ? [["codex:sol", 11]] : []) };
    const credentials = gatedCredentials(inner, [engineBudgetGate({ budgets: {}, repoBudgets: async () => ({ codex: 10 }), spend })]);
    const note = vi.fn(async () => {});
    const task = { ...context("triage").task, stages: { triage: "codex:sol" } } as TaskRow;
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/^triage ran on claude:opus: codex:sol is over its monthly budget \(\$11\.00 of \$10\.00 on codex in .+\)$/));
  });

  it("puts no note on the task when the engine asked for runs, or a disallowed one is passed over", async () => {
    const { credentials } = recordingCredentials();
    const note = vi.fn(async () => {});
    for (const engine of ["codex:sol", "openai:sol"]) {
      const task = { ...context("triage").task, stages: { triage: engine } } as TaskRow;
      await runAgent({ ...deps(fakeSandbox(output())), credentials }, { ...context("triage"), task, note }, "triage");
    }
    expect(note).not.toHaveBeenCalled();
  });

  it("fails the stage with the reason when this machine has no credential for its engine, and starts no container", async () => {
    const { credentials } = recordingCredentials(["claude:opus"]);
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, context("triage"), "triage");
    expect(seen).toBeUndefined();
    expect(result).toMatchObject({ outcome: "fail", detail: { error: "no claude:opus here" } });
  });

  it("waits for a credential another run holds within the stage's own timeout, and says so on the task", async () => {
    const waits: unknown[] = [];
    const credentials: Credentials = {
      check: async () => ({ available: true }),
      prepare: async (_engine, _runDir, wait) => {
        waits.push({ timeoutMs: wait?.timeoutMs, signal: wait?.signal });
        wait?.onWait?.("waiting for the Codex login: another Codex run on this machine is using it");
        return { env: {}, mounts: [], release: async () => {} };
      },
    };
    const note = vi.fn(async () => {});
    const ctx = { ...context("triage"), note };
    await runAgent({ ...deps(fakeSandbox(output())), credentials }, ctx, "triage");
    expect(waits).toEqual([{ timeoutMs: (seen!.input as unknown as StageInput).limits.timeoutMs, signal: ctx.signal }]);
    expect(note).toHaveBeenCalledWith("waiting for the Codex login: another Codex run on this machine is using it");
  });

  it("fails the stage with the reason when it could not get the credential in time, and starts no container", async () => {
    const credentials: Credentials = {
      check: async () => ({ available: true }),
      prepare: async () => {
        throw new CredentialWaitError("waited 60 min for the Codex login, which another Codex run on this machine held past this stage's timeout");
      },
    };
    const result = await runAgent({ ...deps(fakeSandbox(output())), credentials }, context("triage"), "triage");
    expect(seen).toBeUndefined();
    expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringMatching(/^waited 60 min for the Codex login/) } });
  });

  it("gives a verifying stage on Codex the Claude token its second opinion needs beside its own engine's, and releases both", async () => {
    const { credentials, log } = recordingCredentials();
    await runAgent({ ...deps(fakeSandbox(output(), () => log.push("sandbox"))), credentials }, context("verifying"), "verifying");
    // The verifier is on Codex, so its second opinion is Claude's (D9): both credentials.
    expect(seen!.credential).toEqual({ env: { KEY_FOR_CODEX_SOL: "v", KEY_FOR_CLAUDE_OPUS: "v" }, mounts: [] });
    expect(log).toEqual(["prepare codex:sol", "prepare claude:opus", "sandbox", "release codex:sol", "release claude:opus"]);
  });

  it("releases the credential when the sandbox throws", async () => {
    const { credentials, log } = recordingCredentials();
    const broken = async () => {
      throw new Error("docker: not running");
    };
    await expect(runAgent({ ...deps(broken), credentials }, context("triage"), "triage")).rejects.toThrow(/docker/);
    expect(log).toEqual(["prepare claude:opus", "release claude:opus"]);
  });

  describe("scope after the run", () => {
    const slice = { title: "s", est_loc: 5, touchpoints: ["b.txt"], acceptance: ["ok"] };
    const planned = (): StageContext => ({
      ...context("implementing"),
      approvals: [{ id: "ap1", kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: [], assumptions: [], slices: [slice] } } as unknown as StageContext["approvals"][number]],
    });
    const commitFiles = (...names: string[]) => (r: SandboxRun) => {
      for (const name of names) writeFileSync(join(r.worktree, name), "x\n");
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice");
    };
    const graphWith = (misses: unknown[]): Graph => ({
      stampOf: async () => null,
      currentDir: () => null,
      build: async () => ({}) as GraphStamp,
      isFresh: async () => true,
      recordMisses: async (_repo, miss) => void misses.push(miss),
      locate: async () => null,
      impact: async () => null,
      owners: async () => null,
    });

    const commitContent = (files: Record<string, string>) => (r: SandboxRun) => {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(r.worktree, name), text);
      agent(r.worktree, "add", "-A");
      agent(r.worktree, "commit", "-q", "-m", "slice");
    };

    it("fails the stage on a test switched off in place (a blocker), marks the run as a scope red and lists the issue with its severity", async () => {
      const result = await runners(fakeSandbox(output(), commitContent({ "b.txt": "it.skip('x', () => {})\n" }))).implementing!(planned());
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ scopeRed: true, scope: { issues: [expect.objectContaining({ severity: "blocker", kind: "switched_off_test" })] } });
      expect(result.findings).toEqual([expect.objectContaining({ severity: "scope", title: expect.stringMatching(/switched off/) })]);
    });

    it("puts no token from an added line on the error, the findings or the issues: fixed words and the path only", async () => {
      const token = ["ghp", "b".repeat(36)].join("_");
      const result = await runners(fakeSandbox(output(), commitContent({ "b.txt": `it.skip("x", () => { const k = "${token}" })\n` }))).implementing!(planned());
      expect(result.outcome).toBe("fail");
      expect(JSON.stringify(result.detail)).not.toContain(token);
      expect(JSON.stringify(result.findings)).not.toContain(token);
      expect(result.detail?.error).toMatch(/switched off.*b\.txt/);
    });

    it("passes with a dependency the plan did not name (should_fix) and a TODO (nit): they ride along as findings and do not fail the stage", async () => {
      const answer = { kind: "done", summary: "x", outOfMap: [{ path: "package.json", reason: "the export needs it" }] };
      const files = { "b.txt": "// TODO later\n", "package.json": '{\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n' };
      const result = await runners(fakeSandbox(output({ answer } as Partial<StageOutput>), commitContent(files))).implementing!(planned());
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ scope: { issues: expect.arrayContaining([expect.objectContaining({ severity: "should_fix", kind: "new_dependency" }), expect.objectContaining({ severity: "nit", kind: "todo" })]) } });
      expect(result.detail).not.toHaveProperty("scopeRed");
      expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "should_fix" }), expect.objectContaining({ severity: "nit" })]));
    });

    it("computes the scope over the card's whole change on the feature route: a fix run that changes nothing still sees the undeclared file the first run committed", async () => {
      const first = await runners(fakeSandbox(output(), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      expect(first).toMatchObject({ outcome: "fail", detail: { scopeRed: true } });
      const again = { ...planned(), runId: "run-2", attempt: 2, firstInputCommit: first.run!.inputCommit!, task: { ...planned().task, branch: first.workspace!.branch, worktreePath: first.workspace!.worktreePath } } as StageContext;
      const second = await runners(fakeSandbox(output(), () => {})).implementing!(again);
      expect(second).toMatchObject({ outcome: "fail", detail: { scopeRed: true, scope: { facts: { undeclared: ["extra.txt"] } } } });
    });

    it("never measures the scope from a ref or from a later run's own commit: with no tests commit and no recorded first input commit, a second run fails closed", async () => {
      const first = await runners(fakeSandbox(output(), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      const again = { ...planned(), runId: "run-2", attempt: 2, task: { ...planned().task, branch: first.workspace!.branch, worktreePath: first.workspace!.worktreePath } } as StageContext;
      const second = await runners(fakeSandbox(output(), () => {})).implementing!(again);
      expect(second).toMatchObject({ outcome: "escalated", detail: { envBroken: true, reason: expect.stringMatching(/scope/i) } });
    });

    it("keeps the run's own commit as the scope's base on a route with no plan (the PR routes)", async () => {
      const first = await runners(fakeSandbox(output(), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      const noPlan = { ...context("implementing"), runId: "run-2", task: { ...context("implementing").task, branch: first.workspace!.branch, worktreePath: first.workspace!.worktreePath } } as StageContext;
      const second = await runners(fakeSandbox(output(), () => {})).implementing!(noPlan);
      expect(second.detail).not.toHaveProperty("scopeRed");
    });

    it("fails closed when the scope facts cannot be computed: an escalation as an environment problem, not a pass with a note", async () => {
      const d = { ...deps(fakeSandbox(output(), commitFiles("b.txt"))), scopeGit: { nameStatus: async () => { throw new Error("git is gone"); }, diff: async () => "" } };
      const result = await agentRunners(d).implementing!(planned());
      expect(result).toMatchObject({ outcome: "escalated", detail: { envBroken: true, reason: expect.stringMatching(/scope.*git is gone/i) } });
    });

    it("fails the stage on a changed file the plan does not name and the answer does not declare, one finding per file", async () => {
      const result = await runners(fakeSandbox(output(), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      expect(result.outcome).toBe("fail");
      expect(result.detail).toMatchObject({ error: expect.stringContaining("extra.txt"), scope: { facts: { undeclared: ["extra.txt"] } } });
      expect(result.findings).toEqual([expect.objectContaining({ path: "extra.txt", severity: "scope", confidence: 1 })]);
    });

    it("stores the Diff Summary: the agent's words, and git's files over its own list (a changed file it left out is added with no reason)", async () => {
      const answer = { kind: "done", summary: "x", diffSummary: { what: "Adds b", why: "C1", files: [{ path: "b.txt", reason: "the feature" }] }, outOfMap: [{ path: "extra.txt", reason: "shared helper" }] };
      const result = await runners(fakeSandbox(output({ answer } as Partial<StageOutput>), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ diffSummary: { what: "Adds b", why: "C1", files: [{ path: "b.txt", reason: "the feature" }, { path: "extra.txt", reason: null }] } });
    });

    it("records the branch the card was cut from (the repo's default branch) for the Build Report", async () => {
      const result = await runners(fakeSandbox(output(), commitFiles("b.txt"))).implementing!(planned());
      expect(result.detail).toMatchObject({ base: expect.stringMatching(/^(main|master)$/) });
    });

    describe("a stacked card", () => {
      const PARENT = "task/aaaaaaaa-parent";
      /** The repository gets an origin with the parent's branch (two commits) pushed there and forgotten locally. */
      const withParent = (): string => {
        const remote = join(root, "remote.git");
        execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
        git(repo, "remote", "add", "origin", remote);
        git(repo, "push", "-q", "origin", "main");
        git(repo, "fetch", "-q", "origin");
        git(repo, "remote", "set-head", "origin", "main");
        git(repo, "checkout", "-q", "-b", PARENT);
        for (const n of [1, 2]) {
          writeFileSync(join(repo, `p${n}.txt`), "p\n");
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", `parent ${n}`);
        }
        const tip = git(repo, "rev-parse", "HEAD");
        git(repo, "push", "-q", "origin", PARENT);
        git(repo, "checkout", "-q", "main");
        git(repo, "branch", "-q", "-D", PARENT);
        git(repo, "update-ref", "-d", `refs/remotes/origin/${PARENT}`);
        return tip;
      };

      it("cuts a new workspace from the parent's tip when the rule says open, and the Build Report's base is the parent's branch", async () => {
        const tip = withParent();
        const baseFor = vi.fn(async () => ({ state: "open" as const, branch: PARENT }));
        const result = await agentRunners({ ...deps(fakeSandbox(output(), commitFiles("b.txt"))), baseFor }).implementing!(planned());
        expect(baseFor).toHaveBeenCalledTimes(1);
        expect(result.outcome).toBe("pass");
        expect(git(seen!.worktree, "log", "--format=%s", "-n", "2")).toBe("slice\nparent 2");
        expect(git(seen!.worktree, "rev-parse", "refs/luna/base")).toBe(tip);
        expect(result.detail).toMatchObject({ base: PARENT });
      });

      it("cuts from the default branch and clears the card's base when the parent merged meanwhile", async () => {
        withParent();
        const clearBase = vi.fn(async () => {});
        const result = await agentRunners({ ...deps(fakeSandbox(output(), commitFiles("b.txt"))), baseFor: async () => ({ state: "merged" as const }), clearBase }).implementing!(planned());
        expect(result.outcome).toBe("pass");
        expect(clearBase).toHaveBeenCalledWith(planned().task.id);
        expect(() => git(seen!.worktree, "rev-parse", "--verify", "--quiet", "refs/luna/base")).toThrow();
        expect(result.detail).toMatchObject({ base: expect.stringMatching(/^(main|master)$/) });
        expect(git(seen!.worktree, "log", "--format=%s", "-n", "2")).toBe("slice\ninit");
      });

      it("fails the run with the reason, and makes no workspace, when the parent was archived", async () => {
        withParent();
        const sandbox = vi.fn(fakeSandbox(output()));
        const result = await agentRunners({ ...deps(sandbox), baseFor: async () => ({ state: "gone" as const, reason: "the card this one is stacked on was archived (rejected)" }) }).implementing!(planned());
        expect(result).toMatchObject({ outcome: "fail", detail: { error: "the card this one is stacked on was archived (rejected)" } });
        expect(sandbox).not.toHaveBeenCalled();
      });

      it("holds the card with a reason, and makes no workspace, when the parent's branch is missing on origin", async () => {
        withParent();
        const sandbox = vi.fn(fakeSandbox(output()));
        const result = await agentRunners({ ...deps(sandbox), baseFor: async () => ({ state: "open" as const, branch: "task/zzzzzzzz-gone" }) }).implementing!(planned());
        expect(result).toMatchObject({ outcome: "fail", detail: { error: expect.stringContaining("task/zzzzzzzz-gone") } });
        expect(sandbox).not.toHaveBeenCalled();
        expect(existsSync(machineGitDir(join(root, "worktrees", "repo", "task-11111111-fix-it")))).toBe(false);
      });

      it("never asks once the workspace exists, and a card with no base is not asked about at all", async () => {
        withParent();
        const baseFor = vi.fn(async () => null);
        const first = await agentRunners({ ...deps(fakeSandbox(output(), commitFiles("b.txt"))), baseFor }).implementing!(planned());
        expect(first.detail).toMatchObject({ base: expect.stringMatching(/^(main|master)$/) });
        const again = { ...planned(), runId: "run-2", attempt: 2, task: { ...planned().task, branch: first.workspace!.branch, worktreePath: first.workspace!.worktreePath } } as StageContext;
        baseFor.mockClear();
        await agentRunners({ ...deps(fakeSandbox(output(), () => {})), baseFor }).implementing!(again);
        expect(baseFor).not.toHaveBeenCalled();
      });
    });

    it("reads a plain string diffSummary, as an older answer gave it, as `what`", async () => {
      const answer = { kind: "done", summary: "x", diffSummary: "Adds b", outOfMap: [{ path: "extra.txt", reason: "shared helper" }] };
      const result = await runners(fakeSandbox(output({ answer } as Partial<StageOutput>), commitFiles("b.txt", "extra.txt"))).implementing!(planned());
      expect(result.detail).toMatchObject({ diffSummary: { what: "Adds b" } });
    });

    it("passes when the file is declared, records it as a graph miss, and reports the scope", async () => {
      const misses: unknown[] = [];
      const answer = { kind: "done", summary: "x", outOfMap: [{ path: "extra.txt", reason: "shared helper" }] };
      const d = { ...deps(fakeSandbox(output({ answer } as Partial<StageOutput>), commitFiles("b.txt", "extra.txt"))), graph: graphWith(misses) };
      const result = await agentRunners(d).implementing!(planned());
      expect(result.outcome).toBe("pass");
      expect(result.detail).toMatchObject({ scope: { facts: { undeclared: [] }, verdict: "skipped" } });
      expect(misses).toEqual([{ task: "11111111-2222-3333-4444-555555555555", at: expect.any(String), files: ["extra.txt"] }]);
    });

    it("does not judge a task with no plan (a PR task): nothing is undeclared", async () => {
      const result = await runners(fakeSandbox(output(), commitFiles("extra.txt"))).implementing!(context("implementing"));
      expect(result.outcome).toBe("pass");
    });
  });

  describe("build watch", () => {
    const ledgerJson = JSON.stringify({ schema: 1, slices: [{ id: 1, title: "one", status: "committed", commit: "abc" }] });
    const killed = (run: SandboxRun) => {
      mkdirSync(join(run.runDir, "out"), { recursive: true });
      writeFileSync(join(run.runDir, "out", "ledger.json"), ledgerJson);
    };
    const aborting = (run: SandboxRun): Promise<SandboxResult> => {
      killed(run);
      return Promise.resolve({ exitCode: 137, timedOut: false, aborted: true, transcriptPath: join(run.runDir, "t.log") });
    };

    it("keeps the ledger of an aborted run and has pushed the committed slice once", async () => {
      const calls: string[][] = [];
      const pushOptions: Array<{ timeoutMs?: number; signal?: AbortSignal } | undefined> = [];
      const hostExec = vi.fn(async (cmd: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number }) => {
        calls.push([cmd, ...args]);
        if (args.includes("push")) pushOptions.push(options);
        return { code: 0, stdout: "", stderr: "" };
      });
      const result = await runAgent({ ...deps(aborting), hostExec, watchEvery: 5 }, context("implementing"), "implementing");
      expect((result.detail as { ledger: { slices: Array<{ status: string }> } }).ledger.slices[0]!.status).toBe("committed");
      const pushes = calls.filter((c) => c.includes("push"));
      expect(pushes).toHaveLength(1);
      const lead = 1 + HOST_GIT.length;
      expect(pushes[0]!.slice(0, lead + 1)).toEqual(["git", ...HOST_GIT, "-C"]);
      // A checkpoint goes to a ref that triggers no CI and is nobody's PR head; Deliver updates the branch itself.
      expect(pushes[0]![lead + 2]).toMatch(/^--git-dir=/);
      expect(pushes[0]![lead + 3]).toMatch(/^--work-tree=/);
      expect(pushes[0]!.slice(lead + 4)).toEqual(["push", "--force", "origin", expect.stringMatching(/^HEAD:refs\/luna\/wip\/task\//)]);
      expect(pushOptions[0]?.timeoutMs).toBeGreaterThan(0);
      expect(pushOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("pushes once per tip: two slices committed on the same HEAD make one push", async () => {
      const pushed: string[][] = [];
      const hostExec = vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes("push")) pushed.push(args);
        return { code: 0, stdout: "", stderr: "" };
      });
      const twoOnOneTip = (run: SandboxRun) => {
        mkdirSync(join(run.runDir, "out"), { recursive: true });
        writeFileSync(join(run.runDir, "out", "ledger.json"), JSON.stringify({ schema: 1, slices: [1, 2].map((id) => ({ id, title: `s${id}`, status: "committed", commit: "same" })) }));
      };
      const result = await runAgent({ ...deps(fakeSandbox(output(), twoOnOneTip)), hostExec, watchEvery: 5 }, context("implementing"), "implementing");
      expect(result.outcome).toBe("pass");
      expect(pushed).toHaveLength(1);
    });

    it("never fails the stage on a failed push, and counts it", async () => {
      const hostExec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "no remote" }));
      const sandbox = fakeSandbox(output(), killed);
      const result = await runAgent({ ...deps(sandbox), hostExec, watchEvery: 5, pushSleep: async () => {} }, context("implementing"), "implementing");
      expect(result.outcome).toBe("pass");
      expect((result.detail as { pushes: unknown }).pushes).toEqual({ attempted: 1, ok: 0 });
      // The first try and one retry after each of 1 s, 5 s and 25 s.
      expect(hostExec).toHaveBeenCalledTimes(4);
    });
  });
});

describe("a stage's own list of hosts", () => {
  const spec = { allow: ["github.com:443"], allowPrivate: [], proxyImage: "img" };
  const withEgress = (sandbox: ReturnType<typeof fakeSandbox>) => {
    const requests: unknown[] = [];
    const d: AgentDeps = { ...deps(sandbox), egress: { for: async (request) => (requests.push(request), spec) } };
    return { d, requests };
  };

  it("asks for the pack's network: engine as `pack`, github as `github`, full as `agent`, with its engine's owner, and hands the list to the sandbox", async () => {
    for (const [pack, kind] of [["reviewing", "pack"], ["triage", "github"], ["implementing", "agent"]] as const) {
      const { d, requests } = withEgress(fakeSandbox(output()));
      await runAgent(d, context(pack), pack);
      expect(requests, pack).toEqual([expect.objectContaining({ repoPath: repo, kind, owners: expect.arrayContaining(["claude"]), targets: [] })]);
      expect(seen?.egress).toEqual(spec);
    }
  });

  it("gives a browser run the host of the one QA target it is given", async () => {
    writeFileSync(join(repo, "luna.yaml"), "qa_targets:\n  - name: staging\n    url: https://staging.example.com\n  - name: local\n    url: http://127.0.0.1:3000\n");
    const { d, requests } = withEgress(fakeSandbox(output()));
    await runAgent(d, context("e2e"), "e2e");
    expect((requests[0] as { targets: string[] }).targets).toEqual(["staging.example.com:443"]); // the one target the machine chose: the first declared
  });

  it("runs as before without a policy", async () => {
    await runAgent(deps(fakeSandbox(output())), context("triage"), "triage");
    expect(seen?.egress).toBeUndefined();
  });

  it("emits one row per refused (host, port, via), at most 20 and then one `more`, never from the container", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ host: `h${i}.example.com`, port: 443, via: "connect" as const, reason: "not_listed", count: 1 }));
    const inner = fakeSandbox(output());
    const { d } = withEgress(async (run) => ({ ...(await inner(run)), blocked: rows }));
    const emitted: Array<[string, Record<string, unknown>]> = [];
    await runAgent(d, { ...context("triage"), emit: async (kind, payload) => void emitted.push([kind, payload]) }, "triage");
    const blocked = emitted.filter(([k]) => k === "sandbox.egress_blocked");
    expect(blocked).toHaveLength(21);
    expect(blocked[0]![1]).toEqual({ step: "stage", host: "h0.example.com", port: 443, via: "connect", reason: "not_listed", count: 1 });
    expect(blocked[20]![1]).toEqual({ step: "stage", more: 5 });
  });

  it("ends the stage as env_broken at step network when the daemon cannot make the isolated network", async () => {
    const { d } = withEgress(async () => {
      throw new EgressUnsupportedError("old daemon");
    });
    const result = await runAgent(d, context("triage"), "triage");
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "network", reason: expect.stringContaining("Docker Engine 28"), options: expect.any(Array) });
  });
});

describe("sandbox environment errors on the agent path", () => {
  it("escalates env_broken at step seccomp when the daemon has no seccomp filter", async () => {
    const d = deps(async () => {
      throw new SeccompUnavailableError("no seccomp");
    });
    const result = await runAgent(d, context("triage"), "triage");
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "seccomp" });
  });

  it("escalates env_broken at step runtime when the install step finds no runtime, on a writable stage", async () => {
    const d: AgentDeps = { ...deps(fakeSandbox(output())), install: async () => { throw new RuntimeUnavailableError("no runsc"); } };
    const result = await runAgent(d, context("implementing"), "implementing");
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "runtime" });
  });
});

describe("the machine's install before a writable stage", () => {
  const outcome = { ok: true as const, ran: ["pnpm install --frozen-lockfile --ignore-scripts"], notes: ["restored tracked files the install changed (package.json)"], blocked: [{ host: "x.example.com", port: 443, via: "connect" as const, reason: "not_listed", count: 1 }] };

  it("installs after the workspace is made and before the container, for implementing, with the card's commit, and not for a read-only pack", async () => {
    const order: string[] = [];
    const inner = fakeSandbox(output());
    const calls: Array<Record<string, unknown>> = [];
    const d: AgentDeps = { ...deps(async (run) => (order.push("sandbox"), inner(run))), install: async (input) => (order.push("install"), calls.push(input as never), outcome) };
    const notes: string[] = [];
    const emitted: string[] = [];
    await runAgent(d, { ...context("implementing"), note: async (t) => void notes.push(t), emit: async (k, p) => void emitted.push(`${k}:${p.step}`) }, "implementing");
    expect(order).toEqual(["install", "sandbox"]);
    expect(calls[0]).toMatchObject({ taskId: "11111111-2222-3333-4444-555555555555", repoPath: repo });
    expect(String(calls[0]!.commit)).toMatch(/^[0-9a-f]{40}$/);
    expect(String(calls[0]!.workspace)).toContain(join(root, "worktrees"));
    expect(notes.join(" ")).toContain("restored tracked files");
    expect(emitted).toContain("sandbox.egress_blocked:install");
    order.length = 0;
    await runAgent(d, context("triage"), "triage");
    expect(order).toEqual(["sandbox"]);
  });

  it("ends the stage as env_broken at step install, with the step's detail, and starts no container, when the install fails", async () => {
    let started = false;
    const d: AgentDeps = { ...deps(async (run) => ((started = true), fakeSandbox(output())(run))), install: async () => ({ ok: false, blocked: [], detail: { escalation: "env_broken", envBroken: true, step: "install", tool: "pnpm", lockfile: "pnpm-lock.yaml", reason: "x", logTail: "boom", options: [] } }) };
    const result = await runAgent(d, context("implementing"), "implementing");
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", step: "install", tool: "pnpm", logTail: "boom" });
    expect(started).toBe(false);
  });
});

describe("scoped secrets and the agent stages", () => {
  const secret = ["qa", "pw", "z".repeat(10)].join("-");
  const store = (missing: string[] = []): SecretStore & { loads: Array<[string, string[]]> } => {
    const loads: Array<[string, string[]]> = [];
    return { loads, folder: () => "/home/me/.config/hardness/secrets/repo-1", load: async (r, names) => (loads.push([r, [...names]]), { values: Object.fromEntries(names.filter((n) => !missing.includes(n)).map((n) => [n, secret])), missing: missing.filter((m) => names.includes(m)).map((name) => ({ name, reason: "there is no such file" })) }) };
  };
  const withTarget = () => writeFileSync(join(repo, "luna.yaml"), "qa_targets:\n  - name: staging\n    url: https://staging.example.com\n    credential: env:QA_PASSWORD\nchecks:\n  - name: db\n    run: make db\n    secrets: [DB_URL]\n");

  it("gives the browser run the credential its QA target names, by value only to the container, and implementing none even when a check declares one", async () => {
    withTarget();
    const s = store();
    const d: AgentDeps = { ...deps(fakeSandbox(output())), secrets: s };
    await runAgent(d, context("e2e"), "e2e");
    expect(seen?.secrets).toEqual({ QA_PASSWORD: secret });
    // the names only, so the fill helper knows which variable is the QA login and never the engine's own key
    expect(seen?.extraEnv?.LUNA_QA_CREDENTIALS).toBe("QA_PASSWORD");
    expect(JSON.stringify(seen?.input)).not.toContain(secret);
    await runAgent(d, context("implementing"), "implementing");
    expect(seen?.secrets).toBeUndefined();
    expect(seen?.extraEnv?.LUNA_QA_CREDENTIALS).toBeUndefined();
    await runAgent(d, context("triage"), "triage");
    expect(seen?.secrets).toBeUndefined();
  });

  it("ends the stage as env_broken at step secrets, naming the secret and the folder and no value, and starts no container", async () => {
    withTarget();
    let started = false;
    const d: AgentDeps = { ...deps(async (run) => ((started = true), fakeSandbox(output())(run))), secrets: store(["QA_PASSWORD"]) };
    const result = await runAgent(d, context("e2e"), "e2e");
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "env_broken", envBroken: true, step: "secrets", names: ["QA_PASSWORD"] });
    expect(JSON.stringify(result.detail)).toContain("/home/me/.config/hardness/secrets/repo-1");
    expect(JSON.stringify(result.detail)).not.toContain(secret);
    expect(started).toBe(false);
  });
});

describe("a secret's value in what a stage returns and leaves", () => {
  const secret = ["out", "pw", "q".repeat(10)].join("-");
  it("is replaced in the answer, the summary, the events and the files the run left, for a run that had secrets", async () => {
    writeFileSync(join(repo, "luna.yaml"), "qa_targets:\n  - name: staging\n    url: https://staging.example.com\n    credential: env:QA_PASSWORD\n");
    const store = { folder: () => "/f", load: async (_r: string, names: string[]) => ({ values: Object.fromEntries(names.map((n) => [n, secret])), missing: [] }) };
    const inner = fakeSandbox(output({ summary: `typed ${secret}`, answer: { note: `pw ${secret}` } as never }), (r) => {
      mkdirSync(join(r.runDir, "out", "files"), { recursive: true });
      writeFileSync(join(r.runDir, "out", "files", "steps.jsonl"), `{"v":"${secret}"}`);
    });
    const d: AgentDeps = { ...deps(inner), secrets: store };
    const result = await runAgent(d, context("e2e"), "e2e");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[secret:QA_PASSWORD]");
    expect(readFileSync(join(stateDir, "runs", "run-1", "out", "files", "steps.jsonl"), "utf8")).toBe('{"v":"[secret:QA_PASSWORD]"}');
  });
});

describe("the browser run's one target", () => {
  const secret = ["tgt", "pw", "t".repeat(10)].join("-");
  const store = (): SecretStore & { loads: string[][] } => {
    const loads: string[][] = [];
    return { loads, folder: () => "/f", load: async (_r, names) => (loads.push([...names]), { values: Object.fromEntries(names.map((n) => [n, `${secret}-${n}`])), missing: [] }) };
  };
  const two = () => writeFileSync(join(repo, "luna.yaml"), "qa_targets:\n  - name: staging\n    url: https://staging.example.com\n    credential: env:STAGING_PW\n  - name: prod-like\n    url: https://other.example.com\n    credential: env:OTHER_PW\n");

  it("is the first declared QA target: the agent is told that one, its host is on the list, and only its credential is loaded and passed", async () => {
    two();
    const s = store();
    const requests: Array<{ targets?: string[] }> = [];
    const d: AgentDeps = { ...deps(fakeSandbox(output())), secrets: s, egress: { for: async (r) => (requests.push(r as never), { allow: [], allowPrivate: [], proxyImage: "img" }) } };
    await runAgent(d, context("e2e"), "e2e");
    expect(s.loads).toEqual([["STAGING_PW"]]);
    expect(seen?.secrets).toEqual({ STAGING_PW: `${secret}-STAGING_PW` });
    expect((seen?.input as { context: { qaTargets: Array<{ name: string }> } }).context.qaTargets.map((t) => t.name)).toEqual(["staging"]);
    expect(requests[0]!.targets).toEqual(["staging.example.com:443"]);
    expect(JSON.stringify(seen?.input)).not.toContain("OTHER_PW");
  });

  it.each(["e2e", "a11y_audit"] as const)("%s runs in the QA image, on the one target given: its host on the list, its credential loaded and passed, and no other target in the input", async (pack) => {
    two();
    const s = store();
    const requests: Array<{ targets?: string[] }> = [];
    const d: AgentDeps = { ...deps(fakeSandbox(output())), secrets: s, egress: { for: async (r) => (requests.push(r as never), { allow: [], allowPrivate: [], proxyImage: "img" }) } };
    await runAgent(d, context("e2e"), pack, { qaTarget: { name: "prod-like", baseUrl: "https://other.example.com", credential: "env:OTHER_PW" } });
    expect(seen?.image).toBe("qa-img");
    expect(requests[0]!.targets).toEqual(["other.example.com:443"]);
    expect(s.loads).toEqual([["OTHER_PW"]]);
    expect(seen?.secrets).toEqual({ OTHER_PW: `${secret}-OTHER_PW` });
    expect((seen?.input as { context: { qaTargets: Array<{ name: string }> } }).context.qaTargets.map((t) => t.name)).toEqual(["prod-like"]);
  });

  it("gives a11y_audit the repo's first target when none is named, as the browser run has it", async () => {
    two();
    const s = store();
    await runAgent({ ...deps(fakeSandbox(output())), secrets: s }, context("e2e"), "a11y_audit");
    expect(s.loads).toEqual([["STAGING_PW"]]);
    expect((seen?.input as { context: { qaTargets: Array<{ name: string }> } }).context.qaTargets.map((t) => t.name)).toEqual(["staging"]);
  });

  it("keeps every other pack out of the QA image: a decision-free stage pack still runs in the stage image", async () => {
    await runAgent(deps(fakeSandbox(output())), context("verifying"), "verifying");
    expect(seen?.image).not.toBe("qa-img");
  });

  it("is the app the machine started when it is given one: no credential, the app's network joined, and the aliases kept off the proxy", async () => {
    two();
    const s = store();
    const d: AgentDeps = { ...deps(fakeSandbox(output())), secrets: s };
    await runAgent(d, context("e2e"), "e2e", { qaTarget: { name: "app", baseUrl: "http://luna-app:4000", credential: null }, alsoJoin: ["hardness-card-app"], noProxy: ["luna-app", "db"] });
    expect((seen?.input as { context: { qaTargets: unknown[] } }).context.qaTargets).toEqual([{ name: "app", baseUrl: "http://luna-app:4000", credential: null }]);
    expect(seen?.alsoJoin).toEqual(["hardness-card-app"]);
    expect(seen?.noProxy).toEqual(["luna-app", "db"]);
    expect(seen?.secrets).toBeUndefined();
    expect(s.loads).toEqual([]);
  });
});

describe("a value kept only for redaction, and the failure paths", () => {
  const secret = ["kept", "pw", "r".repeat(10)].join("-");
  const extra = { redactValues: { APP_KEY: secret } };

  it("cleans the answer, the files and the events of an app's secret the browser run never held", async () => {
    const inner = fakeSandbox(output({ summary: `echoed ${secret}`, answer: { note: secret } as never }), (r) => {
      mkdirSync(join(r.runDir, "out", "files"), { recursive: true });
      writeFileSync(join(r.runDir, "out", "files", "trace.har"), `{"body":"${secret}"}`);
    });
    const result = await runAgent(deps(inner), context("e2e"), "e2e", extra);
    expect(seen?.secrets).toBeUndefined();
    expect(JSON.stringify(seen?.input)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(readFileSync(join(stateDir, "runs", "run-1", "out", "files", "trace.har"), "utf8")).toBe('{"body":"[secret:APP_KEY]"}');
  });

  it("cleans the text of a run stopped as stuck", async () => {
    const inner = fakeSandbox(output());
    const result = await runAgent(deps(async (run) => ({ ...(await inner(run)), stuck: `looped on ${secret}` })), context("e2e"), "e2e", extra);
    expect(result.outcome).toBe("fail");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[secret:APP_KEY]");
  });

  it("cleans the kept ledger of a run that timed out", async () => {
    const inner = fakeSandbox(output());
    const result = await runAgent(
      deps(async (run) => {
        const done = await inner(run);
        writeFileSync(join(run.runDir, "out", "ledger.json"), JSON.stringify({ schema: 1, slices: [{ id: 1, title: `typed ${secret}`, status: "red", commit: null }] }));
        return { ...done, timedOut: true };
      }),
      context("e2e"),
      "e2e",
      extra,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[secret:APP_KEY]");
  });

  it("cleans the message of an unreadable result", async () => {
    const result = await runAgent(
      deps(async (run) => {
        mkdirSync(join(run.runDir, "out"), { recursive: true });
        writeFileSync(join(run.runDir, "out", "result.json"), `${secret} is not json`);
        return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
      }),
      context("e2e"),
      "e2e",
      extra,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("the MCP bridge in a stage (RFC 0013)", () => {
  const declared = { name: "fixture", transport: "http" as const, url: "https://fixture.invalid/mcp", credential: { kind: "none" as const }, tools: ["echo", "shot", "boom"] };
  const grant = (tools: string[]) => [{ server: "fixture", tools }];
  const withBridge = <T>(bridge: ReturnType<typeof grant>, run: () => Promise<T>): Promise<T> => {
    const access = PACKS.triage.access as { bridge: ReturnType<typeof grant> };
    const before = access.bridge;
    access.bridge = bridge;
    return run().finally(() => {
      access.bridge = before;
    });
  };
  async function fixtureMcp(): Promise<{ mcp: Mcp; closed: () => number }> {
    const server = new McpServer({ name: "fixture", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo", inputSchema: { word: z.string() } }, async ({ word }) => ({ content: [{ type: "text", text: word }] }));
    server.registerTool("shot", { description: "An image" }, async () => ({ content: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] }));
    server.registerTool("boom", { description: "Fails" }, async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const inner = createMcp([declared], { transportFor: () => client, token: async () => null });
    let closes = 0;
    return { mcp: { ...inner, servers: () => inner.servers(), listTools: (s) => inner.listTools(s), callTool: (s, t, a) => inner.callTool(s, t, a), close: async () => void (closes += 1) }, closed: () => closes };
  }
  /** A container that makes the calls the test asks for through the mailbox, reads each answer, and then finishes. */
  const caller = (calls: Array<{ tool: string; args?: unknown; server?: string }>, answers: unknown[]) => async (run: SandboxRun): Promise<SandboxResult> => {
    run.onStarted?.("c1");
    const checks = join(run.runDir, "out", "checks");
    mkdirSync(checks, { recursive: true });
    let n = 0;
    for (const call of calls) {
      n += 1;
      writeFileSync(join(checks, `mcp-request-a1b2c3d4-${n}.json`), JSON.stringify({ n, server: call.server ?? "fixture", tool: call.tool, args: call.args ?? {} }));
      const file = join(checks, `mcp-answer-a1b2c3d4-${n}.json`);
      for (let i = 0; i < 400 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
      answers.push(JSON.parse(readFileSync(file, "utf8")));
    }
    seen = run;
    return fakeSandbox(output())(run);
  };
  const mcpDeps = (sandbox: (run: SandboxRun) => Promise<SandboxResult>, mcp: Mcp, emitted: Array<[string, Record<string, unknown>]> = []) => ({
    deps: { ...deps(sandbox), mcpFor: () => mcp, watchEvery: 5 } as AgentDeps,
    ctx: { ...context("triage"), emit: async (kind: string, payload: Record<string, unknown>) => void emitted.push([kind, payload]) } as StageContext,
  });

  it("fills StageInput.bridge from the grants, mounts /design read-only, and answers a call with the result as data", async () => {
    const { mcp, closed } = await fixtureMcp();
    const answers: unknown[] = [];
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const { deps: d, ctx } = mcpDeps(caller([{ tool: "echo", args: { word: "hi" } }], answers), mcp, emitted);
    await withBridge(grant(["echo"]), () => runAgent(d, ctx, "triage"));
    const input = seen?.input as { bridge: Array<{ server: string; tool: string; name: string }> };
    expect(input.bridge.map((b) => [b.server, b.tool, b.name])).toEqual([["fixture", "echo", "fixture_echo"]]);
    expect(extraMounts(seen!)).toContainEqual({ host: join(seen!.runDir, "design"), container: "/design", readOnly: true });
    expect(answers).toEqual([{ ok: true, text: '<data source="fixture.echo">hi</data>', images: [], truncated: false }]);
    const row = emitted.find(([kind]) => kind === "design.mcp_call")![1];
    expect(row).toMatchObject({ server: "fixture", tool: "echo", n: 1, outcome: "ok", bytes: 2 });
    expect(row.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(closed()).toBe(1);
  });

  it("writes an image under <runDir>/design and names it by its /design path", async () => {
    const { mcp } = await fixtureMcp();
    const answers: unknown[] = [];
    const { deps: d, ctx } = mcpDeps(caller([{ tool: "shot" }], answers), mcp);
    await withBridge(grant(["shot"]), () => runAgent(d, ctx, "triage"));
    expect(answers).toEqual([{ ok: true, text: '<data source="fixture.shot"></data>', images: ["/design/a1b2c3d4-1-0.png"], truncated: false }]);
    expect(readFileSync(join(seen!.runDir, "design", "a1b2c3d4-1-0.png"), "utf8")).toBe("png");
  });

  it("refuses a tool the run was not given, whatever the request says, and logs it", async () => {
    const { mcp } = await fixtureMcp();
    const answers: unknown[] = [];
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const { deps: d, ctx } = mcpDeps(caller([{ tool: "boom" }, { tool: "echo", server: "other" }], answers), mcp, emitted);
    await withBridge(grant(["echo"]), () => runAgent(d, ctx, "triage"));
    expect(answers).toEqual([{ ok: false, error: "fixture.boom is not available in this run" }, { ok: false, error: "other.echo is not available in this run" }]);
    expect(emitted.map(([, p]) => p.outcome)).toEqual(["refused", "refused"]);
  });

  it("turns a failing tool into an error answer and an error row", async () => {
    const { mcp } = await fixtureMcp();
    const answers: unknown[] = [];
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const { deps: d, ctx } = mcpDeps(caller([{ tool: "boom" }], answers), mcp, emitted);
    await withBridge(grant(["boom"]), () => runAgent(d, ctx, "triage"));
    expect(answers).toEqual([{ ok: false, error: '<data source="fixture.boom">nope</data>' }]);
    expect(emitted[0]![1]).toMatchObject({ tool: "boom", outcome: "error" });
  });

  it("says why a server gave no tool, and starts without a bridge", async () => {
    const notes: string[] = [];
    const { deps: d, ctx } = mcpDeps(fakeSandbox(output()), noTokenMcp([declared]));
    await withBridge(grant(["echo"]), () => runAgent(d, { ...ctx, note: async (t) => void notes.push(t) }, "triage"));
    expect((seen?.input as { bridge: unknown[] }).bridge).toEqual([]);
    expect(notes).toContain("fixture: not logged in (pnpm mcp login fixture)");
    expect(extraMounts(seen!).some((m) => m.container === "/design")).toBe(false);
  });

  it("gives an untrusted card no bridged tools, and says so", async () => {
    const { mcp } = await fixtureMcp();
    const notes: string[] = [];
    const { deps: d, ctx } = mcpDeps(fakeSandbox(output()), mcp);
    const untrusted = { ...ctx, task: { ...ctx.task, source: { kind: "github", authorAssociation: "NONE" } }, note: async (t: string) => void notes.push(t) } as unknown as StageContext;
    await withBridge(grant(["echo"]), () => runAgent(d, untrusted, "triage"));
    expect((seen?.input as { bridge: unknown[] }).bridge).toEqual([]);
    expect(notes).toContain("untrusted card: no bridged tools");
  });

  it("gives no bridge to a repo whose luna.yaml turns design off, and narrows by its servers otherwise", async () => {
    const { mcp } = await fixtureMcp();
    const policy = (design: unknown) => ({ policies: { for: async () => ({ ...DEFAULT_POLICY, design }) } as never });
    const off = { ...mcpDeps(fakeSandbox(output()), mcp).deps, ...policy("off") };
    await withBridge(grant(["echo"]), () => runAgent(off, context("triage"), "triage"));
    expect((seen?.input as { bridge: unknown[] }).bridge).toEqual([]);
    const narrowed = { ...mcpDeps(fakeSandbox(output()), mcp).deps, ...policy({ servers: { fixture: { tools: ["boom"] } } }) };
    await withBridge(grant(["echo", "boom"]), () => runAgent(narrowed, context("triage"), "triage"));
    expect((seen?.input as { bridge: Array<{ tool: string }> }).bridge.map((b) => b.tool)).toEqual(["boom"]);
  });

  it("neither connects nor mounts for a pack with no grants, and closes the run's client when it has some", async () => {
    let made = 0;
    const d = { ...deps(fakeSandbox(output())), mcpFor: () => (made += 1, noTokenMcp()) } as AgentDeps;
    await runAgent(d, context("triage"), "triage");
    expect(made).toBe(0);
    expect(extraMounts(seen!).some((m) => m.container === "/design")).toBe(false);
  });
});

describe("the ui-designer's own run (RFC 0013, phase 5)", () => {
  const SLICE = 3;
  const helperFor = (base: string, over: Record<string, unknown> = {}) => ({
    slice: { id: SLICE, title: "The card page", touchpoints: ["page.tsx"], acceptance: ["the page renders"] },
    message: "build the page",
    base,
    locks: { mine: ["page.tsx"], theirs: ["api.ts"] },
    attempt: 1 as const,
    ...over,
  });
  /** The card's workspace W on `task/card`, and the helper's fresh workspace M' beside it, as the coordinator makes them. */
  async function made() {
    writeFileSync(join(repo, "api.ts"), "api\n");
    writeFileSync(join(repo, "page.tsx"), "page\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "files");
    const cardPath = join(root, "worktrees", "card");
    await ensureClone(repo, { branch: "task/card", path: cardPath });
    const base = await headCommit(cardPath);
    const ws = await helperWorkspace.make(cardPath, base, context("implementing").task.id, SLICE, 1);
    return { cardPath, base, ws: { path: ws.path, branch: ws.branch } };
  }
  const helperContext = (over: Partial<StageContext> = {}): StageContext => ({ ...context("implementing"), engine: "claude:sonnet", ...over });
  /** A container that lets `act` work in the folder, bundles what it committed as the factory does, and ends. */
  const box = (act: (run: SandboxRun) => Promise<void> | void = () => {}) => async (run: SandboxRun): Promise<SandboxResult> => {
    seen = run;
    run.onStarted?.("c1");
    mkdirSync(join(run.runDir, "out", "bundles"), { recursive: true });
    const started = agent(run.worktree, "rev-parse", "HEAD");
    await act(run);
    if (agent(run.worktree, "rev-parse", "HEAD") !== started) agent(run.worktree, "bundle", "create", join(run.runDir, "out", "bundles", "1.bundle"), `${started}..HEAD`);
    writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(output()));
    writeFileSync(join(run.runDir, "out", "events.jsonl"), "");
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: join(run.runDir, "t.log") };
  };
  const commitPage = (run: SandboxRun, file = "page.tsx") => {
    writeFileSync(join(run.worktree, file), "page v2\n");
    agent(run.worktree, "add", "-A");
    agent(run.worktree, "commit", "-q", "-m", "ui");
    return agent(run.worktree, "rev-parse", "HEAD");
  };
  const input = () => seen!.input as unknown as StageInput;

  it("runs in the helper's workspace: its commits land on luna-helper-<slice> there, the card's branch is untouched, nothing is published and the task keeps its workspace", async () => {
    const { cardPath, base, ws } = await made();
    let tip = "";
    const result = await runAgent(deps(box((run) => void (tip = commitPage(run)))), helperContext(), "ui_design", { workspace: ws, helper: helperFor(base) });
    expect(result.outcome).toBe("pass");
    expect(seen!.worktree).toBe(ws.path);
    expect(git(ws.path, "rev-parse", "refs/heads/luna-helper-3")).toBe(tip);
    expect(git(cardPath, "rev-parse", "refs/heads/task/card")).toBe(base);
    expect(() => git(repo, "rev-parse", "--verify", "refs/heads/luna-helper-3")).toThrow();
    expect(() => git(repo, "rev-parse", "--verify", "refs/heads/task/card")).toThrow();
    expect(result.workspace).toBeUndefined();
  });

  it("starts from the helper's context: its slice and locks, the plan with the approved spec, the design and a ledger of its one slice", async () => {
    const { base, ws } = await made();
    const design = { refs: [{ kind: "figma", url: "https://figma.com/file/x" }] } as never;
    await runAgent(deps(box()), helperContext(), "ui_design", { workspace: ws, helper: helperFor(base), design });
    expect(input().pack).toBe("ui_design");
    expect(input().context.helper).toEqual(helperFor(base));
    expect(input().context.design).toEqual(design);
    expect(input().context.ledger).toEqual({ schema: 1, slices: [{ id: SLICE, title: "The card page", status: "pending", commit: null }] });
    expect(input().task.branch).toBe("luna-helper-3");
  });

  it("measures the helper's scope from the base it started at, plans only its slice's files and locks the implementer's", async () => {
    const { base, ws } = await made();
    const asked: Array<{ planned?: string[] }> = [];
    let scope: { facts: { changed: string[]; lockedTouched: Array<{ path: string; owner: string }> } } | undefined;
    const sandbox = box(async (run) => {
      commitPage(run, "api.ts");
      // the factory bundles a commit as it lands, before the machine is asked about it
      agent(run.worktree, "bundle", "create", join(run.runDir, "out", "bundles", "1.bundle"), "HEAD~1..HEAD");
      const checks = join(run.runDir, "out", "checks");
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, "scope-request.json"), JSON.stringify({ diffSummary: "ui", outOfMap: [] }));
      const file = join(checks, "scope.json");
      for (let i = 0; i < 400 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
      scope = JSON.parse(readFileSync(file, "utf8"));
    });
    const decide = (async (_pack: string, check: { planned?: string[] }) => (asked.push(check), null)) as never;
    await runAgent({ ...deps(sandbox), decide, watchEvery: 5 } as AgentDeps, helperContext(), "ui_design", { workspace: ws, helper: helperFor(base) });
    expect(scope?.facts.changed).toEqual(["api.ts"]);
    expect(scope?.facts.lockedTouched).toEqual([{ path: "api.ts", owner: "implementer" }]);
  });

  it("only syncs the importer when its slice commits: no checkpoint push, and the commit still arrives", async () => {
    const { base, ws } = await made();
    const hostExec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    let tip = "";
    const sandbox = box(async (run) => {
      tip = commitPage(run);
      writeFileSync(join(run.runDir, "out", "ledger.json"), JSON.stringify({ schema: 1, slices: [{ id: SLICE, title: "The card page", status: "committed", commit: tip }] }));
      await new Promise((r) => setTimeout(r, 150));
    });
    await runAgent({ ...deps(sandbox), hostExec, watchEvery: 5 }, helperContext(), "ui_design", { workspace: ws, helper: helperFor(base) });
    expect(hostExec).not.toHaveBeenCalled();
    expect(git(ws.path, "rev-parse", "refs/heads/luna-helper-3")).toBe(tip);
  });

  describe("its engine and effort", () => {
    it("runs on the implementer's engine when the pack allows it", async () => {
      const { base, ws } = await made();
      await runAgent(deps(box()), helperContext({ engine: "claude:opus" }), "ui_design", { workspace: ws, helper: helperFor(base) });
      expect(input().engine).toBe("claude:opus");
    });

    it("runs on the pack's default when the implementer's engine is not one the pack allows", async () => {
      const { base, ws } = await made();
      await runAgent(deps(box()), helperContext({ engine: "codex:sol" }), "ui_design", { workspace: ws, helper: helperFor(base) });
      expect(input().engine).toBe(PACKS.ui_design.engines.default);
    });

    it("runs at the effort the repo's luna.yaml sets for the implementer", async () => {
      const { base, ws } = await made();
      writeFileSync(join(repo, "luna.yaml"), "effort:\n  implementing: high\n");
      await runAgent(deps(box()), helperContext(), "ui_design", { workspace: ws, helper: helperFor(base) });
      expect(input().effort).toBe("high");
    });

    it("keeps the pack's own effort when the repo sets none", async () => {
      const { base, ws } = await made();
      await runAgent(deps(box()), helperContext(), "ui_design", { workspace: ws, helper: helperFor(base) });
      expect(input().effort).toBeUndefined();
    });
  });
});

describe("the implementer's side of the ui-designer (RFC 0013, phase 5)", () => {
  const FIGMA = "https://www.figma.com/design/ABCDEFGHIJ1234/Page?node-id=1-2";
  const uiPlan = { brief: "b", criteria: [], assumptions: [], slices: [{ title: "The page", est_loc: 20, touchpoints: ["page.tsx"], acceptance: ["it renders"] }] };
  const apiPlan = { ...uiPlan, slices: [{ title: "The api", est_loc: 20, touchpoints: ["api.ts"], acceptance: ["it answers"] }] };
  const withPlan = (plan: unknown, over: Partial<StageContext> = {}, description = `Build it. ${FIGMA}`): StageContext => {
    const base = context("implementing");
    return {
      ...base,
      engine: "claude:sonnet",
      task: { ...base.task, description } as never,
      approvals: [{ id: "ap1", kind: "awaiting_approval", decision: "approved", requested: plan } as never],
      ...over,
    };
  };
  const input = () => seen!.input as unknown as StageInput;
  const policies = (over: Record<string, unknown> = {}) => ({ policies: { for: async () => ({ ...DEFAULT_POLICY, ...over }) } as never });
  /** A coordinator that records what it was built with and answers as told. */
  function coordinator(over: Partial<import("./helper-runs.ts").HelperRuns> = {}) {
    const built: Array<import("./helper-runs.ts").HelperRunsDeps> = [];
    const calls: string[] = [];
    const runs: import("./helper-runs.ts").HelperRuns = {
      onHelperRequest: async (r) => ({ ok: true, handle: `h/${r.slice}`, branch: "refs/luna/helper/x", base: "b", locks: ["page.tsx"] }),
      onPickRequest: async () => ({ ok: false, error: "no" }),
      onPickAck: async () => ({ ok: false, reason: "no" }),
      afterRun: async (outcome) => (calls.push(`afterRun ${outcome}`), null),
      cancel: async () => void calls.push("cancel"),
      picked: () => new Set<string>(),
      delegatedLocks: () => [],
      status: () => null,
      ...over,
    };
    return { runs, built, calls, factory: (d: import("./helper-runs.ts").HelperRunsDeps) => (built.push(d), runs) };
  }
  const commitWeb = () => {
    for (const [file, text] of [["index.html", "<html></html>\n"], ["page.tsx", "page\n"], ["api.ts", "api\n"]] as const) writeFileSync(join(repo, file), text);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "web");
  };
  const run = (d: Partial<AgentDeps>, context: StageContext, extra = {}) => runAgent({ ...deps(fakeSandbox(output())), ...d } as AgentDeps, context, "implementing", extra);

  it("says the implementer may delegate when the card has a design, a UI slice and budget, and builds the coordinator before the container starts", async () => {
    commitWeb();
    const c = coordinator();
    let builtBeforeStart = false;
    const sandbox = async (r: SandboxRun) => ((builtBeforeStart = c.built.length === 1), fakeSandbox(output())(r));
    await run({ helperRuns: c.factory, sandbox }, withPlan(uiPlan));
    expect(builtBeforeStart).toBe(true);
    expect(input().context.delegation).toEqual({ available: true, helper: { role: "ui-designer", engine: "claude:sonnet" } });
    const d = c.built[0]!;
    expect(d).toMatchObject({ taskId: context("implementing").task.id, signal: expect.any(AbortSignal) });
    expect(d.outDir).toBe(join(seen!.runDir, "out"));
    expect(d.branch).toMatch(/^task\//);
  });

  it("gives the coordinator the machine's facts: the plan, the card's design, the budget, and the tests commit's files as protected", async () => {
    commitWeb();
    const c = coordinator();
    const budget = async () => ({ spent: false, minutesLeft: 40, tokens: null, tokensCounted: false, minutes: 0, limits: { max_tokens: 1, max_minutes: 40 }, } as never);
    await run({ helperRuns: c.factory, design: { budget } }, withPlan(uiPlan, { budgetMinutes: 30 }), { testsFiles: ["t.test.ts"], scenarioTests: [{ scenario: "S1", file: "t.test.ts" }], inlineTests: ["lib.rs"] });
    const d = c.built[0]!;
    const facts = await d.facts();
    expect(facts.slices.map((s) => s.touchpoints)).toEqual([["page.tsx"]]);
    expect(facts.webRoots).toEqual([""]);
    expect(facts.designRef).toEqual({ refs: [{ fileKey: "ABCDEFGHIJ1234", nodeIds: ["1:2"], page: null, from: "issue" }] });
    expect(facts).toMatchObject({ designOff: false, implementerEngine: "claude:sonnet", repoEngine: null, designBudget: { spent: false, minutesLeft: 40 }, protectedPaths: ["t.test.ts"] });
    expect(facts.implementerMinutesLeft).toBeGreaterThan(29);
    expect(facts.implementerMinutesLeft).toBeLessThanOrEqual(30);
    expect(d.runExtra()).toMatchObject({ scenarioTests: [{ scenario: "S1", file: "t.test.ts" }], testsFiles: ["t.test.ts"], inlineTests: ["lib.rs"] });
    expect(d.priorPicked).toBeDefined();
  });

  it("answers the container's helper request through the build watch", async () => {
    commitWeb();
    const c = coordinator();
    const answers: unknown[] = [];
    const sandbox = async (r: SandboxRun) => {
      r.onStarted?.("c1");
      const checks = join(r.runDir, "out", "checks");
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, "helper-request-a1b2c3d4-1.json"), JSON.stringify({ n: 1, slice: 1, message: "go" }));
      const file = join(checks, "helper-answer-a1b2c3d4-1.json");
      for (let i = 0; i < 400 && !existsSync(file); i++) await new Promise((res) => setTimeout(res, 10));
      answers.push(JSON.parse(readFileSync(file, "utf8")));
      return fakeSandbox(output())(r);
    };
    await run({ helperRuns: c.factory, sandbox, watchEvery: 5 }, withPlan(uiPlan));
    expect(answers).toEqual([{ ok: true, handle: expect.stringContaining("/1"), branch: "refs/luna/helper/x", base: "b", locks: ["page.tsx"] }]);
  });

  it("says no and builds nothing when the repo turns design off", async () => {
    commitWeb();
    const c = coordinator();
    await run({ helperRuns: c.factory, ...policies({ design: "off" }) }, withPlan(uiPlan));
    expect(input().context.delegation).toEqual({ available: false, reason: "design is off for this repo" });
    expect(c.built).toHaveLength(0);
  });

  it.each([
    ["the card has no design reference", uiPlan, "no design here", "the card has no design reference"],
    ["the plan has no pure UI slice", apiPlan, `Build it. ${FIGMA}`, "no slice of the plan is a pure UI slice"],
  ])("says no and builds nothing when %s", async (_why, plan, description, reason) => {
    commitWeb();
    const c = coordinator();
    await run({ helperRuns: c.factory }, withPlan(plan, {}, description));
    expect(input().context.delegation).toEqual({ available: false, reason });
    expect(c.built).toHaveLength(0);
  });

  it("says no when the design budget is spent", async () => {
    commitWeb();
    const c = coordinator();
    const budget = async () => ({ spent: "minutes", minutesLeft: 0 }) as never;
    await run({ helperRuns: c.factory, design: { budget } }, withPlan(uiPlan));
    expect(input().context.delegation).toEqual({ available: false, reason: "the design budget is spent" });
    expect(c.built).toHaveLength(0);
  });

  it("lands the helper after a pass, before the run's result is used; a merge_conflict overrides whatever the agent answered", async () => {
    commitWeb();
    const c = coordinator({ afterRun: async (o) => (c.calls.push(`afterRun ${o}`), { escalate: "merge_conflict", reason: "slice 1 conflicts in a.ts" }), status: () => ({ slice: 1, state: "merge_conflict", attempt: 2 }) });
    const result = await run({ helperRuns: c.factory }, withPlan(uiPlan));
    expect(c.calls).toEqual(["afterRun pass"]);
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "merge_conflict", escalationFact: "merge_conflict", reason: "slice 1 conflicts in a.ts", options: [], helper: { slice: 1, state: "merge_conflict", attempt: 2 } });
  });

  it("overrides a failed answer with merge_conflict too", async () => {
    commitWeb();
    const c = coordinator({ afterRun: async () => ({ escalate: "merge_conflict", reason: "r" }) });
    const result = await run({ helperRuns: c.factory, sandbox: fakeSandbox(output({ ok: false, outcome: "fail", error: "x" })) }, withPlan(uiPlan));
    expect(result.outcome).toBe("escalated");
    expect(result.detail).toMatchObject({ escalation: "merge_conflict", escalationFact: "merge_conflict" });
  });

  it("escalates design_budget only after a pass", async () => {
    commitWeb();
    const spent = () => coordinator({ afterRun: async () => ({ escalate: "design_budget", reason: "spent" }) });
    const passed = spent();
    const ok = await run({ helperRuns: passed.factory }, withPlan(uiPlan));
    expect(ok.outcome).toBe("escalated");
    expect(ok.detail).toMatchObject({ escalation: "design_budget", escalationFact: "design_budget", reason: "spent", options: [] });
    const failed = spent();
    const bad = await run({ helperRuns: failed.factory, sandbox: fakeSandbox(output({ ok: false, outcome: "fail", error: "x" })) }, withPlan(uiPlan));
    expect(bad.outcome).toBe("fail");
    expect(bad.detail).not.toHaveProperty("escalationFact");
  });

  it("tells afterRun the run failed when the container timed out, and cancels the helper before the credential is released", async () => {
    commitWeb();
    const { credentials, log } = (() => {
      const log: string[] = [];
      const credentials: Credentials = { check: async () => ({ available: true }), prepare: async () => ({ env: {}, mounts: [], release: async () => void log.push("release") }) };
      return { credentials, log };
    })();
    const c = coordinator({ cancel: async () => void log.push("cancel"), afterRun: async (o) => (log.push(`afterRun ${o}`), null), status: () => ({ slice: 1, state: "cancelled", attempt: 1 }) });
    const sandbox = async (): Promise<SandboxResult> => ({ exitCode: 1, timedOut: true, aborted: false, transcriptPath: join(root, "t.log") });
    const result = await run({ helperRuns: c.factory, credentials, sandbox }, withPlan(uiPlan));
    expect(log.indexOf("cancel")).toBeGreaterThan(-1);
    expect(log.indexOf("cancel")).toBeLessThan(log.indexOf("release"));
    expect(log).toContain("afterRun fail");
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ helper: { slice: 1, state: "cancelled", attempt: 1 } });
  });

  it("leaves a run with no helper as it was: no helper detail, no coordinator call at all when nothing is delegable", async () => {
    commitWeb();
    const c = coordinator();
    const result = await run({ helperRuns: c.factory }, withPlan(apiPlan));
    expect(result.detail).not.toHaveProperty("helper");
    expect(c.calls).toEqual([]);
  });
});
