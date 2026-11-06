import { existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import type { AgentExtra } from "./pack-runner.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type VideoInput, videoPipeline } from "./video.ts";

const scenarios = [
  { title: "A coupon applied twice counts once", criterion: "c1", approach: "apply twice" },
  { title: "The cart shows the discounted total", criterion: "c2", approach: "read the total" },
];
const timeline = (over: { demoText?: string; drop?: boolean } = {}) => ({
  meta: { w: 1920, h: 1080, fps: 30, dur: 60, clock: "voice", title: "Discounts", commit: "abc1234" },
  scenes: [
    { id: "hook", title: "Discounts", kind: "card", start: 0, end: 4, text: "The cart shows discounts.", card: { heading: "Discounts", role: "hook" } },
    { id: "add", title: scenarios[0]!.title, kind: "demo", start: 4, end: 30, text: over.demoText ?? "Apply the coupon twice and the total drops once." },
    ...(over.drop ? [] : [{ id: "total", title: scenarios[1]!.title, kind: "demo", start: 30, end: 56, text: "The total shows the price after the discount." }]),
    { id: "end", title: "Done", kind: "card", start: over.drop ? 30 : 56, end: over.drop ? 34 : 60, text: "That is the change.", card: { heading: "Shipped", role: "end" } },
  ].map((s, i, all) => ({ ...s, ...(over.drop ? { end: i === all.length - 1 ? 34 : s.end } : {}) })),
  texts: [{ role: "hook", text: "Discounts", px: 96, from: 0, to: 4 }],
  terms: ["coupon"],
  facts: [],
});
const badTimeline = () => ({ ...timeline(), texts: [{ role: "hook", text: "Discounts", px: 40, from: 0, to: 4 }] });
const scores = { hook: 9, clarity: 9, readability: 9, motion: 9, rhythm: 9, composition: 9, continuity: 9, truth: 9, sync: 9 };
const shipAnswer = { message: "ships", verdict: "ship", scores, defects: [], weakestScene: "add" };
const rejectAnswer = { message: "no", verdict: "one_more_pass", scores: { ...scores, hook: 5 }, defects: [{ priority: "P1", t: 2, scene: "hook", element: "heading", symptom: "too small", mechanism: "px 60", fix: "raise to 96 px" }], weakestScene: "hook" };

let root: string;
let stateDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "video-")));
  stateDir = join(root, "state");
  mkdirSync(stateDir);
});

