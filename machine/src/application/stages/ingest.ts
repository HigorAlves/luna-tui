// Reads what a stage pack left in its /out folder: result.json, events.jsonl and the
// artifact files. Artifacts are copied under the machine's state dir so they outlive the
// run's scratch folder.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ArtifactKind, StageOutput } from "@hardness/contracts";

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

const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code !== "ENOENT";

export async function ingestStageOutput(opts: {
  outDir: string;
  runId: string;
  stateDir: string;
}): Promise<Ingested> {
  const { outDir, runId, stateDir } = opts;
  const raw = await readFile(join(outDir, "result.json"), "utf8");
  const parsed = StageOutput.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid result.json: ${issues.join("; ")}`);
  }
  const output = parsed.data;

  const events: IngestedEvent[] = [];
  let lines = "";
  try {
    lines = await readFile(join(outDir, "events.jsonl"), "utf8");
  } catch (error) {
    if (exists(error)) throw error;
  }
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const item = JSON.parse(line) as Partial<IngestedEvent>;
      if (typeof item.kind !== "string") throw new Error("no kind");
      events.push({
        at: typeof item.at === "string" ? item.at : new Date().toISOString(),
        kind: item.kind,
        payload: item.payload && typeof item.payload === "object" ? item.payload : {},
      });
    } catch {
      events.push({ at: new Date().toISOString(), kind: "orc.malformed", payload: { line } });
    }
  }

  const artifacts: IngestedArtifact[] = [];
  const base = join(stateDir, "runs", runId, "files");
  for (const artifact of output.artifacts) {
    // orc's paths are relative to /out and already start with files/ (files/qa/qa-manifest.json);
    // mirror them under runs/<id>/files/ without doubling that prefix, which is where the
    // evidence stage (runs/<id>/files/qa/) and the board expect them.
    const dest = join(base, artifact.path.replace(/^files\//, ""));
    try {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(outDir, artifact.path), dest);
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
    },
    usage: { turns: output.usage.turns, costUsd: output.usage.costUsd },
    needsInput: output.needsInput ?? undefined,
    requested: output.requested,
    findings: output.findings,
    events,
    artifacts,
    run: { outputCommit: output.commit ?? undefined },
  };
}
