import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CredentialWaitError, NoCredentialError, type PrepareWait } from "../../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { buildSlackTriageInput } from "../../domain/stage-input.ts";
import { outputError, runPackOnce } from "./run-once.ts";

const input: StageInput = buildSlackTriageInput({ me: { id: "U1", name: "a" }, watches: [], rules: "", items: [] }, "claude:haiku");
const result = { schema: 3, ok: true, outcome: "pass", summary: "", answer: { items: [] }, needsInput: null, requested: [], findings: [], artifacts: [], slices: { done: 0, total: 0 }, commit: null, usage: { turns: 1, costUsd: null, durationMs: 5, model: "m" }, error: null, rateLimited: false, resetsAt: null };

function setup(leave: string | null, over: Partial<SandboxResult> = {}) {
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
  const go = () => runPackOnce({ name: "c", image: "img", runDir, worktree: join(runDir, "work"), input, engine: "claude:haiku", labels: { luna: "x" } }, { credentials, sandbox });
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
    expect(await once(new CredentialWaitError("waited 3 min for the Codex login"))).toEqual({ output: null, error: "waited 3 min for the Codex login" });
    expect(waits[0]).toMatchObject({ timeoutMs: input.limits.timeoutMs });
    await expect(once(new NoCredentialError("no Codex login"))).rejects.toThrow(/no Codex login/);
  });

  it("names a failed result's error, else its summary", () => {
    expect(outputError({ ...result, ok: false, error: "boom" } as never)).toBe("boom");
    expect(outputError({ ...result, ok: false, error: { code: 1 } } as never)).toBe('{"code":1}');
    expect(outputError({ ...result, ok: false, summary: "s" } as never)).toBe("s");
  });
});
