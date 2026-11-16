import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SandboxResult, SandboxRun } from "../adapters/docker/docker.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { runVideoTool, scanImages } from "./video-jobs.ts";

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

describe("the frames tool", () => {
  it("runs as a video job like the others", async () => {
    const seen: SandboxRun[] = [];
    await runVideoTool(async (run) => (seen.push(run), answer()(run)), { image: "video:1", id: "11111111-2222-3333-4444-555555555555", jobDir, tool: "frames", args: ["--video", "/work/walkthrough.mp4", "--out", "/work/qa"], timeoutMs: 60_000, signal: new AbortController().signal });
    expect(seen[0]).toMatchObject({ networkNone: true, credential: { env: {}, mounts: [] }, entrypoint: ["node", "/video-tools/tools/frames.ts", "--video", "/work/walkthrough.mp4", "--out", "/work/qa"] });
  });
});

describe("the policy's size on a video container", () => {
  const size = { cpu: 1, memoryGb: 2, pids: 200, runtime: "runsc", cacheTrust: "untrusted" as const };
  it("runs a tool on the limits it is given, and on none when it has none", async () => {
    const seen: SandboxRun[] = [];
    const base = { image: "v", id: "abcdefgh", jobDir, tool: "compose" as const, args: [], timeoutMs: 1, signal: new AbortController().signal };
    await runVideoTool(async (run) => (seen.push(run), answer()(run)), { ...base, limits: size });
    await runVideoTool(async (run) => (seen.push(run), answer()(run)), base);
    expect(seen[0]!.limits).toEqual(size);
    expect(seen[1]!.limits).toBeUndefined();
  });

  it("scans the images on the limits its deps name", async () => {
    const seen: SandboxRun[] = [];
    await scanImages({ image: "v", sandbox: async (run) => (seen.push(run), answer({ exitCode: 1 })(run)), limitsOf: async () => size }, { id: "shots", dir: jobDir, signal: new AbortController().signal });
    expect(seen[0]!.limits).toEqual(size);
  });
});

describe("scanImages", () => {
  const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "shots-")));
  const deps = (frames: unknown | null, ok = true) => ({
    image: "video:1",
    sandbox: async (run: SandboxRun): Promise<SandboxResult> => {
      if (frames !== null) {
        mkdirSync(join(run.worktree, "qa"), { recursive: true });
        writeFileSync(join(run.worktree, "qa", "frames.json"), typeof frames === "string" ? frames : JSON.stringify(frames));
      }
      return { exitCode: ok ? 0 : 1, timedOut: false, aborted: false, transcriptPath: "" };
    },
  });
  const signal = new AbortController().signal;

  it("runs frames --images over the folder and returns each image's text", async () => {
    const dir = folder();
    const out = await scanImages(deps({ frames: [{ file: "a.png", text: "Cart" }] }), { id: "t", dir, signal });
    expect(out).toEqual([{ file: "a.png", text: "Cart" }]);
  });

  it("carries the kinds the tool found in the whole text and whether the text was cut", async () => {
    const out = await scanImages(deps({ frames: [{ file: "a.png", text: "Cart", kinds: ["token"], truncated: true }, { file: "b.png", text: "x" }] }), { id: "t", dir: folder(), signal });
    expect(out).toEqual([{ file: "a.png", text: "Cart", kinds: ["token"], truncated: true }, { file: "b.png", text: "x" }]);
  });

  it("is null when the tool failed, wrote nothing, wrote nonsense, or wrote a file over 2 MiB", async () => {
    expect(await scanImages(deps({ frames: [] }, false), { id: "t", dir: folder(), signal })).toBeNull();
    expect(await scanImages(deps(null), { id: "t", dir: folder(), signal })).toBeNull();
    expect(await scanImages(deps("not json"), { id: "t", dir: folder(), signal })).toBeNull();
    expect(await scanImages(deps({ frames: [{ file: "a.png", text: "x".repeat(3 * 1024 * 1024) }] }), { id: "t", dir: folder(), signal })).toBeNull();
  });

  it("does not follow a frames.json that is a link", async () => {
    const dir = folder();
    const secret = join(dir, "..", `secret-${process.pid}.json`);
    writeFileSync(secret, JSON.stringify({ frames: [{ file: "a.png", text: "leak" }] }));
    const linked = { image: "video:1", sandbox: async (run: SandboxRun): Promise<SandboxResult> => {
      mkdirSync(join(run.worktree, "qa"), { recursive: true });
      const { symlinkSync } = await import("node:fs");
      symlinkSync(secret, join(run.worktree, "qa", "frames.json"));
      return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
    } };
    expect(await scanImages(linked, { id: "t", dir, signal })).toBeNull();
  });
});
