// The design parity review inside the e2e stage (RFC 0013, phase 3): after a passing browser run, the `design_parity` reviewer compares the captures the machine
// holds with the Figma frames, as a sub-run beside the stage's own pack (as `docs_drift` runs beside Verify). The machine settles its answer by rule, maps the
// container paths to its own files, and makes the frame | build pairs. A frame it cannot pair is not compared, never a pass.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DesignParityAnswer, type DesignSpec, type Finding, type PairRow, type VerifyDesignReport } from "@hardness/contracts";

import type { CredentialMount } from "../../adapters/credentials/index.ts";
import type { PairResult } from "../../adapters/image/parity-pairs.ts";
import type { DesignBudget } from "../../domain/design-budget.ts";
import { type SettledParity, type Unplaced, settleParity } from "../../domain/design-parity.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { designRun } from "./design-run.ts";
import type { ParityRun } from "./e2e.ts";

const MOUNT = "/evidence/parity";
const DESIGN = /^\/design\/(\d+-\d+\.png)$/;

export interface DesignParityDeps {
  /** Runs the design_parity pack as a sub-run: its context (the plan, the captures, the spec) and the read-only mount of the machine's copy of the captures. */
  run: (context: StageContext, extra: { parity: { plan: ParityRun["plan"]; captures: ParityRun["captures"]; spec: DesignSpec | null }; mounts: CredentialMount[] }) => Promise<StageResult>;
  /** The approved spec the plan was made from. */
  spec: (context: StageContext) => DesignSpec | null;
  /** The repo's `design.parity.bar`. */
  bar: (repoPath: string | null) => Promise<number>;
  /** Puts a frame render beside its capture (`pairImages`); absent, no pair is made and the rows keep what the reviewer said. */
  pair?: (input: { render: string; capture: string; outDir: string; name: string }) => Promise<PairResult>;
  /** The card's design budget; a spent budget starts no run. */
  budget?: (taskId: string) => Promise<DesignBudget>;
  /** The machine's state dir: the sub-run's folder is `<stateDir>/runs/<runId>-parity`. */
  stateDir: string;
}

export interface DesignParityOutcome {
  /** The `parity` part of the design report (frames carry host paths). */
  report: NonNullable<VerifyDesignReport["parity"]>;
  /** The parity findings, as review Findings. */
  findings: Finding[];
  /** The confident blockers, which go back to Build. */
  blockers: number;
  gate: SettledParity["gate"];
  notes: string[];
  usage?: StageResult["usage"];
  /** The design budget ran out during the run. */
  spentAfter: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const pairName = (index: number, row: PairRow): string => `${index}-${`${row.scenario ?? "x"}-${row.viewport}-${row.state}-${row.frame}`.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);

/**
 * Runs the parity review for the captures the browser run took. Null when there is nothing to review: no planned capture and no cited frame without a viewport.
 * A frame a scenario cites that has no viewport cannot be captured, but it still counts: it is listed as not compared, and that opens the gate.
 * A sub-run that fails, throws or answers off the schema settles as no answer: the gate fires and the stage still passes.
 */
export async function runDesignParity(deps: DesignParityDeps, context: StageContext, parity: ParityRun, unplaced: Unplaced[] = []): Promise<DesignParityOutcome | { escalate: StageResult } | null> {
  if (parity.plan.targets.length === 0 && unplaced.length === 0) return null;
  const spec = deps.spec(context);
  const bar = await deps.bar(context.task.repoPath ?? null);
  const subId = `${context.runId}-parity`;
  const subDir = join(deps.stateDir, "runs", subId);
  let answer: DesignParityAnswer | null = null;
  let usage: StageResult["usage"];
  let spentAfter = false;
  const notes: string[] = [];
  let ran = false;
  // With no capture in the machine's hands there is nothing to review: the planned rows settle as `no capture` without a sub-run.
  if (parity.plan.targets.length > 0 && parity.captures.length > 0) {
    const { result, spentAfter: after } = await designRun(
      { ...(deps.budget ? { budget: deps.budget } : {}) },
      context,
      "design_parity",
      async () => {
        try {
          return await deps.run({ ...context, runId: subId, started: undefined, resume: undefined, engine: undefined } as StageContext, {
            parity: { plan: parity.plan, captures: parity.captures, spec },
            mounts: [{ host: parity.dir, container: MOUNT, readOnly: true }],
          });
        } catch (error) {
          return { outcome: "fail", detail: { error: messageOf(error) } } satisfies StageResult;
        }
      },
    );
    if (result.outcome === "escalated" && result.detail?.escalation === "design_budget") return { escalate: { ...result, detail: { ...result.detail, step: "e2e" } } };
    ran = true;
    spentAfter = after;
    usage = result.usage;
    const parsed = result.outcome === "pass" ? DesignParityAnswer.safeParse(result.detail?.answer) : null;
    if (parsed?.success) answer = parsed.data;
    else notes.push(`the design review gave no usable answer: ${result.outcome !== "pass" ? String(result.detail?.reason ?? result.detail?.error ?? result.outcome) : "its answer did not parse"}`);
  }
  const settled = settleParity(answer, { plan: parity.plan, spec, captures: parity.captures, bar, unplaced });
  notes.push(...settled.notes);

  // The reviewer's paths are the container's: the machine maps them to its own files, then pairs each compared frame. What is not there is not compared.
  const pairsDir = join(subDir, "pairs");
  let made = false;
  const frames: PairRow[] = [];
  for (const [index, row] of settled.frames.entries()) {
    const render = row.render && DESIGN.test(row.render) ? join(subDir, "design", DESIGN.exec(row.render)![1]!) : null;
    const capture = row.capture?.startsWith(`${MOUNT}/`) && !row.capture.split("/").includes("..") ? join(parity.dir, row.capture.slice(MOUNT.length + 1)) : null;
    const host: PairRow = { ...row, capture, render };
    if (row.status !== "compared" || !deps.pair) {
      frames.push(host);
      continue;
    }
    if (!capture || !render) {
      frames.push({ ...host, status: "not_compared", reason: !capture ? "no capture" : "no frame render to pair" });
      continue;
    }
    if (!made) {
      await mkdir(pairsDir, { recursive: true });
      made = true;
    }
    const pair = await deps.pair({ render, capture, outDir: pairsDir, name: pairName(index, row) });
    if (pair.pair === null) frames.push({ ...host, status: "not_compared", reason: pair.note ?? "the frame and the build could not be paired" });
    else frames.push({ ...host, pair: pair.pair, diff: pair.diff, diffRatio: pair.diffRatio });
    if (pair.note) notes.push(`${row.frame} ${row.viewport}-${row.state}: ${pair.note}`);
  }
  const why = [...settled.gate.why];
  if (frames.some((f) => f.scenario !== null && f.status === "not_compared") && !why.includes("not_compared")) why.push("not_compared");

  const counts = { blocker: 0, should_fix: 0, nit: 0, waived: 0 };
  for (const f of settled.findings) counts[f.severity as "blocker" | "should_fix" | "nit"]++;
  return {
    report: { ran, runId: ran ? subId : null, confidence: answer ? settled.confidence : ran ? 0 : null, bar, designInput: settled.designInput, frames, counts, summary: answer?.summary ?? "" },
    findings: settled.findings,
    blockers: settled.blockers,
    gate: { fires: why.length > 0, why },
    notes,
    ...(usage ? { usage } : {}),
    spentAfter,
  };
}
