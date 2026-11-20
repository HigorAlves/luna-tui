import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MachinePolicySchema, type StageInput } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import { CredentialWaitError, NoCredentialError, type PrepareWait } from "../../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { buildSlackTriageInput } from "../../domain/stage-input.ts";
import { PolicyStore } from "../policy.ts";
import { outputError, runPackOnce } from "./run-once.ts";

const input: StageInput = buildSlackTriageInput({ me: { id: "U1", name: "a" }, watches: [], rules: "", items: [] }, "claude:haiku");
const result = { schema: 3, ok: true, outcome: "pass", summary: "", answer: { items: [] }, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null, usage: { turns: 1, costUsd: null, durationMs: 5, model: "m" }, error: null, rateLimited: false, resetsAt: null };

function setup(leave: string | null, over: Partial<SandboxResult> = {}, extraEnv?: Record<string, string>) {
  const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
  const seen: SandboxRun[] = [];
  const released: string[] = [];
  const credentials = {
    prepare: async (engine: string) => ({ env: { TOKEN: "t" }, mounts: [], release: async () => void released.push(engine) }),
  };
  const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
    seen.push(run);
    mkdirSync(join(run.runDir, "out"), { recursive: true });
    if (leave !== null) writeFileSync(join(run.runDir, "out", "result.json"), leave);
    return { exitCode: 3, timedOut: false, aborted: false, transcriptPath: "", ...over };
  };
  const go = () => runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: { luna: "x" }, extraEnv }, { credentials, sandbox });
  return { go, seen, released };
}

describe("runPackOnce", () => {
  it("runs read-only with only the engine's credential, releases it, and reads the result back", async () => {
    const { go, seen, released } = setup(JSON.stringify(result));
    const run = await go();
    expect(run.error).toBeNull();
    expect(run.output?.answer).toEqual({ items: [] });
    expect(seen[0]).toMatchObject({ name: "c", image: "img", writable: false, gitDir: null, timeoutMs: input.limits.timeoutMs, credential: { env: { TOKEN: "t" }, mounts: [] }, labels: { luna: "x" } });
    expect(released).toEqual(["claude:haiku"]);
  });

  it("sizes the container by the machine's sandbox policy for an untrusted input: runtime, process limit, seccomp, cpu and memory", async () => {
    const machinePolicy = MachinePolicySchema.parse({ limits: { max_cpu: 1, max_memory_gb: 2, max_pids: 200 }, runtime: { untrusted: "runsc" }, seccomp: "/etc/luna/s.json" });
    const policies = new PolicyStore({ warn: () => {}, machinePolicy });
    const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
    const seen: SandboxRun[] = [];
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => (seen.push(run), { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" });
    const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
    const base = { name: "c", image: "img", runDir, worktree: runDir, input, engine: "claude:haiku" as const, labels: {} };
    await runPackOnce(base, { credentials, sandbox, policies });
    expect(seen[0]!.limits).toMatchObject({ cpu: 1, memoryGb: 2, pids: 200, seccomp: "/etc/luna/s.json", runtime: "runsc", cacheTrust: "untrusted" });
    await runPackOnce({ ...base, trust: "trusted" }, { credentials, sandbox, policies });
    expect(seen[1]!.limits).toMatchObject({ pids: 200, cacheTrust: "trusted" });
    expect(seen[1]!.limits).not.toHaveProperty("runtime");
    await runPackOnce(base, { credentials, sandbox });
    expect(seen[2]!.limits).toBeUndefined();
  });

  it("mounts the folders it is handed read-only, and none when it has none", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "run-once-m-"));
    const sandbox = vi.fn(async (_run: unknown) => ({ exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" }));
    const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
    const base = { name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku" as const, labels: {} };
    await runPackOnce({ ...base, mounts: [{ host: "/h/evidence", container: "/evidence", readOnly: true }] }, { credentials, sandbox: sandbox as never });
    expect((sandbox.mock.calls[0]![0] as { mounts?: unknown }).mounts).toEqual([{ host: "/h/evidence", container: "/evidence", readOnly: true }]);
    await runPackOnce(base, { credentials, sandbox: sandbox as never });
    expect(sandbox.mock.calls[1]![0]).not.toHaveProperty("mounts");
  });

  it("hands the run's extra env to the container, and an empty one when none is given", async () => {
    const withEnv = setup(JSON.stringify(result), {}, { A: "1" });
    await withEnv.go();
    expect(withEnv.seen[0]!.extraEnv).toEqual({ A: "1" });
    const without = setup(JSON.stringify(result));
    await without.go();
    expect(without.seen[0]!.extraEnv).toEqual({});
  });

  it("says why when there is no readable result", async () => {
    expect((await setup(null).go()).error).toBe("the container left no result (exit code 3)");
    expect((await setup("{").go()).error).toBe("unreadable result: not JSON");
    expect((await setup("{}").go()).error).toMatch(/^unreadable result: /);
    expect((await setup(null, { aborted: true }).go()).error).toBe("aborted");
    expect((await setup(null, { timedOut: true }).go()).error).toBe("timed out after 3 minutes");
  });

  it("waits for a held credential within the pack's timeout; one held past it is the run's error, a missing one still rejects", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
    const waits: Array<PrepareWait | undefined> = [];
    const once = (error: Error) =>
      runPackOnce(
        { name: "c", image: "img", runDir, worktree: runDir, input, engine: "codex:luna", labels: {} },
        {
          credentials: {
            prepare: async (_engine, _dir, wait) => {
              waits.push(wait);
              throw error;
            },
          },
          sandbox: async () => {
            throw new Error("no container should start");
          },
        },
      );
    expect(await once(new CredentialWaitError("waited 3 min for the Codex login"))).toEqual({ output: null, error: "waited 3 min for the Codex login", credentialBusy: true });
    expect(waits[0]).toMatchObject({ timeoutMs: input.limits.timeoutMs });
    await expect(once(new NoCredentialError("no Codex login"))).rejects.toThrow(/no Codex login/);
  });

  it("names a failed result's error, else its summary", () => {
    expect(outputError({ ...result, ok: false, error: "boom" } as never)).toBe("boom");
    expect(outputError({ ...result, ok: false, error: { code: 1 } } as never)).toBe('{"code":1}');
    expect(outputError({ ...result, ok: false, summary: "s" } as never)).toBe("s");
  });
});

describe("runPackOnce's list", () => {
  it("asks for the pack list (no repository) of the engine's owner and hands it to the sandbox; without a policy it passes none", async () => {
    const { seen, released: _ } = setup(JSON.stringify(result));
    const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
    const asked: unknown[] = [];
    const spec = { allow: ["api.anthropic.com:443"], allowPrivate: [], proxyImage: "img" };
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      seen.push(run);
      mkdirSync(join(run.runDir, "out"), { recursive: true });
      writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(result));
      return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
    };
    const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
    await runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: {} }, { credentials, sandbox, egress: { for: async (r) => (asked.push(r), spec) } });
    expect(asked).toEqual([{ repoPath: null, kind: "pack", owners: ["claude"] }]);
    expect(seen.at(-1)?.egress).toEqual(spec);
    await runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: {} }, { credentials, sandbox });
    expect(seen.at(-1)?.egress).toBeUndefined();
  });
});

