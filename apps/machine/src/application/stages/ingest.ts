// Reads what a stage pack left in its /out folder: result.json, events.jsonl and the
// artifact files. Artifacts are copied under the machine's state dir so they outlive the
// run's scratch folder. events.jsonl holds the run's whole event stream (text, every tool call
// with its guard's decision, usage); only the facts for the task's log are taken from it, the
// rest stays in the file.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";

import { copyRegularFile, readRegularFile } from "../../adapters/fs/bounded.ts";
import { dirname, isAbsolute, join, sep } from "node:path";

import { isReservedKind } from "../../domain/reserved-kinds.ts";
import { type ArtifactKind, StageOutput, isStreamEvent } from "@hardness/contracts";

import type { StageResult } from "../ports.ts";

export interface IngestedEvent {
  at: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface IngestedArtifact {
  kind: ArtifactKind;
  /** Absolute host path of the copy. */
  path: string;
  label: string;
  sha256: string;
}

export interface Ingested {
  output: StageOutput;
  events: IngestedEvent[];
  artifacts: IngestedArtifact[];
}

/** `by: "ui-designer"` marks the helper's rows so Build's budget skips them: the machine sets it from the run's pack, over whatever the container wrote, and no other run's row may carry it. */
function stamp(event: IngestedEvent, pack: string | undefined): void {
  if (pack === "ui_design") event.payload = { ...event.payload, by: "ui-designer" };
  else if (event.payload.by === "ui-designer") {
    const { by: _by, ...rest } = event.payload;
    event.payload = rest;
  }
}

const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code !== "ENOENT";

/** What the host reads of a container's result and events: a regular file within these caps, never a link or a FIFO. */
const RESULT_CAP = 8 * 1024 * 1024;
const EVENTS_CAP = 32 * 1024 * 1024;

export async function ingestStageOutput(opts: {
  outDir: string;
  runId: string;
  stateDir: string;
  /** The run's pack, known to the machine: a `ui_design` run's rows are stamped as the ui-designer's. */
  pack?: string;
}): Promise<Ingested> {
  const { outDir, runId, stateDir, pack } = opts;
  const raw = await readRegularFile(join(outDir, "result.json"), RESULT_CAP);
  const parsed = StageOutput.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid result.json: ${issues.join("; ")}`);
  }
  const output = parsed.data;

  const events: IngestedEvent[] = [];
  let lines = "";
  try {
    lines = await readRegularFile(join(outDir, "events.jsonl"), EVENTS_CAP);
  } catch (error) {
    if (exists(error)) throw error;
  }
  let dropped = 0;
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const item = JSON.parse(line) as Partial<IngestedEvent>;
      if (typeof item.kind !== "string") throw new Error("no kind");
      if (isStreamEvent({ kind: item.kind })) continue;
      // A container can write any line: one whose stored kind is a row only the machine writes is not taken.
      if (isReservedKind(item.kind)) {
        dropped += 1;
        continue;
      }
      events.push({
        at: typeof item.at === "string" ? item.at : new Date().toISOString(),
        kind: item.kind,
        payload: item.payload && typeof item.payload === "object" ? item.payload : {},
      });
      stamp(events.at(-1)!, pack);
    } catch {
      events.push({ at: new Date().toISOString(), kind: "stage.malformed", payload: { line } });
    }
  }

  if (dropped > 0) events.push({ at: new Date().toISOString(), kind: "note", payload: { note: `${dropped} container event${dropped === 1 ? "" : "s"} of a kind only the machine writes ${dropped === 1 ? "was" : "were"} dropped` } });

  const artifacts: IngestedArtifact[] = [];
  const base = join(stateDir, "runs", runId, "files");
  for (const artifact of output.artifacts) {
    // Artifact paths are relative to /out and already start with files/ (files/qa/qa-manifest.json);
    // mirror them under runs/<id>/files/ without doubling that prefix, which is where the
    // evidence stage (runs/<id>/files/qa/) and the board expect them.
    const dest = join(base, artifact.path.replace(/^files\//, ""));
    const src = join(outDir, artifact.path);
    // The path is the container's word: it stays inside /out by its text (relative, no ..) and by where its folder really is (no linked directory on the way).
    const skip = (reason: string) => events.push({ at: new Date().toISOString(), kind: "note", payload: { skipped: true, path: artifact.path, label: artifact.label, reason } });
    if (isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
      skip("path outside the output folder");
      continue;
    }
    const [realOut, realParent] = await Promise.all([realpath(outDir), realpath(dirname(src)).catch(() => null)]);
    if (realParent !== null && realParent !== realOut && !realParent.startsWith(realOut + sep)) {
      skip("path outside the output folder");
      continue;
    }
    // The container wrote /out: a link there would make the copy read whatever host file it points at.
    const info = await lstat(src).catch(() => null);
    if (info && !info.isFile()) {
      skip("not a regular file");
      continue;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyRegularFile(src, dest);
    } catch (error) {
      if (exists(error)) throw error;
      events.push({
        at: new Date().toISOString(),
        kind: "note",
        payload: { missing: true, path: artifact.path, label: artifact.label },
      });
      continue;
    }
    const sha256 =
      artifact.sha256 || createHash("sha256").update(await readFile(dest)).digest("hex");
    artifacts.push({ kind: artifact.kind, path: dest, label: artifact.label, sha256 });
  }

  return { output, events, artifacts };
}

export function toStageResult({ output, events, artifacts }: Ingested): StageResult {
  return {
    outcome: output.outcome,
    rateLimited: output.rateLimited || undefined,
    detail: {
      summary: output.summary,
      ...(output.answer ? { answer: output.answer } : {}),
      needsInput: output.needsInput,
      requested: output.requested,
      findings: output.findings,
      slices: output.slices,
      commit: output.commit,
      error: output.error,
      ...(output.resetsAt !== null ? { resetsAt: output.resetsAt } : {}),
      ...(output.ledger ? { ledger: output.ledger } : {}),
      ...(output.sessionId ? { sessionId: output.sessionId } : {}),
    },
    usage: { turns: output.usage.turns, costUsd: output.usage.costUsd, tokens: output.usage.tokens ?? null },
    needsInput: output.needsInput ?? undefined,
    requested: output.requested,
    findings: output.findings,
    events,
    artifacts,
    run: { outputCommit: output.commit ?? undefined, ...(output.run ? { info: output.run } : {}) },
  };
}
