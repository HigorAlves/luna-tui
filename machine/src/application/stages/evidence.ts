// The evidence stage runs on the host: nothing of it needs a container. It reads what the latest
// e2e run left under `<stateDir>/runs/<runId>/files/qa/`, checks the QA manifest and lists the files
// (the prelude, `evidenceRunner`); `evidenceStage` then picks a format for the change (a decision, with
// a mechanical veto), assembles the Evidence Pack, keeps a local copy of its media and saves the pack
// on the task. The pack and its files show up in the ship approval's `requested`, the gate Ship publishes from.
import { type TruthSink, evidenceFormatTruth, recordIdOf } from "../decision-truth.ts";
import { type ArtifactKind, type EvidenceContext, EvidencePack, Finding, PACKS, Risk, type TaskReports, type TaskState, VerifyReport, applyPolicy } from "@hardness/contracts";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { assembleEvidencePack, packComplete, repairPack } from "../../domain/evidence-pack.ts";
import { type CheckOutput, checksExcerpt, terminalCapture } from "../../domain/terminal-capture.ts";
import { parseNote } from "../../domain/fix-card.ts";
import type { Policy } from "../../domain/policy.ts";
import { approvedCases, approvedPlan, approvedScenarios } from "../../domain/stage-input.ts";
import { EvidenceStore, MAX_MEDIA_BYTES } from "../evidence-store.ts";
import { hashRegularFile, readRegularFile } from "../../adapters/fs/bounded.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import type { VideoPipeline } from "./video.ts";

export interface EvidenceDeps {
  stateDir: string;
  /** The task's latest e2e run and the detail it finished with. */
  latestE2e: (taskId: string) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
  /** The task's latest finish of a stage (`pipeline.latestStageFinish`): where the Verify Report's rows come from. Absent, the prelude reads the e2e finish and the manifest. */
  latestFinish?: (taskId: string, stage: TaskState) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
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

const WALK_MAX_FILES = 2000;
const WALK_MAX_DEPTH = 4;
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024;

/** The files under a container's folder, at most `WALK_MAX_FILES` and `WALK_MAX_DEPTH` levels deep. A link or a FIFO is not listed (`isFile` is false for both). */
async function walk(dir: string, found: string[] = [], depth = 0): Promise<string[]> {
  if (depth >= WALK_MAX_DEPTH || found.length >= WALK_MAX_FILES) return found;
  let entries;
  try {
    entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= WALK_MAX_FILES) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, found, depth + 1);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** A scenario's row as the card holds it: the Verify Report's `e2e.rows`, or the e2e finish's `manifest`. */
interface CardRow {
  scenario: string;
  title: string;
  result: string;
  artifacts: string[];
}

function cardRowsOf(value: unknown): CardRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((r) => {
    const row = objectOf(r);
    if (!row || typeof row.title !== "string" || typeof row.result !== "string") return [];
    return [{ scenario: typeof row.scenario === "string" ? row.scenario : "", title: row.title, result: row.result, artifacts: Array.isArray(row.artifacts) ? row.artifacts.filter((a): a is string => typeof a === "string") : [] }];
  });
  return rows.length > 0 || value.length === 0 ? rows : null;
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
  /** What is missing from the proof, each as a sentence; the pack's note carries them. */
  gaps: string[];
}

