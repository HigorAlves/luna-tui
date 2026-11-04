// A tool of the runner-video image as a sandbox job (the graphify shape): the image's entrypoint
// replaced by `node /video-tools/tools/<tool>.ts`, the job dir mounted writable at /work, no network
// and no credential. The tools read and write only under /work; what they leave is read back by the host.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";

export type VideoTool = "narrate" | "cards" | "compose" | "measure";

export interface VideoToolRun {
  image: string;
  /** The task id: names the container. */
  id: string;
  jobDir: string;
  tool: VideoTool;
  args: string[];
  timeoutMs: number;
  signal: AbortSignal;
}

export interface VideoToolResult {
  ok: boolean;
  exitCode: number | null;
  transcriptPath: string;
  timedOut?: true;
  aborted?: true;
}

export async function runVideoTool(sandbox: (run: SandboxRun) => Promise<SandboxResult>, run: VideoToolRun): Promise<VideoToolResult> {
  const runDir = join(run.jobDir, "runs", run.tool);
  await mkdir(runDir, { recursive: true });
  const result = await sandbox({
    name: `luna-video-${run.tool}-${run.id.slice(0, 8)}`,
    image: run.image,
    runDir,
    worktree: run.jobDir,
    writable: true,
    gitDir: null,
    input: {},
    timeoutMs: run.timeoutMs,
    credential: { env: {}, mounts: [] },
    labels: { luna: "video" },
    entrypoint: ["node", `/video-tools/tools/${run.tool}.ts`, ...run.args],
    // Rendering and measuring need no network at all.
    networkNone: true,
    signal: run.signal,
  });
  return {
    ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
    exitCode: result.exitCode,
    transcriptPath: result.transcriptPath,
    ...(result.timedOut ? { timedOut: true as const } : {}),
    ...(result.aborted ? { aborted: true as const } : {}),
  };
}