function harness(opts: { scripts?: unknown[]; critics?: unknown[]; reports?: ("pass" | "fail")[]; recorder?: "ok" | "escalated" | "no-timing" | "symlink" | "inside-link"; heads?: string[]; answerOnly?: boolean; concurrent?: boolean; narrateFails?: boolean; narrateWaitsForAbort?: boolean; recorderWaitsForAbort?: boolean; config?: { voice?: string | null; language?: string | null; budgetS?: number; regenerate?: number }; metaDurationS?: number; frames?: unknown[] | "none" | "bad-tool"; transcript?: string; privacy?: { choice: string; confidence: number } | "throw" | "off" } = {}) {
  const calls: { pack: string; runId: string; extra: AgentExtra; at: number; signal?: AbortSignal }[] = [];
  const flags = { recordingBeforeNarrateReturned: false, recorderSawAbort: false, narrateSawAbort: false, recInTimelineAtStart: null as string | null };
  const heads = [...(opts.heads ?? [])];
  const git = { head: async () => heads.length > 1 ? heads.shift()! : (heads[0] ?? "aaa1111"), reset: vi.fn(async () => {}) };
  const tools: { tool: string; run: SandboxRun }[] = [];
  const scripts = [...(opts.scripts ?? [])];
  const critics = [...(opts.critics ?? [shipAnswer])];
  const reports = [...(opts.reports ?? ["pass"])];
  const files = (runId: string, entries: Record<string, string>) => {
    const dir = join(stateDir, "runs", runId, "files", "video");
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
  };
  const runPack = async (pack: string, sub: StageContext, extra: AgentExtra): Promise<StageResult> => {
    calls.push({ pack, runId: sub.runId, extra, at: calls.length + tools.length, ...(sub.signal ? { signal: sub.signal } : {}) });
    const usage = { turns: 2, costUsd: 0.25 };
    if (pack === "video_script" || pack === "video_fix") {
      const tl = scripts.length > 0 ? scripts.shift() : timeline();
      if (!opts.answerOnly) files(sub.runId, { "script.md": "# script", "timeline.json": JSON.stringify(tl) });
      return { outcome: "pass", usage, detail: { answer: { script: "# script", timeline: tl, facts: [], durationEstimateS: 60 } } };
    }
    if (pack === "recording") {
      if (opts.recorderWaitsForAbort) {
        await new Promise<void>((resolve) => (sub.signal?.aborted ? resolve() : sub.signal?.addEventListener("abort", () => resolve(), { once: true })));
        flags.recorderSawAbort = true;
        return { outcome: "fail", usage, detail: { error: "aborted" } };
      }
      if (opts.recorder === "escalated") return { outcome: "escalated", usage, detail: { reason: "the app will not start", answer: { kind: "escalated" } } };
      const marks = [{ scene: "add", t: 1 }, { scene: "total", t: 9 }];
      const mount = extra.mounts?.[0]?.host;
      if (mount) flags.recInTimelineAtStart = readFileSync(join(mount, "timeline.json"), "utf8");
      files(sub.runId, { ...(opts.recorder === "symlink" || opts.recorder === "inside-link" ? {} : { "recording.webm": "webm" }), ...(opts.recorder === "no-timing" ? {} : { "timing.json": JSON.stringify({ marks, videoPath: "/out/files/video/recording.webm" }) }) });
      if (opts.recorder === "symlink") symlinkSync(join(root, "state"), join(stateDir, "runs", sub.runId, "files", "video", "recording.webm"));
      // A link that stays inside the folder is still a link: it is not followed either.
      if (opts.recorder === "inside-link") symlinkSync(join(stateDir, "runs", sub.runId, "files", "video", "timing.json"), join(stateDir, "runs", sub.runId, "files", "video", "recording.webm"));
      return { outcome: "pass", usage, detail: { answer: { timing: { marks }, recordingPath: "/out/files/video/recording.webm", scenesRecorded: ["add", "total"] } } };
    }
    if (pack === "video_qa") return { outcome: "pass", usage, detail: { answer: critics.length > 1 ? critics.shift() : critics[0] } };
    throw new Error(`unexpected pack ${pack}`);
  };
  const sandbox = async (run: SandboxRun): Promise<SandboxResult> => {
    const tool = String(run.entrypoint?.[1]).split("/").pop()!.replace(".ts", "");
    tools.push({ tool, run });
    const job = run.worktree;
    if (tool === "narrate") {
      if (opts.concurrent) {
        for (let i = 0; i < 100 && !calls.some((c) => c.pack === "recording"); i++) await new Promise((r) => setTimeout(r, 5));
        flags.recordingBeforeNarrateReturned = calls.some((c) => c.pack === "recording");
      }
      if (opts.narrateWaitsForAbort) {
        await new Promise<void>((resolve) => (run.signal?.aborted ? resolve() : run.signal?.addEventListener("abort", () => resolve(), { once: true })));
        flags.narrateSawAbort = true;
        return { exitCode: null, timedOut: false, aborted: true, transcriptPath: "" };
      }
      if (opts.narrateFails) return { exitCode: 1, timedOut: false, aborted: false, transcriptPath: "" };
      mkdirSync(join(job, "narration"), { recursive: true });
      const tl = JSON.parse(readFileSync(join(job, "timeline.json"), "utf8")) as { scenes: { id: string }[] };
      writeFileSync(join(job, "narration", "narration.json"), JSON.stringify({ voice: "af_heart", scenes: tl.scenes.map((s) => ({ id: s.id, wav: `/work/narration/scene-${s.id}.norm.wav`, durationS: 5, words: [] })), captions: [] }));
    }
    if (tool === "cards") {
      mkdirSync(join(job, "cards"), { recursive: true });
      writeFileSync(join(job, "cards", "card-hook.mp4"), "mp4");
    }
    if (tool === "compose") {
      for (const f of ["walkthrough.mp4", "cover.jpg", "captions.srt", "captions.vtt", "chapters.json"]) writeFileSync(join(job, f), f);
      writeFileSync(join(job, "meta.json"), JSON.stringify({ durationS: opts.metaDurationS ?? 58.5 }));
    }
    if (tool === "frames") {
      if (opts.frames === "none" || opts.frames === "bad-tool") return { exitCode: opts.frames === "bad-tool" ? 1 : 0, timedOut: false, aborted: false, transcriptPath: "" };
      mkdirSync(join(job, "qa"), { recursive: true });
      writeFileSync(join(job, "qa", "frames.json"), JSON.stringify({ frames: Array.isArray(opts.frames) ? opts.frames : [{ t: 0, text: "Cart" }] }));
    }
    if (tool === "measure") {
      mkdirSync(join(job, "qa"), { recursive: true });
      const verdict = reports.length > 1 ? reports.shift() : reports[0];
      const checks = verdict === "fail" ? [{ level: "FAIL", check: "loudness", detail: "-9 LUFS, not -14 ± 1" }] : [];
      writeFileSync(join(job, "qa", "report.json"), JSON.stringify({ info: { durationS: 58.5, hasAudio: true }, picture: {}, audio: {}, checks, verdict: verdict === "fail" ? "fail" : "pass" }));
      writeFileSync(join(job, "qa", "transcript.txt"), opts.transcript ?? "apply the coupon twice");
      for (const f of ["beats_sheet.jpg", "hook_sheet.jpg", "phone_sheet.jpg"]) writeFileSync(join(job, "qa", f), f);
    }
    return { exitCode: 0, timedOut: false, aborted: false, transcriptPath: "" };
  };
  const notes: string[] = [];
  const config = async () => ({ video_budget_s: opts.config?.budgetS ?? 240, regenerate: opts.config?.regenerate ?? 1, tts: { voice: opts.config?.voice ?? null, language: opts.config?.language ?? null }, storage: "release_asset" as const, retention_days: 180 });
  const asked: { pack: string; check: unknown }[] = [];
  const decide = opts.privacy === "off" ? null : async (pack: string, check: unknown) => {
    asked.push({ pack, check });
    if (opts.privacy === "throw") throw new Error("down");
    const p = opts.privacy ?? { choice: "none", confidence: 0.9 };
    return { exposure: p };
  };
  const pipeline = videoPipeline({ decide: () => decide as never, sandbox, image: "video:1", stateDir, runPack, git, log: () => {}, ...(opts.config ? { config } : {}) });
  const worktree = join(root, "wt");
  const context = (runId = "run-1"): StageContext =>
    ({ task: { id: "11111111-2222-3333-4444-555555555555", worktreePath: worktree }, stage: "evidence", attempt: 1, runId, approvals: [], signal: new AbortController().signal, note: async (t: string) => void notes.push(t) }) as unknown as StageContext;
  const qa = join(root, "qa");
  mkdirSync(qa, { recursive: true });
  writeFileSync(join(qa, "steps.jsonl"), '{"scenario":"a","step":"click"}\n{"scenario":"a","step":"fill"}\n');
  writeFileSync(join(qa, "qa-manifest.json"), JSON.stringify({ video: { chapters: [{ title: "A", start: 0 }] } }));
  const input = (over: Partial<VideoInput> = {}): VideoInput => ({ scenarios, record: null, pack: { summary: "s", howToVerify: "h", risk: "low" }, e2eDir: qa, target: { name: "local", baseUrl: "http://127.0.0.1:3000", credential: null }, fixCards: [], ...over });
  return { pipeline, context, input, calls, tools, notes, git, worktree, flags, asked };
}