async function prelude(deps: EvidenceDeps, context: StageContext): Promise<{ result: StageResult; facts: PreludeFacts }> {
  const e2e = await deps.latestE2e(context.task.id);
  const qaDir = e2e ? join(deps.stateDir, "runs", e2e.runId, "files", "qa") : undefined;
  const manifestPath = qaDir ? join(qaDir, MANIFEST) : undefined;

  // The manifest is written by a container: read through the bounded reader, never followed, never blocked on.
  let verdict: string | undefined;
  let manifest: Manifest = {};
  let manifestState: "ok" | "missing" | "unreadable" = "missing";
  if (manifestPath) {
    try {
      const parsed: unknown = JSON.parse(await readRegularFile(manifestPath, MANIFEST_MAX_BYTES));
      // Anything but an object (null, a list, a number) is an unreadable manifest, not a crash.
      manifest = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Manifest) : {};
      verdict = typeof manifest.verdict === "string" ? manifest.verdict : "unreadable";
      manifestState = verdict === "unreadable" ? "unreadable" : "ok";
    } catch (error) {
      manifestState = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
      if (manifestState === "unreadable") verdict = "unreadable";
    }
  }

  if (verdict === undefined && e2e?.detail?.skipped === true) {
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
      facts: { e2e, qaDir, manifest, manifestPath, verdict: "skipped", scenarios: [], artifacts: [], approvedCount: 0, gaps: [] },
    };
  }

  // Each scenario's result comes from the card: the Verify Report's rows, else the e2e finish's manifest, else (a run from before wave 12a) the container's manifest by title.
  const reported = deps.latestFinish ? VerifyReport.safeParse((await deps.latestFinish(context.task.id, "ci_watch").catch(() => null))?.detail?.report) : null;
  const cardRows = (reported?.success ? cardRowsOf(reported.data.e2e.rows) : null) ?? cardRowsOf(e2e?.detail?.manifest);
  const cardVerdict = reported?.success ? reported.data.e2e.verdict : typeof e2e?.detail?.verdict === "string" ? e2e.detail.verdict : null;
  const gaps: string[] = [];
  if (manifestState === "missing" && !cardRows) gaps.push(`no ${MANIFEST} from the e2e run`);
  if (manifestState === "unreadable") gaps.push(`the ${MANIFEST} of the e2e run is unreadable`);
  verdict = manifestState === "ok" ? verdict! : cardRows && cardVerdict ? cardVerdict : manifestState === "unreadable" ? "unreadable" : "missing";

  const files = qaDir ? await walk(qaDir) : [];
  const artifacts: NonNullable<StageResult["artifacts"]> = [];
  for (const path of files) {
    // A file over the cap, a link swapped in or anything unreadable is listed with no hash, and the store never keeps it.
    const sha256 = await hashRegularFile(path, MAX_MEDIA_BYTES).catch(() => null);
    artifacts.push({ kind: kindOf(path.slice(path.lastIndexOf("/") + 1)), path, label: relative(qaDir!, path), sha256: sha256 ?? "" });
  }
  const approved = verdict === "skipped" || verdict === "unreadable" ? [] : approvedCases(context.approvals);
  const ids = approvedScenarios(context.approvals).map((s) => s.id);
  const legacyRows = Array.isArray(manifest.acceptance) ? manifest.acceptance : [];
  const chapters = Array.isArray(manifest.video?.chapters) ? manifest.video!.chapters! : [];
  const hasVideo = manifest.video !== undefined && manifest.video !== null;
  const scenarios = approved.map((c, i) => {
    const chapter = chapters.find((ch) => typeof ch?.title === "string" && ch.title.trim() === c.title.trim());
    let result = "not_run";
    let test: string | null = null;
    const card = cardRows?.find((r) => (r.scenario !== "" && r.scenario === ids[i]) || r.title.trim() === c.title.trim());
    if (cardRows) {
      if (card) {
        result = card.result === "pass" || card.result === "fail" || card.result === "partial" || card.result === "skipped" ? card.result : "not_run";
        test = card.artifacts[0] ?? null;
      }
    } else {
      const found = legacyRows.find((r) => typeof r?.text === "string" && r.text.trim() === c.title.trim());
      if (found) {
        result = found.result === "pass" || found.result === "fail" || found.result === "partial" ? found.result : "not_run";
        test = Array.isArray(found.evidence) ? (found.evidence.find((e): e is string => typeof e === "string") ?? null) : null;
      }
    }
    return { text: c.title, criterion: c.criterion ?? null, result, chapter: typeof chapter?.start === "number" ? chapter.start : null, hasChapter: chapter !== undefined, test };
  });
  const noRow = scenarios.filter((x) => x.result === "not_run").map((x) => x.text);
  const noChapter = hasVideo ? scenarios.filter((x) => !x.hasChapter).map((x) => x.text) : [];
  if (noRow.length > 0 && manifestState === "ok") gaps.push(`${noRow.length} approved scenario(s) have no manifest row: ${noRow.join(", ")}`);
  else if (noRow.length > 0 && cardRows) gaps.push(`${noRow.length} approved scenario(s) have no run row: ${noRow.join(", ")}`);
  if (noChapter.length > 0) gaps.push(`${noChapter.length} approved scenario(s) have no video chapter: ${noChapter.join(", ")}`);
  if (gaps.length > 0 && verdict === "pass") verdict = "partial";
  const shown = approved.length > 0 ? { rows: cardRows?.length ?? legacyRows.length, scenarios: scenarios.map(({ hasChapter: _, test: __, ...x }) => x) } : {};
  const thumbnails = artifacts.filter((a) => a.kind === "screenshot").slice(0, THUMBNAILS).map((a) => a.path);
  return {
    // Evidence shows less and says why: a gap is a note on the pack, never a failure.
    result: {
      outcome: "pass",
      detail: {
        step: "evidence",
        verdict,
        artifactCount: artifacts.length,
        manifestPath: manifestState === "ok" ? manifestPath : undefined,
        thumbnails,
        ...(gaps.length > 0 ? { note: gaps.join("; ") } : {}),
        // The ship approval's `requested.evidence`, which the board shows.
        evidence: { verdict, artifactCount: artifacts.length, manifest: manifestState === "ok" ? manifestPath : null, thumbnails, ...shown },
      },
      artifacts,
    },
    facts: { e2e, qaDir, manifest, manifestPath: manifestState === "ok" ? manifestPath : undefined, verdict, scenarios, artifacts, approvedCount: approved.length, gaps },
  };
}

