// The evidence stage runs on the host: nothing of it needs a container. It reads what the latest
// e2e run left under `<stateDir>/runs/<runId>/files/qa/`, checks the QA manifest and lists the files
// (the prelude, `evidenceRunner`); `evidenceStage` then picks a format for the change (a decision, with
// a mechanical veto), assembles the Evidence Pack, keeps a local copy of its media and saves the pack
// on the task. The pack and its files show up in the ship approval's `requested`, the gate Ship publishes from.
import { type TruthSink, evidenceFormatTruth, recordIdOf } from "../decision-truth.ts";
import { type ArtifactKind, type EvidenceContext, EvidencePack, Finding, PACKS, Risk, type TaskState, applyPolicy } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { assembleEvidencePack } from "../../domain/evidence-pack.ts";
import { parseNote } from "../../domain/fix-card.ts";
import type { Policy } from "../../domain/policy.ts";
import { approvedCases, approvedPlan } from "../../domain/stage-input.ts";
import { EvidenceStore } from "../evidence-store.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import type { VideoPipeline } from "./video.ts";

export interface EvidenceDeps {
  stateDir: string;
  /** The task's latest e2e run and the detail it finished with. */
  latestE2e: (taskId: string) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
}

const MANIFEST = "qa-manifest.json";

interface Manifest {
  verdict?: unknown;
  target?: { name?: unknown; baseUrl?: unknown } | null;
  acceptance?: Array<{ text?: unknown; result?: unknown; evidence?: unknown } | null>;
  video?: { file?: unknown; chapters?: Array<{ title?: unknown; start?: unknown } | null> } | null;
}
const IMAGES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEOS = new Set([".webm", ".mp4", ".mov"]);
const THUMBNAILS = 3;

const kindOf = (name: string): ArtifactKind => {
  const ext = extname(name).toLowerCase();
  if (name === MANIFEST) return "qa-manifest";
  if (IMAGES.has(ext)) return "screenshot";
  if (VIDEOS.has(ext)) return "video";
  if (ext === ".har") return "har";
  return "report";
};

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}

/** What the prelude read, for the stage that builds the pack on it. */
interface PreludeFacts {
  e2e: { runId: string; detail?: Record<string, unknown> } | null;
  qaDir: string | undefined;
  manifest: Manifest;
  manifestPath: string | undefined;
  verdict: string;
  scenarios: { text: string; criterion: string | null; result: string; test: string | null }[];
  artifacts: NonNullable<StageResult["artifacts"]>;
  approvedCount: number;
}