describe("runPackOnce for a pack that needs GitHub", () => {
  it("asks for the github list when the pack says so", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
    const asked: unknown[] = [];
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      mkdirSync(join(run.runDir, "out"), { recursive: true });
      writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(result));
      return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
    };
    const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
    await runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: {}, egressKind: "github" }, { credentials, sandbox, egress: { for: async (r) => (asked.push(r), { allow: [], allowPrivate: [], proxyImage: "img" }) } });
    expect(asked).toEqual([{ repoPath: null, kind: "github", owners: ["claude"] }]);
  });
});

describe("runPackOnce for an eval", () => {
  it("can ask for the list a real run of the pack gets (kind agent) instead of the pack list", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "run-once-"));
    const asked: unknown[] = [];
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      mkdirSync(join(run.runDir, "out"), { recursive: true });
      writeFileSync(join(run.runDir, "out", "result.json"), JSON.stringify(result));
      return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
    };
    const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
    await runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: {}, egressKind: "agent" }, { credentials, sandbox, egress: { for: async (r) => (asked.push(r), { allow: [], allowPrivate: [], proxyImage: "img" }) } });
    expect(asked).toEqual([{ repoPath: null, kind: "agent", owners: ["claude"] }]);
  });
});

describe("runPackOnce with bridged tools, a QA image and a QA target (RFC 0013)", () => {
  const credentials = { prepare: async () => ({ env: {}, mounts: [], release: async () => {} }) };
  const tools = [{ server: "figma", tool: "get_design_context", name: "figma_get_design_context", description: "d", inputSchema: {} }];
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    if (!ok()) throw new Error("timed out waiting");
  };

  it("serves the bridged tools of the run through the mailbox, mounts /design and closes the client", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "once-"));
    const closed = vi.fn(async () => {});
    const callTool = vi.fn(async () => ({ ok: true as const, text: "frame", images: [], truncated: false }));
    const mcp = { servers: () => [], listTools: async () => [], callTool, close: closed };
    const rows: unknown[] = [];
    let seen: SandboxRun | undefined;
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
      seen = run;
      // the container's side: one bridged call, then the result
      mkdirSync(join(runDir, "out", "checks"), { recursive: true });
      writeFileSync(join(runDir, "out", "checks", "mcp-request-abcd1234-1.json"), JSON.stringify({ n: 1, server: "figma", tool: "get_design_context", args: { nodeId: "1:2" } }));
      await waitFor(() => existsSync(join(runDir, "out", "checks", "mcp-answer-abcd1234-1.json")));
      writeFileSync(join(runDir, "out", "result.json"), JSON.stringify(result));
      return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
    };
    const out = await runPackOnce(
      { name: "c", image: "img", runDir, worktree: runDir, input: { ...input }, engine: "claude:haiku", labels: {}, bridge: { tools, mcp, designDir: join(runDir, "design"), log: (r) => void rows.push(r) } },
      { credentials, sandbox },
    );
    expect(out.error).toBeNull();
    expect((seen!.input as { bridge: unknown[] }).bridge).toEqual(tools);
    expect(seen!.mounts).toContainEqual({ host: join(runDir, "design"), container: "/design", readOnly: true });
    expect(callTool).toHaveBeenCalledWith("figma", "get_design_context", { nodeId: "1:2" });
    expect(JSON.parse(readFileSync(join(runDir, "out", "checks", "mcp-answer-abcd1234-1.json"), "utf8"))).toMatchObject({ ok: true, text: expect.stringContaining("frame") });
    expect(rows).toEqual([expect.objectContaining({ server: "figma", tool: "get_design_context", outcome: "ok" })]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("closes the client when the sandbox throws", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "once-"));
    const closed = vi.fn(async () => {});
    const mcp = { servers: () => [], listTools: async () => [], callTool: async () => ({ ok: false as const, error: "x" }), close: closed };
    await expect(
      runPackOnce({ name: "c", image: "img", runDir, worktree: runDir, input, engine: "claude:haiku", labels: {}, bridge: { tools, mcp, designDir: join(runDir, "design"), log: () => {} } }, { credentials, sandbox: async () => { throw new Error("docker down"); } }),
    ).rejects.toThrow("docker down");
    expect(closed).toHaveBeenCalledOnce();
  });

  it("runs in the image it is given, with the QA target's hosts, the secret values and the networks it is handed", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "once-"));
    const asked: unknown[] = [];
    let seen: SandboxRun | undefined;
    const sandbox = async (run: SandboxRun): Promise<SandboxResult> => ((seen = run), { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" });
    await runPackOnce(
      { name: "c", image: "hardness-runner-qa:dev", runDir, worktree: runDir, input, engine: "claude:haiku", labels: {}, egressKind: "agent", egressTargets: ["staging.example.com"], secrets: { QA_PASSWORD: "pw" }, alsoJoin: ["net-app"], noProxy: ["luna-app"], redactValues: { K: "v" } },
      { credentials, sandbox, egress: { for: async (r) => (asked.push(r), { allow: [], allowPrivate: [], proxyImage: "img" }) } },
    );
    expect(seen!.image).toBe("hardness-runner-qa:dev");
    expect(asked).toEqual([{ repoPath: null, kind: "agent", owners: ["claude"], targets: ["staging.example.com"] }]);
    expect(seen).toMatchObject({ secrets: { QA_PASSWORD: "pw" }, alsoJoin: ["net-app"], noProxy: ["luna-app"], redactValues: { K: "v" } });
  });

  it("passes none of these to the sandbox when it is given none", async () => {
    let seen: SandboxRun | undefined;
    const runDir = mkdtempSync(join(tmpdir(), "once-"));
    await runPackOnce({ name: "c", image: "img", runDir, worktree: runDir, input, engine: "claude:haiku", labels: {} }, { credentials, sandbox: async (r) => ((seen = r), { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" }) });
    for (const key of ["mounts", "secrets", "alsoJoin", "noProxy", "redactValues"]) expect(seen).not.toHaveProperty(key);
    expect((seen!.input as { bridge: unknown[] }).bridge).toEqual([]);
  });
});
