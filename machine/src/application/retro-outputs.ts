// What the retro's outputs become (RFC 0006 wave 13, decision 25): "applied" means recorded where it is used, never written into prompts or rules by itself.
// Recalibration is a file the eval loop reads; a graph miss goes to the graph's misses file only when the card's own Build Report declared the same path; rules and
// proposals reach the repository only as a draft PR after a person's `a` (the close step), with the proposals inert in its body.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ShipContext } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { truthName, writeTruthFile } from "./ground-truth.ts";

type RetroFacts = NonNullable<ShipContext["retro"]>;

export interface RetroTruth {
  schema: 1;
  taskId: string;
  table: Record<string, { predicted?: string | number; actual?: string | number }>;
  retroRan: boolean;
  recalibration: Array<{ dimension: string; predicted: string; actual: string; note: string }>;
  adopted: boolean;
}

const NOTE_CAP = 300;
const cap = (text: unknown, n: number): string => safe(String(text ?? "")).slice(0, n);

/** The predicted-against-actual table from the machine's own facts, the retro's notes when one ran, and whether its proposals were adopted. */
export function retroTruthOf(input: { taskId: string; facts: RetroFacts; retro: { recalibration?: unknown } | null; adopted: boolean }): RetroTruth {
  const { facts } = input;
  const table: RetroTruth["table"] = {
    size: { ...(facts.predicted.size ? { predicted: facts.predicted.size } : {}), actual: facts.actual.added + facts.actual.removed },
    risk: { ...(facts.predicted.risk ? { predicted: facts.predicted.risk } : {}) },
    ...(facts.predicted.urgency ? { urgency: { predicted: facts.predicted.urgency } } : {}),
    iterations: { actual: facts.actual.retries.total },
    escalations: { actual: facts.actual.escalations },
    format: { ...(facts.actual.format ? { actual: facts.actual.format } : {}) },
  };
  const rows = Array.isArray(input.retro?.recalibration) ? (input.retro!.recalibration as Array<Record<string, unknown>>).slice(0, 20) : [];
  return {
    schema: 1,
    taskId: input.taskId,
    table,
    retroRan: input.retro !== null,
    recalibration: rows.map((r) => ({ dimension: cap(r.dimension, 40), predicted: cap(r.predicted, 80), actual: cap(r.actual, 80), note: cap(r.note, NOTE_CAP) })),
    adopted: input.adopted,
  };
}

export async function writeRetroTruth(stateDir: string, doc: RetroTruth): Promise<string> {
  return writeTruthFile(stateDir, "retro", `${truthName(doc.taskId.replace(/[^A-Za-z0-9-]/g, "_"))}.json`, doc);
}

/** A path in the retro's `graphMisses[]` counts only when it is also one of the card's files outside the map; one only the model names is dropped. */
export function acceptedMisses(graphMisses: unknown, declared: readonly string[]): string[] {
  if (!Array.isArray(graphMisses)) return [];
  const known = new Set(declared);
  return [...new Set(graphMisses.filter((p): p is string => typeof p === "string" && known.has(p)))].slice(0, 50);
}

/** What `Pipeline` needs to record a merged card's retro. */
export interface RetroOutputs {
  stateDir: string;
  facts: (taskId: string) => Promise<RetroFacts | null>;
  graph?: { recordMisses(repoPath: string, miss: { task: string; at: string; files: string[] }): Promise<void> };
  /** The card's files outside the code map, from its Build Report. */
  declaredFiles?: (taskId: string) => Promise<string[]>;
}

/** The verify ground-truth file of a card: what a person added or dismissed at Ship, as data for the verifier's calibration. Text through `safe()`, capped; never on the event stream. */
async function updateVerifyTruth(stateDir: string, taskId: string, change: (doc: { schema: 1; taskId: string; added: unknown[]; dismissed?: unknown[] }) => void): Promise<void> {
  const name = `${truthName(taskId.replace(/[^A-Za-z0-9-]/g, "_"))}.json`;
  const file = join(stateDir, "ground-truth", "verify", name);
  let doc: { schema: 1; taskId: string; added: unknown[]; dismissed?: unknown[] } = { schema: 1, taskId, added: [] };
  try {
    const old = JSON.parse(await readFile(file, "utf8")) as typeof doc;
    if (Array.isArray(old.added)) doc = old;
  } catch {
    // no file yet
  }
  change(doc);
  await writeTruthFile(stateDir, "verify", name, doc);
}

/** A finding a person added at Ship. It has no decision record to label. */
export async function appendAddedFinding(stateDir: string, taskId: string, finding: { title: string; severity: string; path?: string | undefined; line?: number | undefined }): Promise<void> {
  await updateVerifyTruth(stateDir, taskId, (doc) => {
    doc.added = [...doc.added, { title: cap(finding.title, 200), severity: finding.severity, ...(finding.path ? { path: cap(finding.path, 300) } : {}), ...(finding.line ? { line: finding.line } : {}), at: new Date().toISOString() }].slice(-50);
  });
}

/** A finding a person dismissed at Ship, with the reason they typed when they gave one. */
export async function appendDismissedFinding(stateDir: string, taskId: string, dismissal: { id: string; reason?: string | undefined }): Promise<void> {
  await updateVerifyTruth(stateDir, taskId, (doc) => {
    const reason = dismissal.reason ? cap(dismissal.reason, NOTE_CAP) : "";
    doc.dismissed = [...(Array.isArray(doc.dismissed) ? doc.dismissed : []), { id: cap(dismissal.id, 200), ...(reason ? { reason } : {}), at: new Date().toISOString() }].slice(-50);
  });
}
