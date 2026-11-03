// What a stage leaves behind: /out/result.json (the StageOutput contract), /out/events.jsonl
// and the artifact index over /out/files/**. One function, called however the run ended, so
// the machine always finds a result.
import type { Ledger, Pack, RunEvent, RunInfo, StageArtifact, StageOutcome, StageOutput } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** What the run leaves for the result besides its outcome: the luna tools' slice ledger and every
 *  event the run emitted, in order. */
export interface RunRecord {
  ledger: Ledger;
  events: RunEvent[];
  /** What the run ran on and its fingerprint; null when no runtime ran it (a script pack). */
  run?: RunInfo | null;
}

/** How the model run ended, as the runner saw it. */
export interface RunOutcome {
  ok: boolean;
  structured: Record<string, unknown> | null;
  text: string;
  error: string | null;
  turns: number;
  costUsd: number | null;
  durationMs: number;
  model: string;
  rateLimited: boolean;
  resetsAt: number | null;
  sessionId: string | null;
}

export const EMPTY_RUN: RunOutcome = {
  ok: false,
  structured: null,
  text: "",
  error: null,
  turns: 0,
  costUsd: null,
  durationMs: 0,
  model: "",
  rateLimited: false,
  resetsAt: null,
  sessionId: null,
};

const kindOf = (rel: string): StageArtifact["kind"] => {
  const b = basename(rel);
  if (b === "qa-manifest.json") return "qa-manifest";
  if (b === "findings.json") return "findings";
  if (b === "rules.md") return "rules";
  if (b === "report.html") return "report";
  if (/\.(png|jpe?g)$/i.test(b)) return "screenshot";
  if (/\.(webm|mp4)$/i.test(b)) return "video";
  if (/\.har$/i.test(b)) return "har";
  if (/\.diff$/i.test(b)) return "diff";
  if (rel.startsWith("files/tests/")) return "test";
  return "report";
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : [],
  );

/** Every file under /out/files, as the contract's artifact rows. */
export function scanArtifacts(outDir: string): StageArtifact[] {
  const root = join(outDir, "files");
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return walk(root)
    .map((abs) => relative(outDir, abs))
    .sort()
    .map((rel) => ({
      kind: kindOf(rel),
      path: rel,
      label: basename(rel),
      sha256: createHash("sha256").update(readFileSync(join(outDir, rel))).digest("hex"),
    }));
}

/** The zod issues as one line: `path: message; ...`. */
const issuesLine = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");

/** The error a runtime reports when the pack's own budget for the run (its turns, its token
 *  budget) ran out: never a rate limit, since no provider reset would resume it. */
const BUDGET_SPENT = "the pack's own budget for this run is spent";
export const budgetSpent = (detail: string): string => `${BUDGET_SPENT}: ${detail}`;

/** The error a runtime reports when it ended the stage at its deadline. */
export const timeRanOut = (ms: number): string => `the stage's time ran out after ${ms} ms with no answer`;

/** The run as the result reports it, whatever runtime produced it: an answer given as JSON text
 *  is taken when it is one the pack's schema accepts, so a stage is not lost to the channel; an
 *  answer off the schema fails the run with the issue, and so does a run that ended with no
 *  answer at all, whatever text it left; a provider's usage or rate limit error is a rate limit,
 *  the pack's own spent budget is not. */
export function settle(run: RunOutcome, pack: Pack): RunOutcome {
  const settled = { ...run };
  let answer: unknown = settled.structured;
  if (settled.ok && answer === null && settled.text.trim() !== "") {
    try {
      answer = JSON.parse(settled.text);
    } catch {}
  }
  if (settled.ok && answer !== null) {
    const parsed = pack.answer.safeParse(answer);
    settled.structured = parsed.success ? (parsed.data as Record<string, unknown>) : null;
    if (!parsed.success) {
      settled.ok = false;
      settled.error = `answer off the ${pack.id} schema: ${issuesLine(parsed.error)}`;
    }
  }
  if (settled.ok && settled.structured === null) {
    settled.ok = false;
    const text = settled.text.trim();
    settled.error = text ? `no answer the ${pack.id} schema accepts: the run ended with text, not a structured answer: ${text.slice(0, 200)}` : "no structured output";
  }
  if (settled.error && !settled.error.startsWith(BUDGET_SPENT) && /usage limit|rate limit/i.test(settled.error)) settled.rateLimited = true;
  return settled;
}

/** The outcome the machine acts on, from the pack's structured answer. */
export function outcomeOf(run: RunOutcome): StageOutcome {
  const s = run.structured ?? {};
  const asked = s.kind === "questions" || (Array.isArray(s.questions) && s.questions.length > 0);
  if (asked) return "needs_input";
  if (s.kind === "test_change") return "test_change";
  if (s.kind === "escalated") return "escalated";
  return run.ok ? "pass" : "fail";
}

/** Writes result.json and events.jsonl, every event in order and the stage's end last; returns
 *  what it wrote. */
export function finish(outDir: string, pack: Pack, run: RunOutcome, state: RunRecord): StageOutput {
  mkdirSync(outDir, { recursive: true });
  const s = run.structured ?? {};
  if (typeof s.rulesMarkdown === "string" && s.rulesMarkdown.trim()) {
    mkdirSync(join(outDir, "files"), { recursive: true });
    const md = s.rulesMarkdown;
    writeFileSync(join(outDir, "files", "rules.md"), md.endsWith("\n") ? md : `${md}\n`);
  }
  const outcome = outcomeOf(run);
  const asked = outcome === "needs_input";
  const questions = Array.isArray(s.questions) ? (s.questions as StageOutput["needsInput"]) : [];
  const result: StageOutput = {
    schema: 3,
    ok: run.ok,
    outcome,
    summary: String(s.summary ?? run.text ?? run.error ?? "").slice(0, 2000),
    needsInput: asked ? questions : null,
    requested: Array.isArray(s.requested) ? (s.requested as StageOutput["requested"]) : [],
    findings: Array.isArray(s.findings) ? (s.findings as StageOutput["findings"]) : [],
    artifacts: scanArtifacts(outDir),
    slices: {
      done: state.ledger.slices.filter((x) => x.status === "committed" || x.status === "green").length,
      total: state.ledger.slices.length,
    },
    commit: typeof s.commit === "string" ? s.commit : null,
    answer: run.structured,
    usage: { turns: run.turns, costUsd: run.costUsd, durationMs: Math.round(run.durationMs), model: run.model },
    error: run.error,
    rateLimited: run.rateLimited,
    resetsAt: run.resetsAt,
    ledger: state.ledger,
    sessionId: run.sessionId,
    run: state.run ?? null,
  };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines: RunEvent[] = [...state.events, { kind: "note", payload: { phase: "stage_end", outcome, pack: pack.id } }];
  writeFileSync(join(outDir, "events.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return result;
}
