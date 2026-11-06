// Harvest: decision records become cases (`evals/<pack>/cases/<id>/{stage.json,expect.json}`). The
// record's context is scrubbed first; a record the scrub refuses is named and left out. A case that
// exists is never overwritten: the repository is the source of truth, reviewed in a PR.
import { type DecisionRecord, type PackId, type StageInput, eventClassOf } from "@hardness/contracts";
import { type ContextPackId, buildContextPackInput, contextSchema, isContextPack } from "@hardness/machine/decisions";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Expect } from "./expect.ts";
import { type Label, checksOf, decisionPack, rubricOf } from "./labels.ts";
import { scrubContext } from "./scrub.ts";

export interface CaseFiles {
  id: string;
  stage: StageInput;
  expect: Expect;
}

/** A case id from a name that may hold anything: letters, digits, dots, dashes, underscores; never a path. */
export function caseIdOf(name: string): string | null {
  const id = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return id === "" ? null : id;
}

/** The case a label makes of a context already scrubbed: `stage.json` as the machine builds a pack's input (no engine), the checks from the label. */
export function caseOf(pack: PackId, id: string, context: Record<string, unknown>, label: Label | null, extra: Partial<Expect> = {}): CaseFiles {
  const decision = decisionPack(pack);
  if (!decision || !isContextPack(pack)) throw new Error(`${pack} is not a decision pack`);
  const stage = buildContextPackInput(pack as ContextPackId, contextSchema(pack as ContextPackId).parse(context));
  const expect: Expect = {
    schema: 1,
    checks: label ? checksOf(label) : [],
    rubric: rubricOf(decision, label),
    ...(label ? { label } : { review: true }),
    ...extra,
  };
  return { id, stage, expect };
}

/** Writes the case unless one is there; true when it wrote. */
export function writeCase(evalsDir: string, pack: PackId, files: CaseFiles): boolean {
  const dir = join(evalsDir, pack, "cases", files.id);
  if (existsSync(dir)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stage.json"), `${JSON.stringify(files.stage, null, 2)}\n`);
  writeFileSync(join(dir, "expect.json"), `${JSON.stringify(files.expect, null, 2)}\n`);
  return true;
}

export interface HarvestReport {
  written: string[];
  kept: string[];
  refused: Array<{ id: string; reason: string }>;
}

/** A label stored before the nine classes reads as the class it became. */
function currentLabel(pack: PackId, label: Label | null): Label | null {
  const choice = pack === "event_class" ? (label as { event?: { choice?: unknown } } | null)?.event?.choice : undefined;
  const now = typeof choice === "string" ? eventClassOf(choice) : null;
  return now ? ({ event: { choice: now } } as Label) : label;
}

/** The harvest of `records` (one pack's) into `evalsDir`: scrub, write, report. */
export function harvest(evalsDir: string, pack: PackId, records: DecisionRecord[]): HarvestReport {
  const report: HarvestReport = { written: [], kept: [], refused: [] };
  for (const record of records) {
    const id = caseIdOf(`rec-${record.id.slice(0, 8)}`)!;
    // A private conversation's text never becomes a case.
    if ((record.context as { conversation?: { private?: unknown } }).conversation?.private === true) {
      report.refused.push({ id: record.id, reason: "a private conversation: its text never becomes a case" });
      continue;
    }
    const scrubbed = scrubContext(record.context);
    if (!scrubbed.ok) {
      report.refused.push({ id: record.id, reason: scrubbed.reason });
      continue;
    }
    let files: CaseFiles;
    try {
      files = caseOf(pack, id, scrubbed.value, currentLabel(pack, (record.truth?.label as Label | undefined) ?? null), { recordId: record.id, traceId: record.traceId, modelAnswer: record.answer });
    } catch (error) {
      report.refused.push({ id: record.id, reason: `the context is off the pack's schema: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
      continue;
    }
    (writeCase(evalsDir, pack, files) ? report.written : report.kept).push(id);
  }
  return report;
}
