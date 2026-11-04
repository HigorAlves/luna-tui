import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { type EvidenceStageDeps, evidenceRunner, evidenceStage } from "./evidence.ts";
import type { VideoInput, VideoOutcome } from "./video.ts";
import type { StageContext } from "../ports.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "evidence-"));
});

const context = { task: { id: "t1" }, stage: "evidence", attempt: 1, runId: "ev", approvals: [] } as unknown as StageContext;

function qaDir(runId = "e2e-run"): string {
  const dir = join(stateDir, "runs", runId, "files", "qa");
  mkdirSync(dir, { recursive: true });
  return dir;
}
const runner = (e2e: { runId: string; detail?: Record<string, unknown> } | null) =>
  evidenceRunner({ stateDir, latestE2e: async () => e2e });

describe("evidenceRunner: one manifest row per approved scenario", () => {
  const scenarios = [
    { title: "Rejects a bad password", criterion: "no crash", approach: "Given a user, When a bad password is sent, Then 401" },
    { title: "Shows the export button", criterion: null, approach: "Given a report, When opened, Then the button shows" },
  ];
  const approved = {
    ...context,
    approvals: [{ kind: "awaiting_approval", decision: "approved", requested: { cases: scenarios } }],
  } as unknown as StageContext;
  const row = (text: string, result = "pass") => ({ text, result, evidence: [] });
  const write = (manifest: Record<string, unknown>) => writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "pass", ...manifest }));

  it("reads a manifest that is JSON null as unreadable instead of crashing", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), "null");
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ verdict: "unreadable" });
  });

  it("passes when every scenario has its row and chapter, and lists them with the chapter start", async () => {
    write({ acceptance: [row(scenarios[0]!.title), row(scenarios[1]!.title, "partial")], video: { file: "qa.webm", chapters: [{ title: scenarios[0]!.title, start: 0 }, { title: scenarios[1]!.title, start: 12.5 }] } });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("pass");
    expect(result.detail?.evidence).toMatchObject({
      rows: 2,
      scenarios: [
        { text: scenarios[0]!.title, criterion: "no crash", result: "pass", chapter: 0 },
        { text: scenarios[1]!.title, criterion: null, result: "partial", chapter: 12.5 },
      ],
    });
  });

  it("fails naming the scenario that has no manifest row", async () => {
    write({ acceptance: [row(scenarios[0]!.title)] });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ verdict: "partial", error: `1 approved scenario(s) have no manifest row: ${scenarios[1]!.title}` });
  });

  it("matches titles verbatim: a reworded row is a missing one", async () => {
    write({ acceptance: [row("rejects a bad password"), row(scenarios[1]!.title)] });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.detail?.error).toContain(scenarios[0]!.title);
  });

  it("fails naming the scenario that has no chapter when the manifest has a video", async () => {
    write({ acceptance: [row(scenarios[0]!.title), row(scenarios[1]!.title)], video: { file: "qa.webm", chapters: [{ title: scenarios[0]!.title, start: 0 }] } });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: `1 approved scenario(s) have no video chapter: ${scenarios[1]!.title}` });
  });

  it("needs no chapter without a video, and keeps a fail verdict a fail", async () => {
    write({ acceptance: [row(scenarios[0]!.title), row(scenarios[1]!.title)] });
    expect((await runner({ runId: "e2e-run" })(approved)).outcome).toBe("pass");
    write({ verdict: "fail", acceptance: [row(scenarios[0]!.title, "fail")] });
    expect((await runner({ runId: "e2e-run" })(approved)).detail).toMatchObject({ verdict: "fail" });
  });

  it("behaves as before for a legacy manifest and no approved scenarios", async () => {
    write({});
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).not.toHaveProperty("error");
  });

  it("asks nothing of a skipped manifest", async () => {
    write({ verdict: "skipped" });
    expect((await runner({ runId: "e2e-run" })(approved)).outcome).toBe("pass");
  });
});