/** The script prelude alone: the card's rows and the manifest checked, the files listed. It never fails: what is missing is a note. */
export function evidenceRunner(deps: EvidenceDeps): StageRunner {
  return async (context) => (await prelude(deps, context)).result;
}

export interface EvidenceStageDeps extends EvidenceDeps {
  latestFinish: (taskId: string, stage: TaskState) => Promise<{ runId: string; detail?: Record<string, unknown> } | null>;
  /** The Build and Verify Reports (`pipeline.reports`): the pack's diff summary, the scenarios' tagged tests and results by layer come from the Build Report. */
  reports?: (taskId: string) => Promise<TaskReports>;
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
/** The decision's labels (the diagram's) and the older ones, to the format a pack stores. */
const FORMAT_OF: Record<string, Format> = { video: "video", screenshots_or_terminal: "captures", text_only: "text", captures: "captures", text: "text" };
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

/** A scenario's result as the pack stores it: anything the run did not say plainly is a fail, a scenario with no row is `not_run`. */
const packResult = (result: string): EvidencePack["scenarios"][number]["result"] => (result === "pass" || result === "partial" || result === "skipped" || result === "not_run" ? result : "fail");

const dirExists = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false);
const fileExists = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);

/** The change's Evidence Pack: a format picked from the record and the browser run, the pack assembled on the host, a local copy of its media, the pack on the task. */
export function evidenceStage(deps: EvidenceStageDeps): StageRunner {
  const store = new EvidenceStore(deps.stateDir);
  const now = deps.now ?? (() => new Date());
  return async (context) => {
    const { task } = context;
    const { result, facts } = await prelude(deps, context);

    const plan = approvedPlan(context.approvals);
    const approval = context.approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
    const risk = Risk.safeParse(objectOf(approval?.requested.risk)?.level);
    const implementing = await deps.latestFinish(task.id, "implementing");
    const verifying = await deps.latestFinish(task.id, "verifying");

    // What Verify ran: each check with its command and the end of its output (a row that is a note or a skip has no command).
    const verifyChecks: CheckOutput[] | null = Array.isArray(verifying?.detail?.checks)
      ? (verifying!.detail!.checks as unknown[]).flatMap((c) => {
          const item = objectOf(c);
          return typeof item?.cmd === "string" ? [{ name: typeof item.name === "string" ? item.name : item.cmd, cmd: item.cmd, ok: item.ok === true, tail: typeof item.tail === "string" ? item.tail : "" }] : [];
        })
      : null;
    const buildReport = (await deps.reports?.(task.id).catch(() => null))?.build ?? null;

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
      ...(verifyChecks ? { checks: verifyChecks.length } : {}),
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
          if ((verdict === "proceed" || verdict === "flag") && typeof choice === "string" && Object.hasOwn(FORMAT_OF, choice)) format = FORMAT_OF[choice]!;
        } catch (error) {
          await context.note?.(`evidence_format skipped: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
        }
      }
    }
    // What the prelude found missing is the pack's note: Evidence shows less and says why.
    let note: string | undefined = facts.gaps.length > 0 ? facts.gaps.join("; ") : undefined;
    const addNote = (text: string) => (note = note ? `${note}; ${text}` : text);
    // A re-run (the head moved, a send-back) still reads the latest browser run: when that run proved an older commit, say so on the pack.
    if (task.evidence && task.evidence.commitSha && facts.e2e && task.worktreePath) {
      const head = (await deps.headCommit(task.worktreePath).catch(() => "")).trim();
      if (head && head !== task.evidence.commitSha) addNote(`the browser run proved ${task.evidence.commitSha.slice(0, 7)}; the pack now shows ${head.slice(0, 7)}, which no browser run has seen`);
    }
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
    // No browser run: an API or CLI change is still shown by a terminal capture when Verify ran checks or Build tagged scenario tests; with neither there is nothing to show but text.
    const terminal = format === "captures" && !hasManifest;
    if (terminal && (verifyChecks?.length ?? 0) === 0 && (buildReport?.tests.length ?? 0) === 0) {
      addNote("there is no browser run to capture");
      format = "text";
    }
    if (formatRecord) await deps.truth?.learned({ pack: "evidence_format", recordId: formatRecord, label: evidenceFormatTruth(format), source: "evidence_shipped", taskId: task.id });

    // 2. The commit the pack shows.
    let commitSha: string;
    try {
      commitSha = task.worktreePath ? (await deps.headCommit(task.worktreePath)).trim() : "";
    } catch (error) {
      return { outcome: "fail", detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: `cannot read the worktree's head: ${error instanceof Error ? error.message : String(error)}`, reason: "Evidence cannot read the worktree's head commit" } };
    }
    if (commitSha === "") return { outcome: "fail", detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: "the task has no worktree to take the evidence commit from", reason: "the task has no worktree to take the evidence commit from" } };

    const approvedScenarioList = approvedScenarios(context.approvals);
    const scenarioInputs = facts.scenarios.map((x, i) => ({ text: x.text, criterion: x.criterion, result: packResult(x.result), test: x.test, ...(approvedScenarioList[i]?.id !== undefined ? { id: approvedScenarioList[i]!.id } : {}), layer: approvedScenarioList[i]?.layer ?? null }));

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
        scenarios: scenarioInputs,
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

    // A terminal capture or the checks' excerpt: written from the card, listed as a media line and never inline.
    if (format === "captures" && terminal) {
      const text = terminalCapture({ scenarios: scenarioInputs.map((x) => ({ id: x.id, title: x.text, test: x.test })), tests: buildReport?.tests ?? [], checks: verifyChecks ?? [] });
      const written = await store.keepText(task.id, commitSha, "terminal.txt", text);
      media.push({ kind: "report", label: written.label, url: written.path });
    } else if (format === "text" && (verifyChecks?.length ?? 0) > 0) {
      const written = await store.keepText(task.id, commitSha, "checks.txt", checksExcerpt(verifyChecks!));
      media.push({ kind: "report", label: written.label, url: written.path });
    }

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
    // ci_watch's passing finish carries the Verify Report; the pack takes its v2 fields from it when there is one.
    const reported = VerifyReport.safeParse((await deps.latestFinish(task.id, "ci_watch").catch(() => null))?.detail?.report);
    const assembled = assembleEvidencePack({
      task: { title: task.title, description: task.description },
      record: task.record ?? null,
      plan: { rollback: plan?.rollback ?? null, risk: risk.success ? risk.data : null },
      scenarios: scenarioInputs,
      findings,
      ...(reported.success ? { verifyReport: reported.data } : {}),
      buildReport,
      previous: task.evidence ? { ...(task.evidence.revision !== undefined ? { revision: task.evidence.revision } : {}) } : null,
      outOfMap,
      media,
      commitSha,
      format,
      howToVerify,
      ...(note ? { note } : {}),
      ...(video !== undefined ? { video } : {}),
      now: now(),
    });
    // What a script can fix is fixed before the pack is kept (a commit that is not the head is never repaired: this pack's is).
    const checked = packComplete(assembled, commitSha);
    const pack = checked.ok ? assembled : repairPack(assembled, checked.problems).pack;
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
