import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { type FakeGitHub, fakeGitHub } from "../../test/github.ts";
import { type GitHub, noTokenGitHub } from "../github.ts";
import type { EvidencePack } from "@hardness/contracts";

import { scenariosKeyOf } from "../../domain/evidence-stale.ts";
import { type EvidenceDeps, type EvidenceStageDeps, evidenceRunner, evidenceStage } from "./evidence.ts";
import { type Learned, tagged } from "../decision-truth.ts";
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
const runner = (e2e: { runId: string; detail?: Record<string, unknown> } | null, latestFinish?: EvidenceDeps["latestFinish"]) =>
  evidenceRunner({ stateDir, latestE2e: async () => e2e, ...(latestFinish ? { latestFinish } : {}) });

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
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "unreadable", note: expect.stringContaining("unreadable") });
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

  it("passes when a scenario has no manifest row: it is not_run, and the note names it", async () => {
    write({ acceptance: [row(scenarios[0]!.title)] });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("pass");
    expect(result.findings).toBeUndefined();
    expect(result.detail).toMatchObject({ verdict: "partial", note: `1 approved scenario(s) have no manifest row: ${scenarios[1]!.title}` });
    expect(result.detail).not.toHaveProperty("error");
    expect(result.detail?.evidence).toMatchObject({ scenarios: [expect.objectContaining({ result: "pass" }), expect.objectContaining({ text: scenarios[1]!.title, result: "not_run" })] });
  });

  it("matches titles verbatim: a reworded row is a missing one", async () => {
    write({ acceptance: [row("rejects a bad password"), row(scenarios[1]!.title)] });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.detail?.note).toContain(scenarios[0]!.title);
  });

  it("passes naming the scenario that has no chapter when the manifest has a video", async () => {
    write({ acceptance: [row(scenarios[0]!.title), row(scenarios[1]!.title)], video: { file: "qa.webm", chapters: [{ title: scenarios[0]!.title, start: 0 }] } });
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ note: `1 approved scenario(s) have no video chapter: ${scenarios[1]!.title}` });
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

  it("passes on a fail manifest, which e2e would have looped on before Evidence", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "fail" }));
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "evidence", verdict: "fail" });
  });

  it("passes on a partial manifest and on an unreadable one", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "partial" }));
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("pass");
    writeFileSync(join(dir, "qa-manifest.json"), "{not json");
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("pass");
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

  it("passes with a note when e2e did not skip and left no manifest", async () => {
    const result = await runner({ runId: "e2e-run", detail: { verdict: "pass" } })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ step: "evidence", verdict: "missing", note: expect.stringContaining("qa-manifest.json") });
  });

  it("passes with a note when there is no e2e run at all", async () => {
    const result = await runner(null)(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "missing" });
  });
});