describe("evidenceRunner", () => {
  it("passes on a pass manifest and lists artifacts and thumbnails", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "pass" }));
    for (const f of ["a.png", "b.png", "c.png", "d.png"]) writeFileSync(join(dir, f), f);
    writeFileSync(join(dir, "walk.webm"), "v");
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "evidence",
      verdict: "pass",
      artifactCount: 6,
      manifestPath: join(dir, "qa-manifest.json"),
      thumbnails: [join(dir, "a.png"), join(dir, "b.png"), join(dir, "c.png")],
    });
    expect(result.detail?.evidence).toEqual({
      verdict: "pass",
      artifactCount: 6,
      manifest: join(dir, "qa-manifest.json"),
      thumbnails: [join(dir, "a.png"), join(dir, "b.png"), join(dir, "c.png")],
    });
    expect(result.artifacts).toHaveLength(6);
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "qa-manifest", path: join(dir, "qa-manifest.json"), label: "qa-manifest.json" }),
    );
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "video", label: "walk.webm" }));
    expect(result.artifacts?.every((a) => a.sha256.length === 64)).toBe(true);
  });

  it("fails on a fail manifest", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "fail" }));
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ step: "evidence", verdict: "fail" });
  });

  it("fails on a partial manifest and on an unreadable one", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "partial" }));
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("fail");
    writeFileSync(join(dir, "qa-manifest.json"), "{not json");
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("fail");
  });

  it("passes a skipped manifest", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "skipped" }));
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "skipped" });
  });

  it("passes with the same note when e2e was skipped and left no manifest", async () => {
    const result = await runner({ runId: "e2e-run", detail: { skipped: true, reason: "no web surface detected" } })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "evidence",
      verdict: "skipped",
      artifactCount: 0,
      note: "e2e skipped: no web surface detected",
    });
  });

  it("fails with no manifest when e2e did not skip", async () => {
    const result = await runner({ runId: "e2e-run", detail: { verdict: "pass" } })(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ step: "evidence", error: expect.stringContaining("qa-manifest.json") });
  });

  it("fails when there is no e2e run at all", async () => {
    expect((await runner(null)(context)).outcome).toBe("fail");
  });
});

