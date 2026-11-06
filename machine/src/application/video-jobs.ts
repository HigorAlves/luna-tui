// A tool of the runner-video image as a sandbox job (the graphify shape): the image's entrypoint
// replaced by `node /video-tools/tools/<tool>.ts`, the job dir mounted writable at /work, no network
// and no credential. The tools read and write only under /work; what they leave is read back by the host.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { readRegularFile } from "../adapters/fs/bounded.ts";
import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";

export type VideoTool = "narrate" | "cards" | "compose" | "measure" | "frames";

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

const FRAMES_MAX_BYTES = 2 * 1024 * 1024;
const FramesFile = z.object({ frames: z.array(z.object({ t: z.number().finite().optional(), file: z.string().max(200).optional(), text: z.string().max(4000) })).max(400) });
export type FramesRead = z.infer<typeof FramesFile>["frames"];

/** `qa/frames.json` as a container wrote it: a regular file of at most 2 MiB that parses; null otherwise (an old image, a link, nonsense). */
export async function readFrames(dir: string): Promise<FramesRead | null> {
  try {
    const parsed = FramesFile.safeParse(JSON.parse(await readRegularFile(join(dir, "qa", "frames.json"), FRAMES_MAX_BYTES)));
    return parsed.success ? parsed.data.frames : null;
  } catch {
    return null;
  }
}

/** Reads the text of the image files directly in `dir` with the frames tool (the folder is the job: it is mounted at /work). Null when the tool could not run. */
export async function scanImages(deps: { sandbox: (run: SandboxRun) => Promise<SandboxResult>; image: string }, run: { id: string; dir: string; signal: AbortSignal }): Promise<{ file: string; text: string }[] | null> {
  const done = await runVideoTool(deps.sandbox, { image: deps.image, id: run.id, jobDir: run.dir, tool: "frames", args: ["--images", "/work", "--out", "/work/qa"], timeoutMs: 15 * 60_000, signal: run.signal });
  if (!done.ok) return null;
  const frames = await readFrames(run.dir);
  return frames ? frames.flatMap((f) => (f.file !== undefined ? [{ file: f.file, text: f.text }] : [])) : null;
}
