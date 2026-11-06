// The evidence stage runs on the host: nothing of it needs a container. It reads what the latest
// e2e run left under `<stateDir>/runs/<runId>/files/qa/`, checks the QA manifest and lists the files
// (the prelude, `evidenceRunner`); `evidenceStage` then picks a format for the change (a decision, with
// a mechanical veto), assembles the Evidence Pack, keeps a local copy of its media and saves the pack
// on the task. The pack and its files show up in the ship approval's `requested`, the gate Ship publishes from.
import { type TruthSink, evidenceFormatTruth, recordIdOf } from "../decision-truth.ts";
import { type ArtifactKind, type EvidenceContext, EvidencePack, Finding, PACKS, Risk, type TaskReports, type TaskState, VerifyReport, applyPolicy } from "@hardness/contracts";
import { mkdir, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { assembleEvidencePack, packComplete, repairPack } from "../../domain/evidence-pack.ts";
import { type CheckOutput, checksExcerpt, terminalCapture } from "../../domain/terminal-capture.ts";
import { parseNote } from "../../domain/fix-card.ts";
import type { Policy } from "../../domain/policy.ts";
import { approvedCases, approvedPlan, approvedScenarios } from "../../domain/stage-input.ts";
import { EvidenceStore, MAX_MEDIA_BYTES, safeName } from "../evidence-store.ts";
import { type PublishEvidence, publishAndReady } from "../evidence-publish.ts";
import { type GitHub, GitHubError } from "../github.ts";
import { copyRegularFile, hashRegularFile, readRegularFile } from "../../adapters/fs/bounded.ts";
import type { FindingKind } from "../../../runner-video/tools/lib/findings.ts";
import { screenFindings } from "../../domain/screen-text.ts";
import { scenariosKeyOf, staleParts } from "../../domain/evidence-stale.ts";
import { privacyTexts } from "../frame-privacy.ts";
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

  // A browser run that was skipped (an API or CLI change) left no manifest: its scenarios are still read from the card's rows below, so the proof Verify and Build gave survives.
  const skippedRun = verdict === undefined && e2e?.detail?.skipped === true;

  // Each scenario's result comes from the card: the Verify Report's rows, else the e2e finish's manifest, else (a run from before wave 12a) the container's manifest by title.
  const reported = deps.latestFinish ? VerifyReport.safeParse((await deps.latestFinish(context.task.id, "ci_watch").catch(() => null))?.detail?.report) : null;
  const cardRows = (reported?.success ? cardRowsOf(reported.data.e2e.rows) : null) ?? cardRowsOf(e2e?.detail?.manifest);
  const cardVerdict = reported?.success ? reported.data.e2e.verdict : typeof e2e?.detail?.verdict === "string" ? e2e.detail.verdict : null;
  const gaps: string[] = [];
  if (manifestState === "missing" && !cardRows && !skippedRun) gaps.push(`no ${MANIFEST} from the e2e run`);
  if (manifestState === "unreadable") gaps.push(`the ${MANIFEST} of the e2e run is unreadable`);
  verdict = skippedRun ? "skipped" : manifestState === "ok" ? verdict! : cardRows && cardVerdict ? cardVerdict : manifestState === "unreadable" ? "unreadable" : "missing";

  const files = qaDir && !skippedRun ? await walk(qaDir) : [];
  const artifacts: NonNullable<StageResult["artifacts"]> = [];
  for (const path of files) {
    // A file over the cap, a link swapped in or anything unreadable is listed with no hash, and the store never keeps it.
    const sha256 = await hashRegularFile(path, MAX_MEDIA_BYTES).catch(() => null);
    artifacts.push({ kind: kindOf(path.slice(path.lastIndexOf("/") + 1)), path, label: relative(qaDir!, path), sha256: sha256 ?? "" });
  }
  const approved = verdict === "unreadable" ? [] : approvedCases(context.approvals);
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
  if (skippedRun) {
    const why = e2e!.detail!.reason ?? e2e!.detail!.note;
    return {
      result: {
        outcome: "pass",
        detail: {
          step: "evidence",
          verdict: "skipped",
          artifactCount: 0,
          thumbnails: [],
          note: `e2e skipped${why ? `: ${String(why)}` : ""}`,
          evidence: { verdict: "skipped", artifactCount: 0, manifest: null, thumbnails: [], ...shown },
        },
      },
      facts: { e2e, qaDir, manifest, manifestPath, verdict: "skipped", scenarios, artifacts: [], approvedCount: approved.length, gaps },
    };
  }
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
  policies: { for: (repoPath: string | null) => Promise<Pick<Policy, "decisions" | "qaTargets"> & Partial<Pick<Policy, "factory">>> };
  /** What publishing inside Evidence needs: the GitHub port, the publish function, and the worktree's GitHub slug. Absent, Ship publishes as before. */
  publishing?: { github: GitHub; publish: PublishEvidence; slugOf: (worktreePath: string) => Promise<string | null> };
  /** Told the format the pack finally shipped with, after the vetoes and the video degrade (RFC 0005 wave 7). */
  truth?: TruthSink | null;
  /** The worktree's HEAD: the commit the pack shows. */
  headCommit: (worktreePath: string) => Promise<string>;
  /** Whether the video image is built on this machine. */
  videoImage: () => Promise<boolean>;
  /** The video pipeline (stages/video.ts); null or absent when the video image is not on this machine. */
  video?: VideoPipeline | null;
  /** The paths changed between two commits of the worktree (host git through `at()`); null when they cannot be read. A film is then made again. */
  changedBetween?: (worktreePath: string, from: string, to: string) => Promise<string[] | null>;
  /** Reads the text on the image files directly in a folder (the video image's `frames --images`); null when it could not run. Absent when there is no video image. */
  scanImages?: (dir: string, signal: AbortSignal) => Promise<{ file: string; text: string; kinds?: FindingKind[]; truncated?: true }[] | null>;
  /** frame_privacy over the screenshots' text, once, after the pattern check found nothing (`judgePrivacy`); absent, the text is not judged. */
  privacy?: (texts: string[], repoPath: string | null, taskId?: string) => Promise<"clear" | "exposed" | "not_judged">;
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
    // A skipped browser run is an API or CLI change: its fallback is the terminal capture (downgraded to text below when Verify and Build gave nothing to show).
    const fallback: Format = hasManifest || skipped ? "captures" : "text";
    let format: Format;
    let formatKept = false;
    let formatRecord: string | undefined;
    if (task.evidence) {
      format = task.evidence.format;
      formatKept = true;
    } else {
      format = fallback;
      const decide = deps.decideFormat;
      if (decide) {
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
    if (formatRecord) await deps.truth?.learned({ pack: "evidence_format", recordId: formatRecord, label: evidenceFormatTruth(format), kind: "fact", source: "evidence_shipped", taskId: task.id });

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

    // 2a. What this head made stale: a pack of another commit keeps what the new commit did not touch (a film above all) and makes the rest again.
    const approvedList = approvedScenarios(context.approvals);
    const stepsSha = facts.qaDir ? await hashRegularFile(join(facts.qaDir, "steps.jsonl"), 20 * 1024 * 1024).catch(() => null) : null;
    const source = { e2eRunId: facts.e2e?.runId ?? null, scenariosKey: scenariosKeyOf(approvedList.map((s) => ({ id: s.id ?? "", title: s.title }))), stepsSha };
    const previous = task.evidence;
    let reuse: { video: NonNullable<EvidencePack["video"]>; media: EvidencePack["media"] } | null = null;
    if (previous && previous.commitSha && previous.commitSha !== commitSha) {
      const changedPaths = deps.changedBetween && task.worktreePath ? await deps.changedBetween(task.worktreePath, previous.commitSha, commitSha).catch(() => null) : null;
      const parts = staleParts(previous, { ...source, results: facts.scenarios.map((x) => x.result), changedPaths });
      await context.emit?.("evidence.stale", { from: previous.commitSha.slice(0, 7), to: commitSha.slice(0, 7), parts }).catch(() => {});
      // A film that is not stale is copied from the machine's own store of the old commit, never from a container's folder.
      // What was kept is read from the machine's own pack of the old commit: the task row's pack holds release urls once it was published.
      const oldDir = store.dirFor(task.id, previous.commitSha);
      const local = await store.readPack(task.id, previous.commitSha);
      const filmFiles = (local?.media ?? []).filter((m) => (m.kind === "video" || m.kind === "cover" || m.kind === "captions" || m.kind === "audio") && m.url.startsWith(`${oldDir}/`));
      if (film && !parts.includes("film") && local?.video && local.format === "video" && filmFiles.some((m) => m.kind === "video")) reuse = { video: local.video, media: filmFiles };
    }

    // 2b. The film: the pipeline runs on the approved scenarios and the browser run's facts; a person's send-back note re-enters it at the fix.
    let video: EvidencePack["video"] | undefined;
    let filmMedia: EvidencePack["media"] = [];
    let spent: { turns: number; costUsd: number } | undefined;
    if (reuse) {
      video = reuse.video;
      filmMedia = reuse.media;
    } else if (film && deps.video) {
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
        if (out.note) addNote(out.note);
        video = out.video;
        // The film passed the frame check (a degraded one has no media): its video says so.
        filmMedia = out.media.map((m) => (m.kind === "video" ? { ...m, scanned: true } : m));
      } else {
        if (out.rateLimited) return { outcome: "fail", rateLimited: true, detail: { step: "evidence", verdict: "missing", artifactCount: 0, error: out.reason }, usage: { ...out.usage } };
        if (out.video) video = out.video;
        addNote(out.reason);
        format = "captures";
      }
    }

    // 3. The media: the browser run's screenshots, its stitched recording, the manifest and the HAR; none for text.
    const stitched = typeof facts.manifest.video?.file === "string" ? facts.manifest.video.file : null;
    const picked: { path: string; label: string; kind: EvidencePack["media"][number]["kind"]; scanned?: boolean }[] = [];
    if (format !== "text") {
      let screenshots = 0;
      for (const a of facts.artifacts) {
        if (a.kind === "screenshot" && screenshots++ < MEDIA_SCREENSHOTS) picked.push({ path: a.path, label: a.label, kind: "screenshot" });
        else if (a.kind === "video" && stitched !== null && a.label === stitched) picked.push({ path: a.path, label: a.label, kind: "video", scanned: false });
        else if (a.kind === "har") picked.push({ path: a.path, label: a.label, kind: "har" });
        else if (a.kind === "qa-manifest") picked.push({ path: a.path, label: a.label, kind: "report" });
      }
    }
    // The text on the screenshots is read before anything is kept: a token, a key or personal data leaves the screenshot out. Nobody sees them before they are public.
    const shots = picked.filter((p) => p.kind === "screenshot");
    if (shots.length > 0) {
      const dir = join(deps.stateDir, "runs", `${context.runId}-shots`);
      // A copy is named by its index and its extension, never by its label: two labels that flatten to one name would be one file read for two.
      const copies = new Map<(typeof shots)[number], string>();
      let frames: Awaited<ReturnType<NonNullable<typeof deps.scanImages>>> | null = null;
      if (deps.scanImages) {
        await mkdir(dir, { recursive: true });
        for (const [i, p] of shots.entries()) {
          const name = `${i}${IMAGES.has(extname(p.label).toLowerCase()) ? extname(p.label).toLowerCase() : ".png"}`;
          if (await copyRegularFile(p.path, join(dir, name)).then(() => true, () => false)) copies.set(p, name);
        }
        frames = await deps.scanImages(dir, context.signal).catch(() => null);
      }
      if (!frames) {
        for (const p of shots) p.scanned = false;
        if (deps.scanImages) addNote("the text on the screenshots was not read");
      } else {
        const hits = screenFindings(frames);
        const bad = new Set(hits.map((h) => h.place));
        // Read means: copied, and the answer has exactly one entry of its own for the copy, whose text was not cut.
        const entryOf = (name: string | undefined) => {
          const entries = frames!.filter((f) => f.file === name);
          return name !== undefined && entries.length === 1 ? entries[0]! : null;
        };
        for (const p of shots) {
          const entry = entryOf(copies.get(p));
          p.scanned = entry !== null && entry.truncated !== true;
        }
        const left = shots.filter((p) => bad.has(copies.get(p) ?? "\u0000"));
        for (const p of left) picked.splice(picked.indexOf(p), 1);
        const unread = shots.filter((p) => !left.includes(p) && p.scanned === false).length;
        if (left.length > 0) addNote(`${left.length} screenshot(s) left out: a ${[...new Set(hits.map((h) => h.kind))].join(", a ")} was on screen`);
        if (unread > 0) addNote(`${unread} screenshot(s) not read whole: they stay local copies until a person approves`);
        if (left.length === 0 && deps.privacy) {
          const judgedText = await deps.privacy(privacyTexts(frames), task.repoPath, task.id).catch(() => "not_judged" as const);
          if (judgedText === "exposed") {
            const count = shots.length;
            for (const p of shots) picked.splice(picked.indexOf(p), 1);
            addNote(`${count} screenshot(s) left out: the on-screen text may show personal data or a credential`);
          } else if (judgedText === "not_judged") addNote("the on-screen text was not judged");
        }
      }
    }
    for (const m of filmMedia) picked.push({ path: m.url, label: m.label, kind: m.kind, ...(m.scanned !== undefined ? { scanned: m.scanned } : {}) });
    const kept = await store.keep(task.id, commitSha, picked);
    const media = kept.flatMap((k) => {
      const p = picked[k.index];
      return p ? [{ kind: p.kind, label: k.label, url: k.path, ...(p.scanned !== undefined ? { scanned: p.scanned } : {}) }] : [];
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
    const assembledBase = assembleEvidencePack({
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
    const assembled: EvidencePack = { ...assembledBase, source };
    // What a script can fix is fixed before the pack is kept (a commit that is not the head is never repaired: this pack's is).
    const checked = packComplete(assembled, commitSha);
    const pack = checked.ok ? assembled : repairPack(assembled, checked.problems).pack;
    const classified = (await deps.latestFinish(task.id, "verifying").catch(() => null))?.detail?.classified;
    const findingRecords = (Array.isArray(classified) ? classified : []).flatMap((row) => (typeof row?.recordId === "string" ? [row.recordId as string] : []));
    await store.writePack(task.id, commitSha, pack);
    await deps.save(task.id, { evidence: pack });

    // Publish and mark ready, inside Evidence, unless the repository keeps the preview gate. It only publishes what GitHub already has (the PR whose head is this
    // pack's commit); it never pushes. Anything that stops it is a reason on the detail, never a failure: Ship publishes on its own path.
    let shipped: { published: boolean; readied?: boolean; why?: string; pack?: EvidencePack } = { published: false, why: "publishing is not wired" };
    if (deps.publishing) {
      const preview = (await deps.policies.for(task.repoPath)).factory?.ship.preview === "on";
      if (preview) shipped = { published: false, why: "ship.preview is on: the pack is published after the gate" };
      else {
        try {
          const slug = task.worktreePath && task.branch ? await deps.publishing.slugOf(task.worktreePath) : null;
          const found = slug && task.branch ? await deps.publishing.github.findPr(slug, task.branch) : null;
          if (!slug || !found) shipped = { published: false, why: "no PR for this branch yet" };
          else {
            const head = await deps.publishing.github.prHeadSha(slug, found.number);
            if (head !== pack.commitSha) shipped = { published: false, why: `the PR head on GitHub is not the pack's commit (${(head ?? "unknown").slice(0, 7)}, not ${pack.commitSha.slice(0, 7)})` };
            else {
              const done = await publishAndReady(
                { github: deps.publishing.github, publish: deps.publishing.publish, save: (id, p) => deps.save(id, { evidence: p }), stateDir: deps.stateDir, localDir: (id, sha) => store.dirFor(id, sha), truth: deps.truth },
                { task: { id: task.id, repoPath: task.repoPath ?? null }, slug, number: found.number, headSha: head, draft: found.isDraft, pack, approved: false },
              );
              if (done.published) {
                shipped = { published: true, readied: done.readied, pack: done.pack };
                await context.emit?.("evidence.published", { number: found.number, assets: done.assets, revision: pack.revision ?? 1 }).catch(() => {});
              } else shipped = { published: false, why: done.reason };
            }
          }
        } catch (error) {
          shipped = { published: false, why: error instanceof GitHubError ? "GitHub is not reachable with a token" : `publishing failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}` };
        }
      }
    }

    const evidence = objectOf(result.detail?.evidence) ?? {};
    return {
      ...result,
      ...(spent ? { usage: { turns: spent.turns, costUsd: spent.costUsd } } : {}),
      detail: {
        ...result.detail,
        format,
        published: shipped.published,
        ...(shipped.readied !== undefined ? { readied: shipped.readied } : {}),
        ...(shipped.why ? { publishedWhy: shipped.why } : {}),
        ...(formatKept ? { formatKept: true } : {}),
        // The verifier's finding_classify records the pack's findings were judged by: a person shipping with them is the truth.
        ...(findingRecords.length > 0 ? { decisions: { finding_classify: findingRecords } } : {}),
        pack: shipped.pack ?? pack,
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