describe("evidenceStage", () => {
  const scenarios = [
    { title: "Total shows after adding an item", criterion: "total visible", approach: "Given a cart, When an item is added, Then the total shows" },
    { title: "Empty cart shows zero", criterion: null, approach: "Given an empty cart, Then 0" },
  ];
  const record = { source: "github", kind: "feature", goal: "Show the cart total", size: "small", urgency: "normal", risk: "low", signals: {}, qa: [], decision: "plan", reason: "r", at: "2026-11-03T00:00:00.000Z", model: "m" };
  const taskContext = (over: Record<string, unknown> = {}, approvals: unknown[] = []) =>
    ({
      task: { id: "t1", title: "Cart total", description: "d", repoPath: "/repo", worktreePath: "/wt", record, evidence: null, ...over },
      stage: "evidence",
      attempt: 1,
      runId: "ev",
      approvals: [{ kind: "awaiting_approval", decision: "approved", requested: { brief: "b", criteria: ["c"], rollback: "Revert the merge.", cases: scenarios, risk: { level: "medium", scores: {} } } }, ...approvals],
    }) as unknown as StageContext;
  const row = (text: string, result = "pass") => ({ text, result, evidence: [`qa-cart.webm#t=0`, "trace.zip"] });
  /** A browser run with a manifest, two screenshots, a stitched recording, the HAR and replayable steps. */
  function browserRun(manifest: Record<string, unknown> = {}) {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "pass", target: { name: "local", baseUrl: "http://user:secret@localhost:3000/app" }, acceptance: scenarios.map((s) => row(s.title)), video: { file: "qa-cart.webm", chapters: scenarios.map((s, i) => ({ title: s.title, start: i * 5 })) }, ...manifest }));
    writeFileSync(join(dir, "a.png"), "a");
    writeFileSync(join(dir, "b.png"), "b");
    writeFileSync(join(dir, "qa-cart.webm"), "v");
    writeFileSync(join(dir, "qa-cart.har"), "{}");
    writeFileSync(join(dir, "steps.jsonl"), "{}\n");
    return dir;
  }
  const finishes: Record<string, { runId: string; detail?: Record<string, unknown> }> = {
    e2e: { runId: "e2e-run" },
    verifying: { runId: "v1", detail: { findings: [{ path: "web/cart.tsx", line: 4, severity: "should_fix", title: "memoise the total", body: "b", confidence: 0.6 }] } },
    implementing: { runId: "i1", detail: { answer: { kind: "done", summary: "s", outOfMap: [{ path: "web/format.ts", reason: "shared helper" }] }, scope: { facts: { changed: ["web/cart.tsx", "web/format.ts"] } } } },
  };
  function stage(over: Partial<EvidenceStageDeps> = {}) {
    const saved: Array<[string, unknown]> = [];
    const asked: Array<[unknown, string | null]> = [];
    const deps: EvidenceStageDeps = {
      stateDir,
      latestE2e: async () => finishes.e2e!,
      latestFinish: async (_id, name) => finishes[name] ?? null,
      save: async (id, patch) => void saved.push([id, patch]),
      decideFormat: async (ctx, repoPath) => {
        asked.push([ctx, repoPath]);
        return { format: { choice: "captures", confidence: 0.9 } };
      },
      policies: { for: async () => ({ decisions: {}, qaTargets: [{ name: "local", baseUrl: "http://localhost:3000/app", credential: null }] }) },
      headCommit: async () => "abc1234def",
      videoImage: async () => false,
      now: () => new Date("2026-11-04T10:00:00.000Z"),
      ...over,
    };
    return { run: evidenceStage(deps), saved, asked };
  }

  it("still runs the prelude: a missing manifest fails as before and nothing is saved", async () => {
    const { run, saved, asked } = stage();
    const result = await run(taskContext());
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ verdict: "missing" });
    expect(saved).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("a manifest gap fails and saves no pack", async () => {
    browserRun({ acceptance: [row(scenarios[0]!.title)] });
    const { run, saved } = stage();
    expect((await run(taskContext())).outcome).toBe("fail");
    expect(saved).toEqual([]);
  });

  it("hands the decision the record, the risk from the approval, the surface, the browser run and the changed files", async () => {
    browserRun();
    const { run, asked } = stage({ videoImage: async () => true });
    await run(taskContext());
    expect(asked).toHaveLength(1);
    expect(asked[0]![1]).toBe("/repo");
    expect(asked[0]![0]).toEqual({ record, risk: "medium", webSurface: true, e2e: { ran: true, verdict: "pass", hasVideo: true, hasSteps: true, scenarios: 2, skippedReason: null }, videoImage: true, changed: ["web/cart.tsx", "web/format.ts"] });
  });

  it("assembles a captures pack, keeps its media locally and saves it on the task", async () => {
    const dir = browserRun();
    const { run, saved } = stage();
    const result = await run(taskContext());
    expect(result.outcome).toBe("pass");
    expect(saved).toHaveLength(1);
    const [taskId, patch] = saved[0]! as [string, { evidence: Record<string, any> }];
    const pack = patch.evidence;
    expect(taskId).toBe("t1");
    expect(pack).toMatchObject({ format: "captures", risk: "medium", rollback: "Revert the merge.", commitSha: "abc1234def", at: "2026-11-04T10:00:00.000Z", howToVerify: "http://localhost:3000/app", outOfMap: ["web/format.ts: shared helper"], findings: ["should_fix: memoise the total (web/cart.tsx:4)"] });
    expect(pack.scenarios).toEqual([
      { text: scenarios[0]!.title, test: "qa-cart.webm#t=0", result: "pass" },
      { text: scenarios[1]!.title, test: "qa-cart.webm#t=0", result: "pass" },
    ]);
    const store = join(stateDir, "evidence", "t1", "abc1234def");
    expect(pack.media.map((m: { kind: string; label: string }) => [m.kind, m.label]).sort()).toEqual([["report", "qa-cart.har"], ["report", "qa-manifest.json"], ["screenshot", "a.png"], ["screenshot", "b.png"], ["video", "qa-cart.webm"]]);
    for (const m of pack.media as { url: string }[]) {
      expect(m.url.startsWith(store + "/")).toBe(true);
      expect(existsSync(m.url)).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(store, "pack.json"), "utf8"))).toEqual(pack);
    expect(existsSync(join(dir, "a.png"))).toBe(true);
  });

  it("puts the format, summary, media, commit and scenarios in the ship gate's requested.evidence beside today's fields", async () => {
    browserRun();
    const { run, saved } = stage();
    const result = await run(taskContext());
    const pack = (saved[0]![1] as { evidence: Record<string, unknown> }).evidence;
    expect(result.detail).toMatchObject({ step: "evidence", verdict: "pass", format: "captures", pack });
    expect(result.detail?.evidence).toMatchObject({
      verdict: "pass",
      artifactCount: 6,
      format: "captures",
      summary: pack.summary,
      commitSha: "abc1234def",
      rows: 2,
      scenarios: [expect.objectContaining({ text: scenarios[0]!.title, result: "pass" }), expect.objectContaining({ text: scenarios[1]!.title })],
      media: (pack.media as { label: string; url: string }[]).map((m) => ({ label: m.label, url: m.url })),
    });
    expect(result.detail?.evidence).not.toHaveProperty("note");
  });

  it("degrades video to captures with a note when the video image is absent", async () => {
    browserRun();
    const { run, saved } = stage({ decideFormat: async () => ({ format: { choice: "video", confidence: 0.95 } }), videoImage: async () => false });
    const result = await run(taskContext());
    expect(result.outcome).toBe("pass");
    const pack = (saved[0]![1] as { evidence: { format: string; note?: string } }).evidence;
    expect(pack.format).toBe("captures");
    expect(pack.note).toMatch(/video image/);
    expect(result.detail?.evidence).toMatchObject({ format: "captures", note: expect.stringMatching(/video image/) });
  });

  it("degrades video to captures when the image exists but the browser run left neither a recording nor steps", async () => {
    browserRun({ video: null });
    rmSyncIfThere(join(qaDir(), "steps.jsonl"));
    rmSyncIfThere(join(qaDir(), "qa-cart.webm"));
    const { run, saved } = stage({ decideFormat: async () => ({ format: { choice: "video", confidence: 0.95 } }), videoImage: async () => true });
    await run(taskContext());
    const pack = (saved[0]![1] as { evidence: { format: string; note?: string } }).evidence;
    expect(pack.format).toBe("captures");
    expect(pack.note).toMatch(/recording|steps/);
  });

  it("degrades video to captures with a note while the pipeline is not wired, even with the image and a recording", async () => {
    browserRun();
    const { run, saved } = stage({ decideFormat: async () => ({ format: { choice: "video", confidence: 0.95 } }), videoImage: async () => true });
    await run(taskContext());
    const pack = (saved[0]![1] as { evidence: { format: string; note?: string } }).evidence;
    expect(pack).toMatchObject({ format: "captures", note: "the video pipeline is not wired" });
  });

  describe("the video format", () => {
    const videoVerdict = { file: "walkthrough.mp4", durationS: 58.5, verdict: "ship" as const, scores: { hook: 9 }, defects: [], rounds: 1 };
    /** A pipeline that leaves a job dir with a walkthrough and a cover, as the real one does. */
    function pipeline(outcome?: Partial<VideoOutcome> & { ok?: boolean }) {
      const calls: VideoInput[] = [];
      const fn = async (_context: StageContext, input: VideoInput): Promise<VideoOutcome> => {
        calls.push(input);
        if (outcome?.ok === false) return { ok: false, reason: "the critic did not pass the second round: hook", degrade: "captures", usage: { turns: 4, costUsd: 0.5 }, ...(outcome as object) } as VideoOutcome;
        const jobDir = join(stateDir, "runs", "ev-video");
        mkdirSync(jobDir, { recursive: true });
        writeFileSync(join(jobDir, "walkthrough.mp4"), "mp4");
        writeFileSync(join(jobDir, "cover.jpg"), "jpg");
        return { ok: true, video: videoVerdict, jobDir, usage: { turns: 6, costUsd: 0.75 }, media: [{ kind: "video", label: "walkthrough.mp4", url: join(jobDir, "walkthrough.mp4") }, { kind: "cover", label: "cover.jpg", url: join(jobDir, "cover.jpg") }] };
      };
      return { fn, calls };
    }
    const wantVideo = { decideFormat: async () => ({ format: { choice: "video", confidence: 0.95 } }), videoImage: async () => true };

    it("runs the pipeline on the approved scenarios and the browser run's facts, and puts the film and its media on the pack", async () => {
      browserRun();
      const p = pipeline();
      const { run, saved } = stage({ ...wantVideo, video: p.fn });
      const result = await run(taskContext());
      expect(result.outcome).toBe("pass");
      expect(p.calls).toHaveLength(1);
      expect(p.calls[0]).toMatchObject({ scenarios, record, pack: { risk: "medium", howToVerify: "http://localhost:3000/app" }, e2eDir: qaDir(), target: { name: "local" }, fixCards: [], previousJobDir: null });
      const pack = (saved[0]![1] as { evidence: { format: string; video: unknown; media: { kind: string; label: string; url: string }[]; note?: string } }).evidence;
      expect(pack.format).toBe("video");
      expect(pack.video).toEqual(videoVerdict);
      expect(pack.note).toBeUndefined();
      expect(pack.media.map((m) => m.label)).toEqual(expect.arrayContaining(["walkthrough.mp4", "cover.jpg", "a.png", "qa-manifest.json"]));
      const film = pack.media.find((m) => m.label === "walkthrough.mp4")!;
      expect(film.kind).toBe("video");
      expect(existsSync(film.url)).toBe(true);
      expect(film.url).toContain(join("evidence", "t1", "abc1234def"));
      expect(result.detail?.evidence).toMatchObject({ format: "video", video: videoVerdict });
      expect(result.usage).toEqual({ turns: 6, costUsd: 0.75 });
    });

    it("falls back to captures with the pipeline's reason, keeping the critic's scores on the pack", async () => {
      browserRun();
      const degraded = { ...videoVerdict, verdict: "degraded" as const, rounds: 2 };
      const p = pipeline({ ok: false, video: degraded });
      const { run, saved } = stage({ ...wantVideo, video: p.fn });
      const result = await run(taskContext());
      expect(result.outcome).toBe("pass");
      const pack = (saved[0]![1] as { evidence: { format: string; note?: string; video: unknown; media: { label: string }[] } }).evidence;
      expect(pack).toMatchObject({ format: "captures", note: "the critic did not pass the second round: hook", video: degraded });
      expect(pack.media.map((m) => m.label)).not.toContain("walkthrough.mp4");
      expect(result.usage).toEqual({ turns: 4, costUsd: 0.5 });
    });

    it("pauses the stage when a pipeline run hit a usage limit", async () => {
      browserRun();
      const p = pipeline({ ok: false, rateLimited: true, reason: "video_qa hit a usage limit" });
      const { run, saved } = stage({ ...wantVideo, video: p.fn });
      const result = await run(taskContext());
      expect(result).toMatchObject({ outcome: "fail", rateLimited: true });
      expect(saved).toEqual([]);
    });

    it("skips the pipeline for a target that must not be driven twice", async () => {
      browserRun();
      const p = pipeline();
      const { run, saved } = stage({ ...wantVideo, video: p.fn, policies: { for: async () => ({ decisions: {}, qaTargets: [{ name: "local", baseUrl: "http://localhost:3000/app", credential: null, reentrant: false }] }) } });
      await run(taskContext());
      expect(p.calls).toEqual([]);
      expect(saved[0]![1]).toMatchObject({ evidence: { format: "captures", note: "the QA target is not re-entrant" } });
    });

    it("turns a send-back note into a fix card and reuses the previous film's job dir", async () => {
      browserRun();
      mkdirSync(join(stateDir, "runs", "ev-prev-video"), { recursive: true });
      const p = pipeline();
      const previous = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1234", media: [], at: "2026-11-03T00:00:00.000Z" };
      const { run } = stage({ ...wantVideo, video: p.fn, latestFinish: async (_id, name) => (name === "evidence" ? { runId: "ev-prev" } : (finishes[name] ?? null)) });
      const sentBack = { kind: "awaiting_ship", decision: "sent_back", reason: "t=12.5 scene=add el=cta the headline is cut off" };
      await run(taskContext({ evidence: previous }, [sentBack]));
      expect(p.calls[0]!.fixCards).toEqual([{ t: 12.5, scene: "add", element: "cta", text: "the headline is cut off" }]);
      expect(p.calls[0]!.previousJobDir).toBe(join(stateDir, "runs", "ev-prev-video"));
    });

    it("starts from the top when the head moved and nobody sent it back: a new commit is a new film", async () => {
      browserRun();
      const p = pipeline();
      const previous = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1234", media: [], at: "2026-11-03T00:00:00.000Z" };
      const { run } = stage({ ...wantVideo, video: p.fn });
      await run(taskContext({ evidence: previous }));
      expect(p.calls[0]).toMatchObject({ fixCards: [], previousJobDir: null });
    });
  });

  it("a text answer passes with no media, and its saved pack says text", async () => {
    browserRun();
    const { run, saved } = stage({ decideFormat: async () => ({ format: { choice: "text", confidence: 0.9 } }) });
    const result = await run(taskContext());
    expect(result.outcome).toBe("pass");
    const pack = (saved[0]![1] as { evidence: { format: string; media: unknown[] } }).evidence;
    expect(pack.format).toBe("text");
    expect(pack.media).toEqual([]);
    expect(result.detail?.evidence).toMatchObject({ format: "text", media: [] });
  });

  it("a skipped browser run (no web surface) ends in text with no manifest, and tells the decision there is no surface", async () => {
    const { run, saved, asked } = stage({ latestE2e: async () => ({ runId: "e2e-run", detail: { skipped: true, reason: "no web surface detected" } }), decideFormat: null });
    const result = await run(taskContext());
    expect(result.outcome).toBe("pass");
    expect((saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("text");
    expect(asked).toEqual([]);
    expect(result.detail).toMatchObject({ verdict: "skipped", format: "text" });
  });

  it("with no decision wired and a manifest, the format is captures", async () => {
    browserRun();
    const { run, saved } = stage({ decideFormat: null });
    await run(taskContext());
    expect((saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("captures");
  });

  it("an unsure or failed decision falls back to captures with a manifest", async () => {
    browserRun();
    const unsure = stage({ decideFormat: async () => ({ format: { choice: "text", confidence: 0.1 } }) });
    await unsure.run(taskContext());
    expect((unsure.saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("captures");
    const broken = stage({ decideFormat: async () => { throw new Error("no credential"); } });
    await broken.run(taskContext());
    expect((broken.saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("captures");
  });

  it("keeps the format of a previous pack on the task and does not ask again", async () => {
    browserRun();
    const previous = { summary: "s", format: "text", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1234", media: [], at: "2026-11-03T00:00:00.000Z" };
    const { run, saved, asked } = stage();
    const result = await run(taskContext({ evidence: previous }));
    expect(asked).toEqual([]);
    expect(result.detail).toMatchObject({ format: "text", formatKept: true });
    const pack = (saved[0]![1] as { evidence: { format: string; commitSha: string } }).evidence;
    expect(pack).toMatchObject({ format: "text", commitSha: "abc1234def" });
  });

  it("a kept video format is still vetoed when the image is gone", async () => {
    browserRun();
    const previous = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1234", media: [], at: "2026-11-03T00:00:00.000Z" };
    const { run, saved } = stage({ videoImage: async () => false });
    await run(taskContext({ evidence: previous }));
    expect((saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("captures");
  });

  it("fails naming the problem when the worktree's head cannot be read", async () => {
    browserRun();
    const { run, saved } = stage({ headCommit: async () => { throw new Error("not a git repository"); } });
    const result = await run(taskContext());
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ error: expect.stringContaining("not a git repository") });
    expect(saved).toEqual([]);
  });

  it("takes how-to-verify from luna.yaml's target by name, never from the manifest, and never prints a host path", async () => {
    const dir = browserRun({ target: { name: "evil", baseUrl: "https://evil.example/login?next=1" } });
    writeFileSync(join(dir, "steps.md"), "# steps");
    const { run, saved } = stage();
    await run(taskContext());
    const pack = saved[0]![1] as { evidence: { howToVerify: string } };
    expect(pack.evidence.howToVerify).toBe("follow steps.md in the QA packet");
    expect(JSON.stringify(saved)).not.toContain("evil.example");
    expect(pack.evidence.howToVerify).not.toContain(stateDir);
  });

  it("notes when the browser run proved an older commit than the one the pack shows", async () => {
    browserRun();
    const previous = { summary: "s", format: "captures", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1234", media: [], at: "2026-11-03T00:00:00.000Z" };
    const { run, saved } = stage();
    const result = await run(taskContext({ evidence: previous }));
    expect(result.outcome).toBe("pass");
    const pack = saved[0]![1] as { evidence: { note?: string } };
    expect(pack.evidence.note).toMatch(/proved old1234.*abc1234/);
  });

  it("never carries a credential from the manifest's target into the pack", async () => {
    browserRun();
    const { run, saved } = stage();
    await run(taskContext());
    expect(JSON.stringify(saved)).not.toContain("secret");
  });
});

function rmSyncIfThere(path: string) {
  try {
    rmSync(path);
  } catch {
    /* already gone */
  }
}