async function prelude(deps: EvidenceDeps, context: StageContext): Promise<{ result: StageResult; facts: PreludeFacts | null }> {
  {
    const e2e = await deps.latestE2e(context.task.id);
    const qaDir = e2e ? join(deps.stateDir, "runs", e2e.runId, "files", "qa") : undefined;
    const manifestPath = qaDir ? join(qaDir, MANIFEST) : undefined;

    let verdict: string | undefined;
    let manifest: Manifest = {};
    if (manifestPath) {
      try {
        const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
        // The container wrote it: anything but an object (null, a list, a number) is an unreadable manifest, not a crash.
        manifest = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Manifest) : {};
        verdict = typeof manifest.verdict === "string" ? manifest.verdict : "unreadable";
      } catch (error) {
        verdict = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : "unreadable";
      }
    }

    if (verdict === undefined) {
      if (e2e?.detail?.skipped === true) {
        const why = e2e.detail.reason ?? e2e.detail.note;
        return {
          result: {
            outcome: "pass",
            detail: {
              step: "evidence",
              verdict: "skipped",
              artifactCount: 0,
              thumbnails: [],
              note: `e2e skipped${why ? `: ${String(why)}` : ""}`,
              evidence: { verdict: "skipped", artifactCount: 0, manifest: null, thumbnails: [] },
            },
          },
          facts: { e2e, qaDir, manifest, manifestPath, verdict: "skipped", scenarios: [], artifacts: [], approvedCount: 0 },
        };
      }
      return {
        result: {
          outcome: "fail",
          detail: {
            step: "evidence",
            verdict: "missing",
            artifactCount: 0,
            error: `no ${MANIFEST} from the e2e run; the criteria are not shown working`,
          },
        },
        facts: null,
      };
    }

    const files = await walk(qaDir!);
    const artifacts: NonNullable<StageResult["artifacts"]> = [];
    for (const path of files) {
      artifacts.push({
        kind: kindOf(path.slice(path.lastIndexOf("/") + 1)),
        path,
        label: relative(qaDir!, path),
        sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      });
    }
    // Every approved scenario is shown by a row keyed by its title, and by a chapter when there is a recording.
    const approved = verdict === "skipped" || verdict === "unreadable" ? [] : approvedCases(context.approvals);
    const rows = Array.isArray(manifest.acceptance) ? manifest.acceptance : [];
    const chapters = Array.isArray(manifest.video?.chapters) ? manifest.video!.chapters! : [];
    const hasVideo = manifest.video !== undefined && manifest.video !== null;
    const scenarios = approved.map((c) => {
      const found = rows.find((r) => typeof r?.text === "string" && r.text.trim() === c.title.trim());
      const chapter = chapters.find((ch) => typeof ch?.title === "string" && ch.title.trim() === c.title.trim());
      const result = found?.result === "pass" || found?.result === "fail" || found?.result === "partial" ? found.result : "missing";
      const evidence = Array.isArray(found?.evidence) ? found.evidence.find((e): e is string => typeof e === "string") : undefined;
      return { text: c.title, criterion: c.criterion ?? null, result, chapter: typeof chapter?.start === "number" ? chapter.start : null, hasChapter: chapter !== undefined, test: evidence ?? null };
    });
    const noRow = scenarios.filter((s) => s.result === "missing").map((s) => s.text);
    const noChapter = hasVideo ? scenarios.filter((s) => !s.hasChapter).map((s) => s.text) : [];
    const gaps = [
      ...(noRow.length > 0 ? [`${noRow.length} approved scenario(s) have no manifest row: ${noRow.join(", ")}`] : []),
      ...(noChapter.length > 0 ? [`${noChapter.length} approved scenario(s) have no video chapter: ${noChapter.join(", ")}`] : []),
    ];
    if (gaps.length > 0 && verdict !== "fail") verdict = "partial";
    const passed = gaps.length === 0 && (verdict === "pass" || verdict === "skipped");
    const shown = approved.length > 0 ? { rows: rows.length, scenarios: scenarios.map(({ hasChapter: _, test: __, ...s }) => s) } : {};
    const thumbnails = artifacts.filter((a) => a.kind === "screenshot").slice(0, THUMBNAILS).map((a) => a.path);
    return {
      result: {
        outcome: passed ? "pass" : "fail",
        detail: {
          step: "evidence",
          verdict,
          artifactCount: artifacts.length,
          manifestPath,
          thumbnails,
          ...(gaps.length > 0 ? { error: gaps.join("; ") } : {}),
          // The ship approval's `requested.evidence`, which the board shows.
          evidence: { verdict, artifactCount: artifacts.length, manifest: manifestPath, thumbnails, ...shown },
        },
        artifacts,
      },
      facts: { e2e, qaDir, manifest, manifestPath, verdict, scenarios, artifacts, approvedCount: approved.length },
    };
  }
}

/** The script prelude alone: the manifest and scenario checks, the files listed. */
export function evidenceRunner(deps: EvidenceDeps): StageRunner {
  return async (context) => (await prelude(deps, context)).result;
}

export interface EvidenceStageDeps extends EvidenceDeps {
  /** The task's latest finish of a stage and its detail (`pipeline.latestStageFinish`). */
  latestFinish: (taskId: string, stage: TaskState) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
  /** Writes the pack on the task row. */
  save: (taskId: string, patch: { evidence: EvidencePack }) => Promise<void>;
  /** Runs evidence_format on an evidence context and returns its answer; bound late, once PackRuns exists. Read at call time. */
  decideFormat: ((context: EvidenceContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null;
  /** The repo's decision bars and its QA targets: how-to-verify names a target's URL from here, never from the manifest. */
  policies: { for: (repoPath: string | null) => Promise<Pick<Policy, "decisions" | "qaTargets">> };
  /** Told the format the pack finally shipped with, after the vetoes and the video degrade (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  /** The worktree's HEAD: the commit the pack shows. */
  headCommit: (worktreePath: string) => Promise<string>;
  /** Whether the video image is built on this machine. */
  videoImage: () => Promise<boolean>;
  /** The video pipeline (stages/video.ts); null or absent when the video image is not on this machine. */
  video?: VideoPipeline | null;
  now?: () => Date;
}

type Format = EvidencePack["format"];
const FORMATS: readonly string[] = ["video", "captures", "text"];
const CHANGED_CAP = 50;
const MEDIA_SCREENSHOTS = 30;

const objectOf = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** A URL without the credentials it may carry: userinfo never goes into a pack. */
function plainUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "") || null;
  } catch {
    return null;
  }
}

