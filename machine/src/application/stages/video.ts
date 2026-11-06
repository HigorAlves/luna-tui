// The video pipeline inside Evidence: a script and timeline from the director, the voice and the
// cards as jobs in the runner-video image, the recorder driving the approved steps, a compose and a
// measure job, and a cold critic; one fix round is allowed, and a film that still does not pass
// degrades the pack to captures. Containers run through `runVideoTool` (no network, no credential);
// model work is sub-runs of packs with derived run ids, as the plan stage does. Nothing a container or
// a model wrote is trusted as a path: every file read back is a regular file under the sub-run's own
// folder or the job dir (realpath, size cap), and the verdict is recomputed from the report's checks.
import { cp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { type EvidencePack, type FactoryConfig, PACKS, type QaTarget, type TestCase, type TriageRecord, type VideoContext, type VideoFixCard, VideoQaAnswer } from "@hardness/contracts";
import { z } from "zod";

import { safe as safeLine } from "../../domain/evidence-markdown.ts";

import { Timeline, checkTimeline } from "../../../runner-video/tools/lib/timeline.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { headCommit as worktreeHead, resetWorktree } from "../../adapters/git/worktree.ts";
import { copyRegularFile, readRegularFile } from "../../adapters/fs/bounded.ts";
import { type VideoTool, readFrames, runVideoTool } from "../video-jobs.ts";
import { screenFindings } from "../../domain/screen-text.ts";
import type { StageContext, StageResult } from "../ports.ts";
import type { AgentExtra } from "./pack-runner.ts";

type VideoPack = "video_script" | "recording" | "video_qa" | "video_fix";
type Media = EvidencePack["media"][number];
type PackVideo = NonNullable<EvidencePack["video"]>;

export interface VideoPipelineDeps {
  sandbox: (run: SandboxRun) => Promise<SandboxResult>;
  image: string;
  stateDir: string;
  runPack: (pack: VideoPack, context: StageContext, extra: AgentExtra) => Promise<StageResult>;
  /** The task worktree's head and a hard reset to a commit: a video sub-run that moved the branch is undone on the spot. Tests inject fakes. */
  git?: { head: (worktreePath: string) => Promise<string>; reset: (worktreePath: string, ref: string) => Promise<void> };
  log?: (line: string) => void;
  /** The repository's `evidence` section of luna.yaml (`policies.for(repo).factory.evidence`): the voice and the language. Absent, the defaults. */
  config?: (repoPath: string | null) => Promise<FactoryConfig["evidence"]>;
}

export interface VideoInput {
  scenarios: TestCase[];
  record: TriageRecord | null;
  pack: { summary: string; howToVerify: string; risk: VideoContext["pack"]["risk"] };
  /** The browser run's packet dir (`files/qa`): steps.jsonl and the manifest's chapters. */
  e2eDir: string | undefined;
  target: QaTarget | null;
  /** A person's send-back note as cards; with `previousJobDir` the pipeline starts at video_fix. */
  fixCards: VideoFixCard[];
  /** The earlier film's job dir: its script, narration and recording are reused. */
  previousJobDir?: string | null;
}

export type VideoOutcome =
  | { ok: true; video: PackVideo; media: Media[]; jobDir: string; usage: { turns: number; costUsd: number } }
  | { ok: false; reason: string; degrade: "captures"; video?: PackVideo; rateLimited?: boolean; usage: { turns: number; costUsd: number } };

export type VideoPipeline = (context: StageContext, input: VideoInput) => Promise<VideoOutcome>;

const MINUTE = 60_000;
// The smoke's twenty-second film took eleven minutes cold on a laptop CPU (kokoro and whisper, 240 card frames):
// a two-minute film with several cards needs room, and a job that hangs is still cut off well inside the stage's hour.
const TOOL_TIMEOUT: Record<VideoTool, number> = { narrate: 30 * MINUTE, cards: 30 * MINUTE, compose: 10 * MINUTE, measure: 20 * MINUTE, frames: 15 * MINUTE };
const SMALL = 2 * 1024 * 1024;
const NARRATION_MAX = 20 * 1024 * 1024;
const RECORDING_MAX = 4 * 1024 ** 3;
const STEPS_CAP = 400;
const TRANSCRIPT_CAP = 20_000;
const SHIP_SCORE = 8;
/** A `ship` the critic is less sure of than this counts as one more pass. */
const CONFIDENCE_MIN = 0.5;

const Marks = z.object({ marks: z.array(z.object({ scene: z.string(), t: z.number().finite().min(0) })) });
const Narration = z.object({ scenes: z.array(z.object({ id: z.string(), durationS: z.number().finite().min(0) })) });
const Report = z.object({ checks: z.array(z.object({ level: z.enum(["FAIL", "WARN"]), check: z.string(), detail: z.string() })) }).passthrough();

/** A regular file at `rel` under `root`, no larger than `max`; null otherwise. No link is followed anywhere on the way, even one that points inside the folder:
 *  the path that resolves must be the path that was asked for. The reads and copies that follow go through `bounded.ts`. */
async function trusted(root: string, rel: string, max: number): Promise<string | null> {
  try {
    const base = await realpath(root);
    const asked = join(base, rel);
    const real = await realpath(join(root, rel));
    if (real !== asked) return null;
    const info = await stat(real);
    return info.isFile() && info.size <= max ? real : null;
  } catch {
    return null;
  }
}

async function readJson(root: string, rel: string, max: number): Promise<unknown | null> {
  const path = await trusted(root, rel, max);
  if (!path) return null;
  try {
    return JSON.parse(await readRegularFile(path, max));
  } catch {
    return null;
  }
}

/** The voice the narrate job is told: a name of the shape `af_heart`, or none. */
const VOICE = /^[a-z]{2}_[a-z0-9]{1,30}$/;
/** The languages the image's speech models speak: English only. */
const LANGUAGES = new Set(["en", "en-us", "en-gb"]);

export function videoPipeline(deps: VideoPipelineDeps): VideoPipeline {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (context, input) => {
    const spent = { turns: 0, costUsd: 0 };
    const jobDir = join(deps.stateDir, "runs", `${context.runId}-video`);
    const note = (text: string) => void context.note?.(`video: ${text}`).catch(() => {});
    const fail = (reason: string, extra: { video?: PackVideo; rateLimited?: boolean } = {}): VideoOutcome => {
      note(`degraded to captures: ${reason}`);
      log(`video pipeline: ${reason}`);
      return { ok: false, reason, degrade: "captures", usage: { ...spent }, ...extra };
    };
    const sub = (suffix: string, engine?: StageContext["engine"], signal?: AbortSignal): StageContext => ({ ...context, runId: `${context.runId}-${suffix}`, started: undefined, resume: undefined, engine, ...(signal ? { signal } : {}) });
    const subFiles = (runId: string) => join(deps.stateDir, "runs", runId, "files", "video");
    const git = deps.git ?? { head: worktreeHead, reset: resetWorktree };
    const worktree = context.task.worktreePath ?? null;
    const run = async (pack: VideoPack, suffix: string, extra: AgentExtra, engine?: StageContext["engine"], signal?: AbortSignal) => {
      const subContext = sub(suffix, engine, signal);
      const before = worktree ? (await git.head(worktree)).trim() : null;
      let result = await deps.runPack(pack, subContext, extra);
      spent.turns += result.usage?.turns ?? 0;
      spent.costUsd += result.usage?.costUsd ?? 0;
      if (worktree && before !== null) {
        // These runs come after Verify: nothing they commit may reach the branch. The recorder also leaves its
        // demo spec in the worktree, so its run always ends in a reset to the head it found.
        const after = (await git.head(worktree)).trim();
        if (pack === "recording" || after !== before) await git.reset(worktree, before);
        if (after !== before) {
          result = { outcome: "fail", detail: { error: `the ${pack} run changed the branch's history (${before.slice(0, 7)} → ${after.slice(0, 7)}); the worktree was reset to ${before.slice(0, 7)}` } };
        }
      }
      return { result, dir: subFiles(subContext.runId) };
    };
    const tool = async (name: VideoTool, args: string[], signal: AbortSignal = context.signal) => {
      note(`${name}`);
      const done = await runVideoTool(deps.sandbox, { image: deps.image, id: context.task.id, jobDir, tool: name, args, timeoutMs: TOOL_TIMEOUT[name], signal });
      return done.ok ? null : `the ${name} job ${done.timedOut ? "timed out" : done.aborted ? "was aborted" : `failed (exit ${done.exitCode})`}`;
    };
    const why = (result: StageResult) => String(result.detail?.reason ?? result.detail?.error ?? result.detail?.summary ?? result.outcome);

    // The voice and the language, from the repository's luna.yaml. The voice becomes one argv element of the narrate job, so only its shape is let through.
    const evidenceConfig = await deps.config?.(context.task.repoPath ?? null).catch(() => null);
    const language = evidenceConfig?.tts.language?.trim().toLowerCase() ?? null;
    if (language !== null && !LANGUAGES.has(language)) return fail(`the video image speaks English only; evidence.tts.language is "${safeLine(evidenceConfig!.tts.language!)}"`);
    let voice: string | null = null;
    const wanted = evidenceConfig?.tts.voice ?? null;
    if (wanted !== null && VOICE.test(wanted)) voice = wanted;
    else if (wanted !== null) note("evidence.tts.voice is not a voice name (like af_heart): ignored, the default voice is used");
    if (voice === null && language === "en-gb") voice = "bf_emma";

    const budgetS = evidenceConfig?.video_budget_s ?? 240;
    const regenerate = evidenceConfig?.regenerate ?? 1;

    // What the browser run left: replayable steps and the chapters.
    const steps: string[] = [];
    let chapters: VideoContext["chapters"] = [];
    if (input.e2eDir) {
      const stepsPath = await trusted(input.e2eDir, "steps.jsonl", SMALL * 10);
      if (stepsPath) steps.push(...(await readRegularFile(stepsPath, SMALL * 10)).split("\n").filter((l) => l.trim() !== "").slice(0, STEPS_CAP));
      const manifest = (await readJson(input.e2eDir, "qa-manifest.json", SMALL * 10)) as { video?: { chapters?: { title?: unknown; start?: unknown }[] } } | null;
      const raw = Array.isArray(manifest?.video?.chapters) ? manifest!.video!.chapters! : ((await readJson(input.e2eDir, "chapters.json", SMALL)) as { title?: unknown; start?: unknown }[] | null) ?? [];
      chapters = (Array.isArray(raw) ? raw : []).flatMap((c) => (typeof c?.title === "string" && typeof c.start === "number" ? [{ title: c.title, start: c.start }] : []));
    }
    const base = (over: Partial<VideoContext> = {}): VideoContext => ({
      scenarios: input.scenarios,
      record: input.record,
      pack: input.pack,
      steps,
      chapters,
      target: input.target,
      narration: null,
      timeline: null,
      report: null,
      transcript: null,
      sheets: [],
      fixCards: [],
      budgetS,
      ...over,
    });
    const titles = input.scenarios.map((s) => s.title);

    await mkdir(jobDir, { recursive: true });
    let reuse = false;
    if (input.previousJobDir) {
      const runs = await realpath(join(deps.stateDir, "runs")).catch(() => null);
      const prev = await realpath(input.previousJobDir).catch(() => null);
      if (runs && prev && !relative(runs, prev).startsWith("..") && (await trusted(prev, "timeline.json", SMALL))) {
        await cp(prev, jobDir, { recursive: true, filter: (src) => src !== join(prev, "runs") });
        reuse = true;
      }
    }

    const scriptRound = async (pack: "video_script" | "video_fix", suffix: string, cards: VideoFixCard[], previous: unknown): Promise<{ timeline: Timeline } | { error: string; rateLimited?: boolean; problems?: string[] }> => {
      const { result, dir } = await run(pack, suffix, { video: base({ fixCards: cards, timeline: previous }) });
      if (result.rateLimited) return { error: `${pack} hit a usage limit`, rateLimited: true };
      if (result.outcome !== "pass") return { error: `${pack} ${result.outcome === "escalated" ? "escalated" : "did not finish"}: ${why(result)}` };
      const answer = result.detail?.answer as { timeline?: unknown } | undefined;
      const parsed = Timeline.safeParse((await readJson(dir, "timeline.json", SMALL)) ?? answer?.timeline);
      if (!parsed.success) return { error: `${pack} left no valid timeline: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
      const checked = checkTimeline(parsed.data, { scenarios: titles, maxS: budgetS });
      if (checked.errors.length > 0) return { error: `the timeline breaks its rules: ${checked.errors.join("; ")}`, problems: checked.errors };
      await writeFile(join(jobDir, "timeline.json"), JSON.stringify(parsed.data, null, 2));
      // The director has no file tool: the script rides in its answer (a file left by an older image is still read).
      const script = await trusted(dir, "script.md", SMALL);
      const text = script ? await readRegularFile(script, SMALL) : typeof (answer as { script?: unknown } | undefined)?.script === "string" ? ((answer as { script: string }).script).slice(0, SMALL) : null;
      if (text !== null) await writeFile(join(jobDir, "script.md"), text);
      return { timeline: parsed.data };
    };
    /** Script (or fix) with one more try when the timeline breaks the rules; the second error list rides as cards. */
    const scripted = async (pack: "video_script" | "video_fix", cards: VideoFixCard[], previous: unknown, tag: string) => {
      note(`${pack}`);
      let attempt = await scriptRound(pack, tag, cards, previous);
      if ("error" in attempt && attempt.problems) {
        const asCards = attempt.problems.map((text): VideoFixCard => ({ t: null, scene: null, element: null, text, priority: "P0" }));
        attempt = await scriptRound(pack, `${tag}-2`, [...cards, ...asCards], previous);
      }
      return attempt;
    };

    const narrationOf = async () => {
      const parsed = Narration.safeParse(await readJson(jobDir, "narration/narration.json", NARRATION_MAX));
      return parsed.success ? parsed.data.scenes.map((s) => ({ id: s.id, durationS: s.durationS })) : null;
    };

    /** The voice and the recording at the same time (D6), then compose and measure. A lane that fails aborts the other; the film degrades with the failing lane's reason. Returns an error, or null. */
    const render = async (timeline: Timeline, recordAgain: boolean, tag: string): Promise<{ error: string; rateLimited?: boolean } | null> => {
      // Both lanes answer to one controller, which the stage's own signal also trips.
      const lanes = new AbortController();
      const relay = () => lanes.abort();
      if (context.signal.aborted) lanes.abort();
      else context.signal.addEventListener("abort", relay, { once: true });
      let first: { error: string; rateLimited?: boolean } | null = null;
      const lane = async (work: () => Promise<{ error: string; rateLimited?: boolean } | null>) => {
        const failed = await work().catch((e): { error: string } => ({ error: e instanceof Error ? e.message : String(e) }));
        if (failed && !first) {
          first = failed;
          lanes.abort();
        }
      };
      const voiceArgs = voice === null ? [] : ["--voice", voice];
      // The recorder gets a copy of the timeline, made before the lanes start: `narrate` rewrites the job's own in place.
      const recIn = join(jobDir, "rec-in");
      const narrationLane = async () => {
        let error = await tool("narrate", ["--timeline", "/work/timeline.json", "--out", "/work/narration", ...voiceArgs], lanes.signal);
        if (error) return { error };
        error = await tool("cards", ["--timeline", "/work/timeline.json", "--narration", "/work/narration/narration.json", "--out", "/work/cards"], lanes.signal);
        if (error) return { error };
        return (await narrationOf()) ? null : { error: "the narration job left no narration.json" };
      };
      const recordingLane = async () => {
        note("recording");
        // No narration for the recorder: it paces by the timeline, which is all it is given.
        const { result, dir } = await run("recording", `record${tag}`, { video: base({ narration: null, timeline }), mounts: [{ host: recIn, container: "/video-job", readOnly: true }] }, undefined, lanes.signal);
        if (result.rateLimited) return { error: "recording hit a usage limit", rateLimited: true };
        const answer = result.detail?.answer as { kind?: string } | undefined;
        if (result.outcome !== "pass" || answer?.kind === "escalated") return { error: `the recording ${result.outcome === "pass" ? "escalated" : result.outcome}: ${why(result)}` };
        const timing = Marks.safeParse(await readJson(dir, "timing.json", SMALL));
        if (!timing.success) return { error: "the recorder left no usable timing.json" };
        const missing = timeline.scenes.filter((s) => s.kind === "demo" && !timing.data.marks.some((m) => m.scene === s.id)).map((s) => s.id);
        if (missing.length > 0) return { error: `the recorder marked no start for scene(s): ${missing.join(", ")}` };
        const recording = await trusted(dir, "recording.webm", RECORDING_MAX);
        if (!recording) return { error: "the recorder left no recording.webm" };
        await copyRegularFile(recording, join(jobDir, "recording.webm"));
        // compose reads the recording by its path in the container, which is ours, not the recorder's.
        await writeFile(join(jobDir, "timing.json"), JSON.stringify({ marks: timing.data.marks, videoPath: "/work/recording.webm" }, null, 2));
        return null;
      };
      try {
        if (recordAgain) {
          await mkdir(recIn, { recursive: true });
          await copyRegularFile(join(jobDir, "timeline.json"), join(recIn, "timeline.json"));
        }
        await Promise.all([lane(narrationLane), ...(recordAgain ? [lane(recordingLane)] : [])]);
      } finally {
        context.signal.removeEventListener("abort", relay);
      }
      if (first) return first;
      let error = await tool("compose", ["--job", "/work", "--max-s", String(budgetS)]);
      if (error) return { error };
      error = await tool("measure", ["--video", "/work/walkthrough.mp4", "--timeline", "/work/timeline.json", "--out", "/work/qa", "--max-s", String(budgetS)]);
      if (error) return { error };
      // The text on screen is read after measure. A tool that fails here (an image from before the frames tool) is "could not run", not a broken film.
      await tool("frames", ["--video", "/work/walkthrough.mp4", "--out", "/work/qa"]);
      return null;
    };

    interface Judged {
      shipped: boolean;
      answer: VideoQaAnswer | null;
      measured: VideoFixCard[];
      report: unknown;
      error?: string;
      rateLimited?: boolean;
    }
    let hitKinds: string[] = [];
    const judge = async (timeline: Timeline, tag: string): Promise<Judged> => {
      hitKinds = [];
      const reportRaw = await readJson(jobDir, "qa/report.json", SMALL * 10);
      const report = Report.safeParse(reportRaw);
      if (!report.success) return { shipped: false, answer: null, measured: [], report: null, error: "the measure job left no usable report.json" };
      const measured = report.data.checks.filter((c) => c.level === "FAIL").map((c): VideoFixCard => ({ t: null, scene: null, element: null, text: `measured ${c.check}: ${c.detail}`, priority: "P0" }));
      // The budget is the host's to hold, whatever the image's own check said.
      const film = (await readJson(jobDir, "meta.json", SMALL)) as { durationS?: unknown } | null;
      if (typeof film?.durationS === "number" && film.durationS > budgetS && !measured.some((m) => m.text.startsWith("measured duration"))) {
        measured.push({ t: null, scene: null, element: null, text: `measured duration: the film runs ${film.durationS}s, over the ${budgetS}s budget`, priority: "P0" });
      }
      const transcriptPath = await trusted(jobDir, "qa/transcript.txt", SMALL);
      const transcript = transcriptPath ? (await readRegularFile(transcriptPath, SMALL)).slice(0, TRANSCRIPT_CAP) : null;
      // What is on screen and in the narration is checked for what must not be shown. A hit is a measured P0 card (its kind and time, never its text).
      const read = await readFrames(jobDir);
      if (!read) return { shipped: false, answer: null, measured, report: reportRaw, error: "the frame check could not run" };
      const hits = screenFindings([...read.map((f) => ({ ...(f.t !== undefined ? { t: f.t } : {}), ...(f.file !== undefined ? { file: f.file } : {}), text: f.text })), ...(transcript !== null ? [{ file: "transcript", text: transcript }] : [])]);
      for (const hit of hits) measured.push({ t: null, scene: null, element: null, text: hit.place === "transcript" ? `a ${hit.kind} is in the narration: do not say it` : `a ${hit.kind} is on screen at ${hit.place}: do not show it`, priority: "P0" });
      hitKinds = [...new Set(hits.map((h) => h.kind))];
      const sheets: string[] = [];
      for (const name of ["beats_sheet.jpg", "hook_sheet.jpg", "phone_sheet.jpg"]) if (await trusted(jobDir, `qa/${name}`, 50 * 1024 * 1024)) sheets.push(`/evidence/qa/${name}`);
      // The critic reads the timeline beside the job's other files, at /evidence/timeline.json.
      const extra = (): AgentExtra => ({ video: base({ report: reportRaw, transcript, sheets, timeline, narration: null }), mounts: [{ host: jobDir, container: "/evidence", readOnly: true }] });
      note("video_qa");
      let { result } = await run("video_qa", `critic${tag}`, extra());
      if (result.rateLimited) {
        const fallback = PACKS.video_qa.engines.fallback?.[0];
        if (fallback) ({ result } = await run("video_qa", `critic${tag}-fb`, extra(), fallback));
      }
      if (result.rateLimited) return { shipped: false, answer: null, measured, report: reportRaw, error: "video_qa hit a usage limit", rateLimited: true };
      if (result.outcome !== "pass") return { shipped: false, answer: null, measured, report: reportRaw, error: `video_qa ${result.outcome}: ${why(result)}` };
      const answer = VideoQaAnswer.safeParse(result.detail?.answer);
      if (!answer.success) return { shipped: false, answer: null, measured, report: reportRaw, error: "video_qa gave no usable answer" };
      const a = answer.data;
      const shipped = a.verdict === "ship" && (a.confidence ?? 1) >= CONFIDENCE_MIN && Object.values(a.scores).every((s) => s >= SHIP_SCORE) && !a.defects.some((d) => d.priority === "P0") && measured.length === 0;
      return { shipped, answer: a, measured, report: reportRaw };
    };
    const cardsOf = (j: Judged): VideoFixCard[] => [
      ...(j.answer?.defects.filter((d) => d.priority !== "P2").map((d): VideoFixCard => ({ t: d.t, scene: d.scene, element: d.element, text: `${d.symptom}: ${d.fix}`, priority: d.priority })) ?? []),
      ...(j.answer && j.answer.verdict === "ship" && (j.answer.confidence ?? 1) < CONFIDENCE_MIN
        ? [{ t: null, scene: j.answer.weakestScene, element: null, text: `the critic was not sure (confidence ${j.answer.confidence}): check the weakest scene again`, priority: "P1" } as VideoFixCard]
        : []),
      ...j.measured,
    ];

    // ---- the run
    let timeline: Timeline;
    let fixes = 0;
    let recordNext = true;
    if (reuse) {
      const previous = Timeline.safeParse(await readJson(jobDir, "timeline.json", SMALL));
      if (!previous.success) return fail("the earlier film's timeline cannot be read");
      const fixed = await scripted("video_fix", input.fixCards, previous.data, "fix");
      if ("error" in fixed) return fail(fixed.error, { rateLimited: fixed.rateLimited });
      timeline = fixed.timeline;
      fixes = 1;
      recordNext = demoChanged(previous.data, timeline);
    } else {
      const first = await scripted("video_script", input.fixCards, null, "script");
      if ("error" in first) return fail(first.error, { rateLimited: first.rateLimited });
      timeline = first.timeline;
    }

    let rounds = 0;
    let judged: Judged;
    for (;;) {
      const rendered = await render(timeline, recordNext, fixes > 0 ? `-${fixes + 1}` : "");
      if (rendered) return fail(rendered.error, { rateLimited: rendered.rateLimited });
      judged = await judge(timeline, fixes > 0 ? `-${fixes + 1}` : "");
      rounds++;
      if (judged.error && !judged.answer) return fail(judged.error, { rateLimited: judged.rateLimited });
      if (judged.shipped) break;
      if (fixes >= regenerate) {
        const weakest = judged.answer?.weakestScene ?? "unknown";
        return fail(`the critic did not pass the ${fixes === 1 ? "second" : `last (${rounds})`} round: ${weakest}${hitKinds.length > 0 ? `; still on screen: ${hitKinds.join(", ")}` : ""}`, { video: await packVideo(judged, rounds, "degraded") });
      }
      const fixed = await scripted("video_fix", [...input.fixCards, ...cardsOf(judged)], timeline, fixes === 0 ? "fix" : `fix${fixes + 1}`);
      if ("error" in fixed) return fail(fixed.error, { rateLimited: fixed.rateLimited });
      recordNext = demoChanged(timeline, fixed.timeline);
      timeline = fixed.timeline;
      fixes++;
    }

    const video = await packVideo(judged, rounds, "ship");
    const media: Media[] = [];
    for (const [rel, kind, label] of [
      ["walkthrough.mp4", "video", "walkthrough.mp4"],
      ["cover.jpg", "cover", "cover.jpg"],
      ["captions.srt", "captions", "captions.srt"],
      ["captions.vtt", "captions", "captions.vtt"],
      ["chapters.json", "report", "chapters.json"],
      ["qa/transcript.txt", "report", "transcript.txt"],
      ["meta.json", "report", "meta.json"],
      ["qa/beats_sheet.jpg", "screenshot", "beats_sheet.jpg"],
    ] as const) {
      const path = await trusted(jobDir, rel, RECORDING_MAX);
      if (path) media.push({ kind, label, url: path });
    }
    note(`ready after ${rounds} round${rounds === 1 ? "" : "s"}`);
    return { ok: true, video, media, jobDir, usage: { ...spent } };

    async function packVideo(j: Judged, count: number, verdict: "ship" | "degraded"): Promise<PackVideo> {
      const meta = (await readJson(jobDir, "meta.json", SMALL)) as { durationS?: unknown } | null;
      const transcriptPath = await trusted(jobDir, "qa/transcript.txt", SMALL);
      return {
        file: "walkthrough.mp4",
        durationS: typeof meta?.durationS === "number" ? meta.durationS : timeline.meta.dur,
        verdict,
        scores: j.answer?.scores ?? {},
        defects: (j.answer?.defects ?? []).map((d) => ({ priority: d.priority, t: d.t, scene: d.scene, element: d.element, symptom: d.symptom, fix: d.fix })),
        rounds: count,
        ...(j.answer?.confidence !== undefined ? { confidence: j.answer.confidence } : {}),
        ...(transcriptPath ? { transcript: (await readRegularFile(transcriptPath, SMALL)).slice(0, 4000) } : {}),
      };
    }
  };
}

/** Whether a fix changed what the recording shows: a demo scene added, dropped or re-worded. */
function demoChanged(before: Timeline, after: Timeline): boolean {
  const key = (t: Timeline) => JSON.stringify(t.scenes.filter((s) => s.kind === "demo").map((s) => [s.id, s.title, s.text]));
  return key(before) !== key(after);
}
