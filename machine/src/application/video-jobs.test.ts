import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { runVideoTool } from "./video-jobs.ts";

const jobDir = realpathSync(mkdtempSync(join(tmpdir(), "video-jobs-")));
const answer = (over: Partial<SandboxResult> = {}) => async (_run: SandboxRun): Promise<SandboxResult> => ({ exitCode: 0, timedOut: false, aborted: false, transcriptPath: "/t.log", ...over });

describe("runVideoTool", () => {
  it("runs the tool in the video image over the job dir, with no network and no credential", async () => {
    const seen: SandboxRun[] = [];
    const signal = new AbortController().signal;
    const result = await runVideoTool(async (run) => (seen.push(run), answer()(run)), {
      image: "video:1",
      id: "11111111-2222-3333-4444-555555555555",
      jobDir,
      tool: "narrate",
      args: ["--timeline", "/work/timeline.json", "--out", "/work/narration"],
      timeoutMs: 60_000,
      signal,
    });
    expect(result).toEqual({ ok: true, exitCode: 0, transcriptPath: "/t.log" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "luna-video-narrate-11111111",
      image: "video:1",
      runDir: join(jobDir, "runs", "narrate"),
      worktree: jobDir,
      writable: true,
      gitDir: null,
      input: {},
      timeoutMs: 60_000,
      credential: { env: {}, mounts: [] },
      labels: { luna: "video" },
      entrypoint: ["node", "/video-tools/tools/narrate.ts", "--timeline", "/work/timeline.json", "--out", "/work/narration"],
      networkNone: true,
      signal,
    });
  });

  it("is not ok on a non-zero exit, a timeout or an abort, and says which", async () => {
    const run = (over: Partial<SandboxResult>) => runVideoTool(answer(over), { image: "i", id: "abcdefgh", jobDir, tool: "compose", args: [], timeoutMs: 1, signal: new AbortController().signal });
    expect(await run({ exitCode: 3 })).toMatchObject({ ok: false, exitCode: 3 });
    expect(await run({ exitCode: null, timedOut: true })).toMatchObject({ ok: false, timedOut: true });
    expect(await run({ exitCode: null, aborted: true })).toMatchObject({ ok: false, aborted: true });
  });
});