const dirExists = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false);
const fileExists = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);

/** The change's Evidence Pack: a format picked from the record and the browser run, the pack assembled on the host, a local copy of its media, the pack on the task. */
export function evidenceStage(deps: EvidenceStageDeps): StageRunner {
  const store = new EvidenceStore(deps.stateDir);
  const now = deps.now ?? (() => new Date());
  return async (context) => {
    const { task } = context;
    const { result, facts } = await prelude(deps, context);
    // A manifest gap, a failed run or no manifest at all: today's failure, no pack.
    if (result.outcome !== "pass" || !facts) return result;

    const plan = approvedPlan(context.approvals);
    const approval = context.approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
    const risk = Risk.safeParse(objectOf(approval?.requested.risk)?.level);
    const implementing = await deps.latestFinish(task.id, "implementing");
    const verifying = await deps.latestFinish(task.id, "verifying");

    const skipped = facts.e2e?.detail?.skipped === true;
    const skippedReason = skipped ? String(facts.e2e?.detail?.reason ?? facts.e2e?.detail?.note ?? "") || null : null;
    const hasManifest = facts.manifestPath !== undefined && facts.verdict !== "skipped" && facts.verdict !== "unreadable";
    const hasVideo = facts.manifest.video !== undefined && facts.manifest.video !== null;
    const hasSteps = facts.qaDir !== undefined && (await fileExists(join(facts.qaDir, "steps.jsonl")));
    const videoImage = await deps.videoImage();
    const changed = (Array.isArray(objectOf(objectOf(implementing?.detail?.scope)?.facts)?.changed) ? (objectOf(objectOf(implementing!.detail!.scope)!.facts)!.changed as unknown[]) : [])
      .filter((p): p is string => typeof p === "string")
      .slice(0, CHANGED_CAP);
    const evidenceContext: EvidenceContext = {
      record: task.record ?? null,
      risk: risk.success ? risk.data : null,
      webSurface: !(skipped && /no web surface/i.test(skippedReason ?? "")),
      e2e: { ran: !skipped && facts.e2e !== null, verdict: facts.verdict === "skipped" ? null : facts.verdict, hasVideo, hasSteps, scenarios: facts.approvedCount, skippedReason },
      videoImage,
      ...(changed.length > 0 ? { changed } : {}),
    };

    // 1. The format: kept from a previous pack, else decided; then a mechanical veto.
    const fallback: Format = hasManifest ? "captures" : "text";
    let format: Format;
    let formatKept = false;
    let formatRecord: string | undefined;
    if (task.evidence) {
      format = task.evidence.format;
      formatKept = true;
    } else {
      format = fallback;
      const decide = deps.decideFormat;
      if (decide && (facts.verdict !== "skipped" || !skipped)) {
        try {
          const answer = await decide(evidenceContext, task.repoPath);
          formatRecord = recordIdOf(answer);
          const overrides = (await deps.policies.for(task.repoPath)).decisions.evidence_format;
          const verdict = applyPolicy(PACKS.evidence_format, answer, overrides).overall;
          const choice = objectOf(answer.format)?.choice;
          if ((verdict === "proceed" || verdict === "flag") && typeof choice === "string" && FORMATS.includes(choice)) format = choice as Format;
        } catch (error) {
          await context.note?.(`evidence_format skipped: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
        }
      }
    }
    let note: string | undefined;
    // A re-run (the head moved, a send-back) still reads the latest browser run: when that run proved an older commit, say so on the pack.
    if (task.evidence && task.evidence.commitSha && facts.e2e && task.worktreePath) {
      const head = (await deps.headCommit(task.worktreePath).catch(() => "")).trim();
      if (head && head !== task.evidence.commitSha) note = `the browser run proved ${task.evidence.commitSha.slice(0, 7)}; the pack now shows ${head.slice(0, 7)}, which no browser run has seen`;
    }
    const addNote = (text: string) => (note = note ? `${note}; ${text}` : text);
    // The QA target the film is recorded against: the manifest's by name, else luna.yaml's only or first one.
    const targets = (await deps.policies.for(task.repoPath)).qaTargets;
    const targetName = typeof facts.manifest.target?.name === "string" ? facts.manifest.target.name : null;
    const target = targets.find((t) => t.name === targetName) ?? (targetName === null ? targets[0] : undefined);
    // How to verify: the QA target's URL as luna.yaml declares it (matched to the manifest's target by name, or the only one), never the manifest's own URL; else the steps file by name, never by host path.
    // A manifest naming a target luna.yaml does not know gets no URL at all: the person follows the steps instead.
    const verifyTarget = targets.find((t) => t.name === targetName) ?? (targetName === null && targets.length === 1 ? targets[0] : undefined);
    const steps = facts.qaDir !== undefined && (await fileExists(join(facts.qaDir, "steps.md"))) ? "follow steps.md in the QA packet" : null;
    const howToVerify = (verifyTarget ? plainUrl(verifyTarget.baseUrl) : null) ?? steps ?? "run the checks in luna.yaml";
    let film = false;
    if (format === "video") {
      if (!videoImage) addNote("the video image is not built");
      else if (!hasVideo && !hasSteps) addNote("the browser run left neither a recording nor replayable steps");
      else if (!deps.video) addNote("the video pipeline is not wired");
      else if (target?.reentrant === false) addNote("the QA target is not re-entrant");
      // A manifest naming a target luna.yaml does not know resolves to none: the film is not recorded against a guess.
      else if (targetName !== null && !target) addNote("the QA target is unknown or not re-entrant");
      else film = true;
      if (!film) format = "captures";
    }
    if (format === "captures" && !hasManifest) {
      addNote("there is no browser run to capture");
      format = "text";
    }
    if (formatRecord) await deps.truth?.learned({ pack: "evidence_format", recordId: formatRecord, label: evidenceFormatTruth(format), source: "evidence_shipped", taskId: task.id });

    // 2. The commit the pack shows.
    let commitSha: string;
    try {
      commitSha = task.worktreePath ? (await deps.headCommit(task.worktreePath)).trim() : "";
    } catch (error) {
      return { outcome: "fail", detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: `cannot read the worktree's head: ${error instanceof Error ? error.message : String(error)}` } };
    }
    if (commitSha === "") return { outcome: "fail", detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: "the task has no worktree to take the evidence commit from" } };

    // 2b. The film: the pipeline runs on the approved scenarios and the browser run's facts; a person's send-back note re-enters it at the fix.
    let video: EvidencePack["video"] | undefined;
    let filmMedia: EvidencePack["media"] = [];
    let spent: { turns: number; costUsd: number } | undefined;
    if (film && deps.video) {
      const sentBack = context.approvals.findLast((a) => a.kind === "awaiting_ship" && a.decision === "sent_back");
      const card = task.evidence ? parseNote(sentBack?.reason ?? null) : null;
      const previousRun = card ? await deps.latestFinish(task.id, "evidence") : null;
      const previousJobDir = previousRun ? join(deps.stateDir, "runs", `${previousRun.runId}-video`) : null;
      const previous = previousJobDir && (await dirExists(previousJobDir)) ? previousJobDir : null;
      const facts_ = assembleEvidencePack({
        task: { title: task.title, description: task.description },
        record: task.record ?? null,
        plan: { rollback: plan?.rollback ?? null, risk: risk.success ? risk.data : null },
        scenarios: facts.scenarios.map((s) => ({ text: s.text, criterion: s.criterion, result: s.result === "pass" || s.result === "partial" || s.result === "skipped" ? s.result : "fail", test: s.test })),
        findings: [],
        outOfMap: [],
        media: [],
        commitSha,
        format: "video",
        howToVerify,
        now: now(),
      });
      const out = await deps.video(context, {
        scenarios: approvedCases(context.approvals),
        record: task.record ?? null,
        pack: { summary: facts_.summary, howToVerify: facts_.howToVerify, risk: facts_.risk },
        e2eDir: facts.qaDir,
        target: target ? { name: target.name, baseUrl: target.baseUrl, credential: target.credential ?? null } : null,
        fixCards: card ? [card] : [],
        previousJobDir: card ? previous : null,
      });
      spent = out.usage;
      if (out.ok) {
        video = out.video;
        filmMedia = out.media;
      } else {
        if (out.rateLimited) return { outcome: "fail", rateLimited: true, detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: out.reason }, usage: { ...out.usage } };
        if (out.video) video = out.video;
        addNote(out.reason);
        format = "captures";
      }
    }

    // 3. The media: the browser run's screenshots, its stitched recording, the manifest and the HAR; none for text.
    const stitched = typeof facts.manifest.video?.file === "string" ? facts.manifest.video.file : null;
    const picked: { path: string; label: string; kind: EvidencePack["media"][number]["kind"] }[] = [];
    if (format !== "text") {
      let screenshots = 0;
      for (const a of facts.artifacts) {
        if (a.kind === "screenshot" && screenshots++ < MEDIA_SCREENSHOTS) picked.push({ path: a.path, label: a.label, kind: "screenshot" });
        else if (a.kind === "video" && stitched !== null && a.label === stitched) picked.push({ path: a.path, label: a.label, kind: "video" });
        else if (a.kind === "qa-manifest" || a.kind === "har") picked.push({ path: a.path, label: a.label, kind: "report" });
      }
    }
    for (const m of filmMedia) picked.push({ path: m.url, label: m.label, kind: m.kind });
    const kept = await store.keep(task.id, commitSha, picked);
    const media = kept.flatMap((k) => {
      const kind = picked.find((p) => p.label === k.label)?.kind;
      return kind ? [{ kind, label: k.label, url: k.path }] : [];
    });

    // 4. The pack.
    const findings = (Array.isArray(verifying?.detail?.findings) ? verifying!.detail!.findings : []).flatMap((f) => {
      const parsed = Finding.safeParse(f);
      return parsed.success ? [parsed.data] : [];
    });
    const answer = objectOf(implementing?.detail?.answer);
    const outOfMap = (Array.isArray(answer?.outOfMap) ? answer.outOfMap : []).flatMap((o) => {
      const item = objectOf(o);
      return typeof item?.path === "string" && typeof item.reason === "string" ? [{ path: item.path, reason: item.reason }] : [];
    });
    const pack = assembleEvidencePack({
      task: { title: task.title, description: task.description },
      record: task.record ?? null,
      plan: { rollback: plan?.rollback ?? null, risk: risk.success ? risk.data : null },
      scenarios: facts.scenarios.map((s) => ({ text: s.text, criterion: s.criterion, result: s.result === "pass" || s.result === "partial" || s.result === "skipped" ? s.result : "fail", test: s.test })),
      findings,
      outOfMap,
      media,
      commitSha,
      format,
      howToVerify,
      ...(note ? { note } : {}),
      ...(video !== undefined ? { video } : {}),
      now: now(),
    });
    const classified = (await deps.latestFinish(task.id, "verifying").catch(() => null))?.detail?.classified;
    const findingRecords = (Array.isArray(classified) ? classified : []).flatMap((row) => (typeof row?.recordId === "string" ? [row.recordId as string] : []));
    await store.writePack(task.id, commitSha, pack);
    await deps.save(task.id, { evidence: pack });

    const evidence = objectOf(result.detail?.evidence) ?? {};
    return {
      ...result,
      ...(spent ? { usage: { turns: spent.turns, costUsd: spent.costUsd } } : {}),
      detail: {
        ...result.detail,
        format,
        ...(formatKept ? { formatKept: true } : {}),
        // The verifier's finding_classify records the pack's findings were judged by: a person shipping with them is the truth.
        ...(findingRecords.length > 0 ? { decisions: { finding_classify: findingRecords } } : {}),
        pack,
        evidence: {
          ...evidence,
          format,
          summary: pack.summary,
          media: pack.media.map((m) => ({ label: m.label, url: m.url })),
          commitSha,
          // The board's ship hint reads it: a High-risk pack needs another approver than the plan's.
          risk: pack.risk,
          ...(note ? { note } : {}),
          ...(pack.video ? { video: pack.video } : {}),
        },
      },
    };
  };
}