describe("videoPipeline", () => {
  it("resets the worktree after the recorder (its demo spec never lingers) and keeps the head it found", async () => {
    const h = harness();
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(true);
    expect(h.git.reset).toHaveBeenCalledTimes(1);
    expect(h.git.reset).toHaveBeenCalledWith(h.worktree, "aaa1111");
  });

  it("fails the film and resets the branch when a video sub-run moved the head: nothing an agent commits here reaches the PR", async () => {
    // Heads seen: before script, after script, before recording, after recording (moved).
    const h = harness({ heads: ["aaa1111", "aaa1111", "aaa1111", "bbb2222", "bbb2222"] });
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/recording.*changed the branch|history/i);
    expect(h.git.reset).toHaveBeenCalledWith(h.worktree, "aaa1111");
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "recording"]);
  });

  it("takes the script and the timeline from the director's answer: it has no tool that writes a file", async () => {
    const h = harness({ answerOnly: true });
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readFileSync(join(out.jobDir, "script.md"), "utf8")).toBe("# script");
    expect(JSON.parse(readFileSync(join(out.jobDir, "timeline.json"), "utf8"))).toMatchObject({ meta: { clock: "voice" } });
  });

  it("ships on the first round: script, narration, cards, recording, compose, measure, a cold critic", async () => {
    const h = harness();
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "recording", "video_qa"]);
    expect(h.tools.map((t) => t.tool)).toEqual(["narrate", "cards", "compose", "measure", "frames"]);
    expect(out.jobDir).toBe(join(stateDir, "runs", "run-1-video"));
    expect(out.video).toMatchObject({ file: "walkthrough.mp4", durationS: 58.5, verdict: "ship", rounds: 1, scores });
    expect(out.media.map((m) => [m.kind, m.label])).toEqual([
      ["video", "walkthrough.mp4"],
      ["cover", "cover.jpg"],
      ["captions", "captions.srt"],
      ["captions", "captions.vtt"],
      ["report", "chapters.json"],
      ["report", "transcript.txt"],
      ["report", "meta.json"],
      ["screenshot", "beats_sheet.jpg"],
    ]);
    for (const m of out.media) expect(existsSync(m.url)).toBe(true);
    expect(out.usage).toEqual({ turns: 6, costUsd: 0.75 });
    // every tool job: no network, no credential, the job dir as /work
    for (const t of h.tools) expect(t.run).toMatchObject({ networkNone: true, credential: { env: {}, mounts: [] }, writable: true, worktree: out.jobDir });
    // the script run saw the scenarios and the browser run's steps
    const script = h.calls[0]!.extra.video!;
    expect(script.scenarios).toEqual(scenarios);
    expect(script.steps).toEqual(['{"scenario":"a","step":"click"}', '{"scenario":"a","step":"fill"}']);
    expect(script.chapters).toEqual([{ title: "A", start: 0 }]);
    // the recorder got the target, the narration lengths and the job folder to read
    const rec = h.calls[1]!;
    expect(rec.extra.video!.target).toMatchObject({ name: "local" });
    // the recorder runs beside the voice: it has no narration, and mounts only a copy of the timeline
    expect(rec.extra.video!.narration).toBeNull();
    expect(rec.extra.mounts).toEqual([{ host: join(out.jobDir, "rec-in"), container: "/video-job", readOnly: true }]);
    // the critic reads the job folder read-only, with the report, the transcript and the sheets
    const critic = h.calls[2]!;
    expect(critic.extra.mounts).toEqual([{ host: out.jobDir, container: "/evidence", readOnly: true }]);
    expect(critic.extra.video).toMatchObject({ transcript: "apply the coupon twice", sheets: ["/evidence/qa/beats_sheet.jpg", "/evidence/qa/hook_sheet.jpg", "/evidence/qa/phone_sheet.jpg"] });
    expect((critic.extra.video!.report as { verdict: string }).verdict).toBe("pass");
  });

  it("runs one video_fix round on a measured FAIL, re-records nothing when no demo scene changed, then ships", async () => {
    const h = harness({ reports: ["fail", "pass"] });
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(true);
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "recording", "video_qa", "video_fix", "video_qa"]);
    expect(h.tools.map((t) => t.tool)).toEqual(["narrate", "cards", "compose", "measure", "frames", "narrate", "cards", "compose", "measure", "frames"]);
    expect(h.calls[3]!.extra.video!.fixCards).toEqual([expect.objectContaining({ priority: "P0", text: expect.stringMatching(/loudness/) })]);
    if (out.ok) expect(out.video.rounds).toBe(2);
  });

  it("re-records when the fix changed a demo scene", async () => {
    const h = harness({ reports: ["fail", "pass"], scripts: [timeline(), timeline({ demoText: "Apply the same coupon twice; the total changes once." })] });
    await h.pipeline(h.context(), h.input());
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "recording", "video_qa", "video_fix", "recording", "video_qa"]);
  });

  it("degrades after two critics that do not ship, keeping the scores and naming the weakest scene", async () => {
    const h = harness({ critics: [rejectAnswer] });
    const out = await h.pipeline(h.context(), h.input());
    expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/did not pass the second round: hook/) });
    if (!out.ok) expect(out.video).toMatchObject({ verdict: "degraded", rounds: 2, scores: { hook: 5 } });
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "recording", "video_qa", "video_fix", "video_qa"]);
    expect(h.calls[3]!.extra.video!.fixCards).toContainEqual(expect.objectContaining({ priority: "P1", scene: "hook", element: "heading", t: 2 }));
  });

  it("does not take a critic's ship while a score is under 8 or a P0 is open", async () => {
    const h = harness({ critics: [{ ...shipAnswer, scores: { ...scores, sync: 7 } }, shipAnswer] });
    const out = await h.pipeline(h.context(), h.input());
    expect(h.calls.map((c) => c.pack)).toContain("video_fix");
    expect(out.ok).toBe(true);
  });

  it("asks for the script twice when the timeline breaks a rule, then gives up before any tool runs", async () => {
    const h = harness({ scripts: [badTimeline(), badTimeline()] });
    const out = await h.pipeline(h.context(), h.input());
    expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/84/) });
    expect(h.calls.map((c) => c.pack)).toEqual(["video_script", "video_script"]);
    expect(h.calls[1]!.extra.video!.fixCards[0]!.text).toMatch(/84/);
    expect(h.tools).toEqual([]);
  });

  it("degrades when the recorder escalates, or leaves no timing", async () => {
    const escalated = harness({ recorder: "escalated" });
    expect(await escalated.pipeline(escalated.context(), escalated.input())).toMatchObject({ ok: false, reason: expect.stringMatching(/recording.*app will not start/) });
    const bare = harness({ recorder: "no-timing" });
    expect(await bare.pipeline(bare.context(), bare.input())).toMatchObject({ ok: false, reason: expect.stringMatching(/timing/) });
  });

  it("does not follow a recording the recorder linked to somewhere else", async () => {
    const h = harness({ recorder: "symlink" });
    expect(await h.pipeline(h.context(), h.input())).toMatchObject({ ok: false, reason: expect.stringMatching(/no recording/) });
  });

  it("re-enters at video_fix with a person's card, on the previous job's script, narration and recording", async () => {
    const first = harness();
    const done = await first.pipeline(first.context("run-1"), first.input());
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const again = harness({ critics: [shipAnswer] });
    // the same state dir: the previous job dir is there to copy
    const card = { t: 12.5, scene: "add", element: "cta", text: "the headline is cut off" };
    const out = await again.pipeline(again.context("run-2"), again.input({ fixCards: [card], previousJobDir: done.jobDir }));
    expect(out.ok).toBe(true);
    expect(again.calls.map((c) => c.pack)).toEqual(["video_fix", "video_qa"]);
    expect(again.calls[0]!.extra.video!.fixCards).toEqual([card]);
    expect((again.calls[0]!.extra.video!.timeline as { meta: { dur: number } }).meta.dur).toBe(60);
    if (out.ok) expect(out.jobDir).toBe(join(stateDir, "runs", "run-2-video"));
    expect(again.tools.map((t) => t.tool)).toEqual(["narrate", "cards", "compose", "measure", "frames"]);
  });

  it("hands compose its own path to the recording, never the one the recorder wrote", async () => {
    const h = harness();
    const out = await h.pipeline(h.context(), h.input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const timing = JSON.parse(readFileSync(join(out.jobDir, "timing.json"), "utf8")) as { videoPath: string };
    // what compose reads is the host's own path inside the container, never what the recorder wrote
    expect(timing.videoPath).toBe("/work/recording.webm");
  });

  describe("the two lanes at the same time", () => {
    it("starts the recording before the voice has returned, and awaits both", async () => {
      const h = harness({ concurrent: true });
      const out = await h.pipeline(h.context(), h.input());
      expect(out.ok).toBe(true);
      expect(h.flags.recordingBeforeNarrateReturned).toBe(true);
      expect(h.tools.map((t) => t.tool)).toEqual(["narrate", "cards", "compose", "measure", "frames"]);
    });

    it("gives the recorder a copy of the timeline in rec-in, read-only, since narrate rewrites the job's own", async () => {
      const h = harness();
      const out = await h.pipeline(h.context(), h.input());
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(JSON.parse(h.flags.recInTimelineAtStart!)).toMatchObject({ meta: { clock: "voice" } });
      expect(readFileSync(join(out.jobDir, "rec-in", "timeline.json"), "utf8")).toBe(h.flags.recInTimelineAtStart);
    });

    it("aborts the recording when the voice fails, and degrades with the voice's reason", async () => {
      const h = harness({ narrateFails: true, recorderWaitsForAbort: true });
      const out = await h.pipeline(h.context(), h.input());
      expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/narrate job failed/) });
      expect(h.flags.recorderSawAbort).toBe(true);
      expect(h.tools.map((t) => t.tool)).toEqual(["narrate"]);
    });

    it("aborts the voice when the recorder fails, and degrades with the recorder's reason", async () => {
      const h = harness({ recorder: "escalated", narrateWaitsForAbort: true });
      const out = await h.pipeline(h.context(), h.input());
      expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/recording.*app will not start/) });
      expect(h.flags.narrateSawAbort).toBe(true);
    });

    it("links both lanes to the stage's own signal", async () => {
      const h = harness({ narrateWaitsForAbort: true, recorderWaitsForAbort: true });
      const controller = new AbortController();
      const context = { ...h.context(), signal: controller.signal };
      const pending = h.pipeline(context, h.input());
      setTimeout(() => controller.abort(), 30);
      expect((await pending).ok).toBe(false);
      expect(h.flags.recorderSawAbort).toBe(true);
      expect(h.flags.narrateSawAbort).toBe(true);
    });
  });

  describe("the voice and the language come from luna.yaml", () => {
    const narrateArgs = (h: ReturnType<typeof harness>) => h.tools.find((t) => t.tool === "narrate")!.run.entrypoint!.slice(2);

    it("passes a voice that matches the pattern as --voice, an argv element of its own", async () => {
      const h = harness({ config: { voice: "af_sky" } });
      await h.pipeline(h.context(), h.input());
      const args = narrateArgs(h);
      expect(args.slice(args.indexOf("--voice"), args.indexOf("--voice") + 2)).toEqual(["--voice", "af_sky"]);
    });

    it("ignores a voice that does not match, with a note, and keeps the default", async () => {
      for (const voice of ["af_heart; rm -rf /", "../x", "AF_Heart", "a_b", "af_" + "x".repeat(40)]) {
        const h = harness({ config: { voice } });
        await h.pipeline(h.context(), h.input());
        expect(narrateArgs(h), voice).not.toContain("--voice");
        expect(h.notes.join("\n"), voice).toMatch(/voice.*ignored|default voice/i);
      }
    });

    it("takes en, en-US and en-GB, and en-GB with no voice picks bf_emma", async () => {
      for (const language of [null, "en", "en-US"]) {
        const h = harness({ config: { language } });
        expect((await h.pipeline(h.context(), h.input())).ok, String(language)).toBe(true);
        expect(narrateArgs(h)).not.toContain("--voice");
      }
      const gb = harness({ config: { language: "en-GB" } });
      await gb.pipeline(gb.context(), gb.input());
      expect(narrateArgs(gb)).toEqual(expect.arrayContaining(["--voice", "bf_emma"]));
      const own = harness({ config: { language: "en-GB", voice: "bf_isabella" } });
      await own.pipeline(own.context(), own.input());
      expect(narrateArgs(own)).toEqual(expect.arrayContaining(["--voice", "bf_isabella"]));
    });

    it("degrades before any container starts for another language, saying the image speaks English only", async () => {
      const h = harness({ config: { language: "pt-BR" } });
      const out = await h.pipeline(h.context(), h.input());
      expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/English only/) });
      expect(h.calls).toEqual([]);
      expect(h.tools).toEqual([]);
    });
  });

  it("does not follow a link inside the folder either: a recording that is a link to a sibling file is no recording", async () => {
    const h = harness({ recorder: "inside-link" });
    expect(await h.pipeline(h.context(), h.input())).toMatchObject({ ok: false, reason: expect.stringMatching(/no recording/) });
  });

  describe("the budget, the rounds and the critic's confidence", () => {
    const toolArgs = (h: ReturnType<typeof harness>, name: string) => h.tools.find((t) => t.tool === name)!.run.entrypoint!.slice(2);

    it("passes evidence.video_budget_s to compose and measure as --max-s, and the scripts as the context's budget", async () => {
      const h = harness({ config: { budgetS: 90 } });
      await h.pipeline(h.context(), h.input());
      for (const name of ["compose", "measure"]) expect(toolArgs(h, name).slice(toolArgs(h, name).indexOf("--max-s"), toolArgs(h, name).indexOf("--max-s") + 2)).toEqual(["--max-s", "90"]);
      expect(h.calls[0]!.extra.video!.budgetS).toBe(90);
    });

    it("turns a film longer than the budget into a measured P0 card, whatever the image said", async () => {
      const h = harness({ config: { budgetS: 60 }, metaDurationS: 61.5 });
      await h.pipeline(h.context(), h.input());
      const fix = h.calls.find((c) => c.pack === "video_fix");
      expect(fix!.extra.video!.fixCards).toContainEqual(expect.objectContaining({ priority: "P0", text: expect.stringMatching(/61\.5.*60/) }));
    });

    it("degrades at the first non-ship when evidence.regenerate is 0, and gives two fix rounds when it is 2", async () => {
      const none = harness({ config: { regenerate: 0 }, critics: [rejectAnswer] });
      expect(await none.pipeline(none.context(), none.input())).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pass/) });
      expect(none.calls.map((c) => c.pack)).toEqual(["video_script", "recording", "video_qa"]);
      const two = harness({ config: { regenerate: 2 }, critics: [rejectAnswer] });
      await two.pipeline(two.context(), two.input());
      expect(two.calls.filter((c) => c.pack === "video_fix")).toHaveLength(2);
    });

    it("counts a ship under 0.5 confidence as one more pass, and keeps the confidence on the film", async () => {
      const unsure = harness({ critics: [{ ...shipAnswer, confidence: 0.4 }, { ...shipAnswer, confidence: 0.9 }] });
      const out = await unsure.pipeline(unsure.context(), unsure.input());
      expect(unsure.calls.map((c) => c.pack)).toContain("video_fix");
      expect(out.ok && out.video.confidence).toBe(0.9);
      const sure = harness({ critics: [{ ...shipAnswer, confidence: 0.5 }] });
      const done = await sure.pipeline(sure.context(), sure.input());
      expect(sure.calls.map((c) => c.pack)).not.toContain("video_fix");
      expect(done.ok && done.video.confidence).toBe(0.5);
    });
  });

  describe("the frame check", () => {
    const token = "gh" + "p_" + "a".repeat(36);

    it("runs the frames tool after measure, bounded by the budget of 15 minutes", async () => {
      const h = harness();
      await h.pipeline(h.context(), h.input());
      const frames = h.tools.find((t) => t.tool === "frames")!;
      expect(frames.run.entrypoint!.slice(2)).toEqual(["--video", "/work/walkthrough.mp4", "--out", "/work/qa"]);
      expect(frames.run.timeoutMs).toBe(15 * 60_000);
      expect(h.tools.map((t) => t.tool).slice(-2)).toEqual(["measure", "frames"]);
    });

    it("turns a hit into a measured P0 card for the fix round, with the kind and the time and not the text", async () => {
      const h = harness({ frames: [{ t: 12.5, text: `key ${token}` }] });
      await h.pipeline(h.context(), h.input());
      const fix = h.calls.find((c) => c.pack === "video_fix")!;
      const card = fix.extra.video!.fixCards.find((c) => /on screen/.test(c.text))!;
      expect(card).toMatchObject({ priority: "P0", text: "a token is on screen at 12.5 s: do not show it" });
      expect(JSON.stringify(fix.extra.video)).not.toContain(token);
    });

    it("degrades when the hit is still there after the rounds, names the kind, and keeps the film out of the media", async () => {
      const h = harness({ frames: [{ t: 1, text: `mail jane@acme-corp.io` }] });
      const out = await h.pipeline(h.context(), h.input());
      expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/email/) });
      expect(JSON.stringify(out)).not.toContain("jane@");
      expect("media" in out).toBe(false);
    });

    it("checks the transcript too", async () => {
      const h = harness({ transcript: `my key is ${token}` });
      await h.pipeline(h.context(), h.input());
      const fix = h.calls.find((c) => c.pack === "video_fix")!;
      expect(fix.extra.video!.fixCards.some((c) => /token is on screen|token is in the narration/.test(c.text))).toBe(true);
    });

    it("degrades with 'the frame check could not run' when the image has no frames tool or leaves no frames.json", async () => {
      for (const frames of ["bad-tool", "none"] as const) {
        const h = harness({ frames });
        const out = await h.pipeline(h.context(), h.input());
        expect(out, frames).toMatchObject({ ok: false, degrade: "captures", reason: "the frame check could not run" });
        expect(h.calls.map((c) => c.pack)).not.toContain("video_qa");
      }
    });
  });

  describe("frame_privacy, after the pattern check found nothing", () => {
    it("asks once per film with the distinct on-screen texts, and ships on none at proceed", async () => {
      const h = harness({ frames: [{ t: 0, text: "Cart" }, { t: 2, text: "Cart" }, { t: 4, text: "Total $12" }] });
      const out = await h.pipeline(h.context(), h.input());
      expect(out.ok).toBe(true);
      expect(h.asked).toEqual([{ pack: "frame_privacy", check: { kind: "frames", frames: { texts: ["Cart", "Total $12"] } } }]);
    });

    it("turns a credential into a P0 card for the fix round, then degrades with the kind, never the text", async () => {
      const h = harness({ privacy: { choice: "credential", confidence: 0.9 } });
      const out = await h.pipeline(h.context(), h.input());
      const fix = h.calls.find((c) => c.pack === "video_fix")!;
      expect(fix.extra.video!.fixCards).toContainEqual(expect.objectContaining({ priority: "P0", text: expect.stringMatching(/credential/) }));
      expect(out).toMatchObject({ ok: false, degrade: "captures", reason: expect.stringMatching(/credential/) });
    });

    it("counts none under the proceed bar as a card too", async () => {
      const h = harness({ privacy: { choice: "none", confidence: 0.6 } });
      await h.pipeline(h.context(), h.input());
      expect(h.calls.map((c) => c.pack)).toContain("video_fix");
    });

    it("is not asked when a pattern already hit", async () => {
      const token = "gh" + "p_" + "a".repeat(36);
      const h = harness({ frames: [{ t: 1, text: token }] });
      await h.pipeline(h.context(), h.input());
      expect(h.asked).toEqual([]);
    });

    it("keeps the pattern check and says the text was not judged when there is no decision or it fails", async () => {
      for (const privacy of ["off", "throw"] as const) {
        const h = harness({ privacy });
        const out = await h.pipeline(h.context(), h.input());
        expect(out.ok, privacy).toBe(true);
        expect(out.ok && out.note).toMatch(/on-screen text was not judged/);
      }
    });
  });
});