describe("evidenceRunner: the proof comes from the card first, and the container's files are not trusted", () => {
  const scenarios = [
    { id: "S1", title: "Rejects a bad password", criterion: "no crash", approach: "a" },
    { id: "S2", title: "Shows the export button", criterion: null, approach: "b" },
  ];
  const approved = { ...context, approvals: [{ kind: "awaiting_approval", decision: "approved", requested: { cases: scenarios } }] } as unknown as StageContext;
  const cardRow = (id: string, title: string, result: string, artifacts: string[] = []) => ({ scenario: id, title, criterion: null, result, seen: "ok", artifacts });
  const report = (rows: unknown[]) => ({ prNumber: 3, headSha: "abc", findings: [], tests: { passed: 1, total: 1 }, coverageDelta: null, e2e: { verdict: "pass", scenarios: [], artifacts: [], rows }, envReproduction: null, overrides: [], version: 2 });

  it("takes each scenario's result from the Verify Report's rows, whatever the manifest says", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "pass", acceptance: [{ text: scenarios[0]!.title, result: "fail", evidence: [] }, { text: scenarios[1]!.title, result: "fail", evidence: [] }] }));
    const finish = async (_id: string, stage: string) => (stage === "ci_watch" ? { runId: "ci", detail: { report: report([cardRow("S1", scenarios[0]!.title, "pass", ["a.png"]), cardRow("S2", scenarios[1]!.title, "partial")]) } } : null);
    const result = await runner({ runId: "e2e-run" }, finish)(approved);
    expect(result.outcome).toBe("pass");
    expect(result.detail?.evidence).toMatchObject({ scenarios: [expect.objectContaining({ result: "pass" }), expect.objectContaining({ result: "partial" })] });
  });

  it("falls back to the latest e2e finish's manifest rows, then to qa-manifest.json by title", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "pass", acceptance: [{ text: scenarios[0]!.title, result: "fail", evidence: [] }, { text: scenarios[1]!.title, result: "pass", evidence: [] }] }));
    const e2e = { runId: "e2e-run", detail: { manifest: [cardRow("S1", scenarios[0]!.title, "pass"), cardRow("S2", scenarios[1]!.title, "not_run")] } };
    const fromFinish = await runner(e2e)(approved);
    expect(fromFinish.detail?.evidence).toMatchObject({ scenarios: [expect.objectContaining({ result: "pass" }), expect.objectContaining({ result: "not_run" })] });
    const fromFile = await runner({ runId: "e2e-run" })(approved);
    expect(fromFile.detail?.evidence).toMatchObject({ scenarios: [expect.objectContaining({ result: "fail" }), expect.objectContaining({ result: "pass" })] });
  });

  it("reads no host file through a manifest or a screenshot that is a link, and does not block on a FIFO", async () => {
    const secret = join(stateDir, "host-secret.txt");
    writeFileSync(secret, "private key material");
    const dir = qaDir();
    symlinkSync(secret, join(dir, "qa-manifest.json"));
    symlinkSync(secret, join(dir, "shot.png"));
    execFileSync("mkfifo", [join(dir, "pipe.png")]);
    const started = Date.now();
    const result = await runner({ runId: "e2e-run" })(approved);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ note: expect.stringContaining("manifest") });
    expect(JSON.stringify(result)).not.toContain("private key");
    // The link and the FIFO are listed with no hash and never kept.
    expect((result.artifacts ?? []).every((a) => a.sha256 === "" || /^[0-9a-f]{64}$/.test(a.sha256))).toBe(true);
    expect((result.artifacts ?? []).filter((a) => a.label === "shot.png" || a.label === "pipe.png" || a.label === "qa-manifest.json").every((a) => a.sha256 === "")).toBe(true);
  }, 15_000);

  it("stops the walk at 2000 files", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "pass" }));
    for (let i = 0; i < 2100; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "x");
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.artifacts).toHaveLength(2000);
  }, 30_000);
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

  it("a missing manifest passes with a text pack that says so, and the card is not sent back", async () => {
    const { run, saved } = stage();
    const result = await run(taskContext());
    expect(result.outcome).toBe("pass");
    expect(result.findings).toBeUndefined();
    const pack = (saved[0]![1] as { evidence: { format: string; note?: string } }).evidence;
    expect(pack.format).toBe("text");
    expect(pack.note).toMatch(/qa-manifest\.json/);
  });

  it("a manifest gap passes, saves a pack with the scenario not_run and a note", async () => {
    browserRun({ acceptance: [row(scenarios[0]!.title)] });
    const { run, saved } = stage();
    expect((await run(taskContext())).outcome).toBe("pass");
    const pack = (saved[0]![1] as { evidence: { scenarios: { result: string }[]; note?: string } }).evidence;
    expect(pack.scenarios.map((x) => x.result)).toEqual(["pass", "not_run"]);
    expect(pack.note).toMatch(/no manifest row/);
  });

  it("hands the decision the record, the risk from the approval, the surface, the browser run and the changed files", async () => {
    browserRun();
    const { run, asked } = stage({ videoImage: async () => true });
    await run(taskContext());
    expect(asked).toHaveLength(1);
    expect(asked[0]![1]).toBe("/repo");
    expect(asked[0]![0]).toEqual({ record, risk: "medium", webSurface: true, e2e: { ran: true, verdict: "pass", hasVideo: true, hasSteps: true, scenarios: 2, skippedReason: null }, videoImage: true, changed: ["web/cart.tsx", "web/format.ts"] });
  });

  it("fills the pack's v2 fields from the Verify Report on ci_watch's finish, and none without one", async () => {
    browserRun();
    const report = { prNumber: 3, headSha: "abc1234def", findings: [], tests: { passed: 2, total: 2 }, coverageDelta: null, e2e: { verdict: "pass", scenarios: [], artifacts: [] }, envReproduction: null, overrides: [], version: 2 };
    const withReport = stage({ latestFinish: async (_id, name) => (name === "ci_watch" ? { runId: "ci", detail: { report } } : (finishes[name] ?? null)) });
    await withReport.run(taskContext());
    const [, patch] = withReport.saved[0]! as [string, { evidence: Record<string, any> }];
    expect(patch.evidence).toMatchObject({ version: 2, results: { unit: { passed: 2, total: 2 }, integration: null } });

    const without = stage();
    await without.run(taskContext());
    expect((without.saved[0]![1] as { evidence: Record<string, unknown> }).evidence).not.toHaveProperty("results");
  });

  it("takes the Build Report from deps.reports: the diff summary, the scenario's tagged test, results by layer and revision 1", async () => {
    browserRun();
    const layered = scenarios.map((x, i) => ({ ...x, id: `S${i + 1}`, layer: "unit" }));
    const buildReport = { branch: "b", base: null, headSha: "abc1234def", envHash: null, diffSummary: { added: 9, removed: 2, files: ["web/cart.tsx"] }, declaredFiles: [], tests: [{ scenario: "S1", before: "fail", after: "pass", file: "src/cart.test.ts" }], runs: [], tokens: null, minutes: 1, scopeCheck: { clean: true, issues: [] }, version: 2 };
    const report = { prNumber: 3, headSha: "abc1234def", findings: [], tests: { passed: 2, total: 2 }, coverageDelta: null, e2e: { verdict: "pass", scenarios: [], artifacts: [] }, envReproduction: null, overrides: [], version: 2 };
    const { run, saved } = stage({
      reports: async () => ({ build: buildReport as never, verify: report as never }),
      latestFinish: async (_id, name) => (name === "ci_watch" ? { runId: "ci", detail: { report } } : (finishes[name] ?? null)),
    });
    const ctx = taskContext();
    ctx.approvals[0]!.requested.cases = layered;
    await run(ctx);
    const pack = (saved[0]![1] as { evidence: Record<string, any> }).evidence;
    expect(pack.revision).toBe(1);
    expect(pack.diffSummary).toMatchObject({ added: 9, removed: 2, files: ["web/cart.tsx"] });
    expect(pack.scenarios[0].test).toBe("src/cart.test.ts");
    expect(pack.results.unit).toEqual({ passed: 1, total: 2 });
  });

  it("counts the revision on from the stored pack", async () => {
    browserRun();
    const { run, saved } = stage();
    const stored = { summary: "s", format: "captures", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "abc1234def", media: [], at: "2026-11-03T00:00:00.000Z", revision: 2 };
    await run(taskContext({ evidence: stored }));
    expect((saved[0]![1] as { evidence: { revision: number } }).evidence.revision).toBe(3);
  });

  it("repairs what a script can before saving: an over-long goal does not leave an over-long summary", async () => {
    browserRun();
    const goal = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const { run, saved } = stage();
    await run(taskContext({ record: { ...record, goal } }));
    const pack = (saved[0]![1] as { evidence: { summary: string } }).evidence;
    expect(pack.summary.split(/\s+/).length).toBeLessThanOrEqual(200);
  });

  describe("when the head moved, only what the new commit made stale is made again", () => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    const failedFilm = { ok: false as const, reason: "no film", degrade: "captures" as const, usage: { turns: 0, costUsd: 0 } };
    /** A video pack made at an older commit, its film files in the machine's own store for that commit. */
    function previousFilm() {
      const dir = join(stateDir, "evidence", "t1", "old1111");
      mkdirSync(dir, { recursive: true });
      for (const f of ["walkthrough.mp4", "cover.jpg", "captions.vtt"]) writeFileSync(join(dir, f), `old ${f}`);
      const video = { file: "walkthrough.mp4", durationS: 60, verdict: "ship" as const, scores: { hook: 9 }, defects: [], rounds: 1 };
      const media = [
        { kind: "video" as const, label: "walkthrough.mp4", url: join(dir, "walkthrough.mp4") },
        { kind: "cover" as const, label: "cover.jpg", url: join(dir, "cover.jpg") },
        { kind: "captions" as const, label: "captions.vtt", url: join(dir, "captions.vtt") },
      ];
      const approved = scenarios.map((x, i) => ({ id: `S${i + 1}`, title: x.title }));
      return { summary: "s", format: "video", scenarios: scenarios.map((x) => ({ text: x.title, test: null, result: "pass" })), findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "old1111", media, video, at: "2026-11-03T00:00:00.000Z", revision: 1, source: { e2eRunId: "e2e-run", scenariosKey: scenariosKeyOf(approved), stepsSha: sha256("{}\n") } };
    }
    const setup = (changed: string[] | null, over: Partial<EvidenceStageDeps> = {}) => {
      browserRun();
      const video = vi.fn(async () => failedFilm);
      const emitted: [string, Record<string, unknown>][] = [];
      const { run, saved } = stage({ videoImage: async () => true, video, changedBetween: async () => changed, ...over });
      const ctx = { ...taskContext({ evidence: previousFilm() }), emit: async (k: string, p: Record<string, unknown>) => void emitted.push([k, p]) } as unknown as StageContext;
      return { run, saved, video, emitted, ctx };
    };

    it("keeps a film whose scenarios and screens did not change: its files are copied from the old commit's own folder, no video run starts, and evidence.stale says what was remade", async () => {
      const { run, saved, video, emitted, ctx } = setup(["server/db.ts"]);
      const result = await run(ctx);
      expect(result.outcome).toBe("pass");
      expect(video).not.toHaveBeenCalled();
      expect(emitted).toEqual([["evidence.stale", { from: "old1111", to: "abc1234", parts: ["text"] }]]);
      const pack = (saved[0]![1] as { evidence: { format: string; video: { verdict: string }; media: { kind: string; url: string; label: string }[]; source: { e2eRunId: string } } }).evidence;
      expect(pack.format).toBe("video");
      expect(pack.video).toMatchObject({ verdict: "ship" });
      const film = pack.media.find((m) => m.label === "walkthrough.mp4")!;
      expect(film.url.startsWith(join(stateDir, "evidence", "t1", "abc1234def") + "/")).toBe(true);
      expect(readFileSync(film.url, "utf8")).toBe("old walkthrough.mp4");
      expect(pack.source.e2eRunId).toBe("e2e-run");
    });

    it("makes the film again when a rendered surface changed between the commits, or the paths cannot be read", async () => {
      for (const changed of [["web/cart.tsx"], null]) {
        const { run, video, emitted, ctx } = setup(changed);
        await run(ctx);
        expect(video).toHaveBeenCalledTimes(1);
        expect((emitted[0]![1] as { parts: string[] }).parts).toContain("film");
      }
    });

    it("entered at the same commit nothing is stale and today's path runs", async () => {
      browserRun();
      const emitted: unknown[] = [];
      const { run } = stage({ videoImage: async () => true, video: vi.fn(async () => failedFilm), changedBetween: async () => [] });
      const ctx = { ...taskContext({ evidence: { ...previousFilm(), commitSha: "abc1234def" } }), emit: async (k: string) => void emitted.push(k) } as unknown as StageContext;
      await run(ctx);
      expect(emitted).toEqual([]);
    });
  });

  describe("publishing and marking ready inside Evidence", () => {
    const HEAD = "abc1234def";
    const gh = (over: Record<string, unknown> = {}) => fakeGitHub({ findPr: async () => ({ url: "https://github.com/a/b/pull/3", number: 3, isDraft: true }), prHeadSha: async () => HEAD, markPrReady: async () => {}, ...over } as never);
    const published = (assets = 2) => ({ pack: undefined as never, comment: "created" as const, assets, notes: [] });
    const setup = (preview: "on" | "off", github: GitHub = gh(), over: Partial<EvidenceStageDeps> = {}) => {
      const publish = vi.fn(async (input: { pack: EvidencePack }) => ({ ...published(), pack: input.pack }));
      const { run, saved } = stage({
        policies: { for: async () => ({ decisions: {}, qaTargets: [{ name: "local", baseUrl: "http://localhost:3000/app", credential: null }], factory: { ship: { preview } } as never }) },
        publishing: { github, publish, slugOf: async () => "a/b" },
        ...over,
      });
      const emitted: [string, Record<string, unknown>][] = [];
      const ctx = { ...taskContext({ branch: "hardness/t1" }), emit: async (k: string, p: Record<string, unknown>) => void emitted.push([k, p]) } as unknown as StageContext;
      return { run, saved, publish, emitted, ctx, github: github as FakeGitHub };
    };

    it("with the preview off publishes the pack to the PR whose head is the pack's commit, marks it ready and logs evidence.published with ids and counts", async () => {
      browserRun();
      const { run, publish, emitted, ctx, github } = setup("off");
      const result = await run(ctx);
      expect(result.outcome).toBe("pass");
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]![0]).toMatchObject({ slug: "a/b", number: 3 });
      expect(github.markPrReady).toHaveBeenCalledWith("a/b", 3);
      expect(emitted).toEqual([["evidence.published", { number: 3, assets: 2, revision: 1 }]]);
      expect(result.detail).toMatchObject({ published: true, readied: true });
    });

    it("with ship.preview on publishes nothing and touches no PR: the gate comes first", async () => {
      browserRun();
      const { run, publish, emitted, ctx, github } = setup("on");
      const result = await run(ctx);
      expect(result.outcome).toBe("pass");
      expect(publish).not.toHaveBeenCalled();
      expect(github.findPr).not.toHaveBeenCalled();
      expect(github.markPrReady).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
      expect(result.detail).toMatchObject({ published: false, publishedWhy: expect.stringMatching(/preview/) });
    });

    it("publishes nothing when the PR's head on GitHub is not the pack's commit, and still passes", async () => {
      browserRun();
      const { run, publish, ctx } = setup("off", gh({ prHeadSha: async () => "fff9999" }));
      const result = await run(ctx);
      expect(result.outcome).toBe("pass");
      expect(publish).not.toHaveBeenCalled();
      expect(result.detail).toMatchObject({ published: false, publishedWhy: expect.stringMatching(/head/) });
    });

    it("publishes nothing with no PR, or with no token, and still passes", async () => {
      browserRun();
      const none = setup("off", gh({ findPr: async () => null }));
      expect((await none.run(none.ctx)).detail).toMatchObject({ published: false, publishedWhy: expect.stringMatching(/no PR/) });
      const noToken = setup("off", noTokenGitHub());
      const result = await noToken.run(noToken.ctx);
      expect(result.outcome).toBe("pass");
      expect(noToken.publish).not.toHaveBeenCalled();
      expect(result.detail).toMatchObject({ published: false });
    });

    it("passes the approval of a gate that was approved to the publish, never otherwise", async () => {
      browserRun();
      const open = setup("off");
      await open.run(open.ctx);
      expect(open.publish.mock.calls[0]![0]).toMatchObject({ approved: false });
    });

    it("does nothing about GitHub when no publishing is wired", async () => {
      browserRun();
      const { run, saved } = stage();
      const result = await run(taskContext());
      expect(saved).toHaveLength(1);
      expect(result.detail).toMatchObject({ published: false });
    });
  });

  describe("the text on screenshots is read before they are kept", () => {
    const token = "gh" + "p_" + "a".repeat(36);
    const shot = async (frames: { file: string; text: string }[] | null) => {
      const seen: string[] = [];
      const { run, saved } = stage({ scanImages: async (dir) => (seen.push(dir), frames) });
      const result = await run(taskContext());
      return { result, saved, seen, pack: (saved[0]![1] as { evidence: { media: { kind: string; label: string; scanned?: boolean }[]; note?: string } }).evidence };
    };

    it("copies the screenshots into <runId>-shots and reads that folder, marking the clean ones scanned", async () => {
      browserRun();
      const { seen, pack } = await shot([{ file: "a.png", text: "Cart" }, { file: "b.png", text: "Total" }]);
      expect(seen).toEqual([join(stateDir, "runs", "ev-shots")]);
      expect(existsSync(join(stateDir, "runs", "ev-shots", "a.png"))).toBe(true);
      expect(pack.media.filter((m) => m.kind === "screenshot").map((m) => [m.label, m.scanned])).toEqual([["a.png", true], ["b.png", true]]);
    });

    it("leaves a screenshot with a hit out, counts it in the note, and never prints the text", async () => {
      browserRun();
      const { pack, result } = await shot([{ file: "a.png", text: `key ${token}` }, { file: "b.png", text: "Total" }]);
      expect(pack.media.map((m) => m.label)).not.toContain("a.png");
      expect(pack.media.map((m) => m.label)).toContain("b.png");
      expect(pack.note).toMatch(/1 screenshot.*left out.*token/);
      expect(JSON.stringify(result)).not.toContain(token);
    });

    it("asks frame_privacy once over the screenshots' text; a credential leaves them out with a note", async () => {
      browserRun();
      const asked: string[][] = [];
      const { run, saved } = stage({ scanImages: async () => [{ file: "a.png", text: "Cart" }, { file: "b.png", text: "Key" }], privacy: async (texts) => (asked.push(texts), "exposed") });
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { media: { kind: string }[]; note?: string } }).evidence;
      expect(asked).toEqual([["Cart", "Key"]]);
      expect(pack.media.filter((m) => m.kind === "screenshot")).toEqual([]);
      expect(pack.note).toMatch(/2 screenshot.*left out.*personal data or a credential/);
    });

    it("says the on-screen text was not judged when there is no decision, and keeps the pattern-checked screenshots", async () => {
      browserRun();
      const { run, saved } = stage({ scanImages: async () => [{ file: "a.png", text: "Cart" }], privacy: async () => "not_judged" });
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { media: { kind: string }[]; note?: string } }).evidence;
      expect(pack.media.some((m) => m.kind === "screenshot")).toBe(true);
      expect(pack.note).toMatch(/on-screen text was not judged/);
    });

    it("marks every screenshot scanned: false when the reader cannot run, and keeps them", async () => {
      browserRun();
      const { pack } = await shot(null);
      expect(pack.media.filter((m) => m.kind === "screenshot").map((m) => m.scanned)).toEqual([false, false]);
      expect(pack.note).toMatch(/not read/);
    });

    it("marks them scanned: false when there is no reader wired at all", async () => {
      browserRun();
      const { run, saved } = stage();
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { media: { kind: string; scanned?: boolean }[] } }).evidence;
      expect(pack.media.filter((m) => m.kind === "screenshot").every((m) => m.scanned === false)).toBe(true);
    });
  });

  describe("the format labels and the terminal capture", () => {
    const run2 = (choice: string, over: Partial<EvidenceStageDeps> = {}) => stage({ decideFormat: async () => ({ format: { choice, confidence: 0.9 } }), ...over });
    const verifying = (checks: unknown[]) => ({ runId: "v1", detail: { findings: [], checks } });
    const apiChecks = [{ name: "unit", cmd: "pnpm test", ok: true, tail: "3 passed" }];

    it("maps the diagram's labels to the stored format, and still takes the old ones", async () => {
      browserRun();
      for (const [choice, format] of [["video", "captures"], ["screenshots_or_terminal", "captures"], ["text_only", "text"], ["captures", "captures"], ["text", "text"]] as const) {
        const { run, saved } = run2(choice);
        await run(taskContext());
        expect((saved[0]![1] as { evidence: { format: string } }).evidence.format, choice).toBe(format);
      }
    });

    it("writes the decision's own label, from the format the pack shipped with", async () => {
      browserRun();
      const told: Learned[] = [];
      const { run } = stage({ decideFormat: async () => tagged({ answer: { format: { choice: "text_only", confidence: 0.9 } }, recordId: "r1" }), truth: { learned: async (f: Learned) => (told.push(f), true) } });
      await run(taskContext());
      expect(told[0]!.label).toEqual({ format: { choice: "text_only" } });
    });

    it("hands the decision how many checks Verify ran", async () => {
      browserRun();
      const { run, asked } = stage({ latestFinish: async (_id, name) => (name === "verifying" ? verifying(apiChecks) : (finishes[name] ?? null)) });
      await run(taskContext());
      expect((asked[0]![0] as { checks?: number }).checks).toBe(1);
    });

    it("keeps captures with no browser run when Verify ran checks, and writes terminal.txt as a report media entry", async () => {
      const { run, saved } = run2("screenshots_or_terminal", { latestFinish: async (_id, name) => (name === "verifying" ? verifying(apiChecks) : (finishes[name] ?? null)) });
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { format: string; media: { kind: string; label: string; url: string }[]; note?: string } }).evidence;
      expect(pack.format).toBe("captures");
      expect(pack.note ?? "").not.toMatch(/no browser run to capture/);
      const terminal = pack.media.find((m) => m.label === "terminal.txt")!;
      expect(terminal.kind).toBe("report");
      expect(readFileSync(terminal.url, "utf8")).toContain("$ pnpm test");
    });

    it("keeps captures with no browser run when Build tagged scenario tests", async () => {
      const { run, saved } = run2("screenshots_or_terminal", { reports: async () => ({ build: { diffSummary: { added: 1, removed: 0, files: [] }, tests: [{ scenario: "S1", before: "fail", after: "pass", file: "a.test.ts" }] } as never, verify: null }) });
      await run(taskContext());
      expect((saved[0]![1] as { evidence: { format: string } }).evidence.format).toBe("captures");
    });

    it("becomes text only when there are neither checks nor tagged tests", async () => {
      const { run, saved } = run2("screenshots_or_terminal");
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { format: string; note?: string } }).evidence;
      expect(pack.format).toBe("text");
      expect(pack.note).toMatch(/no browser run to capture/);
    });

    it("gives a text pack a checks.txt excerpt as a media line, never inline", async () => {
      const { run, saved } = run2("text_only", { latestFinish: async (_id, name) => (name === "verifying" ? verifying(apiChecks) : (finishes[name] ?? null)) });
      await run(taskContext());
      const pack = (saved[0]![1] as { evidence: { format: string; media: { kind: string; label: string; url: string }[] } }).evidence;
      expect(pack.format).toBe("text");
      expect(pack.media.map((m) => m.label)).toEqual(["checks.txt"]);
      expect(readFileSync(pack.media[0]!.url, "utf8")).toContain("3 passed");
    });
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
      risk: pack.risk,
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

  it("writes the format the pack shipped with onto the decision's record, after the video degrade", async () => {
    browserRun();
    const told: Learned[] = [];
    const truth = { learned: async (fact: Learned) => (told.push(fact), true) };
    const { run } = stage({ decideFormat: async () => tagged({ answer: { format: { choice: "video", confidence: 0.95 } }, recordId: "rec-9" }), videoImage: async () => false, truth });
    await run(taskContext());
    expect(told).toEqual([{ pack: "evidence_format", recordId: "rec-9", label: { format: { choice: "screenshots_or_terminal" } }, source: "evidence_shipped", taskId: expect.any(String) }]);
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

    it("skips the pipeline when the manifest names a target luna.yaml does not know: the veto never fails open", async () => {
      browserRun({ target: { name: "ghost", baseUrl: "https://evil.example/app" } });
      const p = pipeline();
      const { run, saved } = stage({ ...wantVideo, video: p.fn, policies: { for: async () => ({ decisions: {}, qaTargets: [{ name: "local", baseUrl: "http://localhost:3000/app", credential: null, reentrant: false }] }) } });
      await run(taskContext());
      expect(p.calls).toEqual([]);
      expect(saved[0]![1]).toMatchObject({ evidence: { format: "captures", note: "the QA target is unknown or not re-entrant" } });
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
