// What a stage leaves behind: /out/result.json (the StageOutput contract), /out/events.jsonl
// and the artifact index over /out/files/**. One function, called however the run ended, so
// the machine always finds a result.
import type { Pack, StageArtifact, StageOutcome, StageOutput } from "@hardness/contracts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { LunaState } from "./tools/luna.ts";

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

/** The outcome the machine acts on, from the pack's structured answer. */
export function outcomeOf(run: RunOutcome): StageOutcome {
  const s = run.structured ?? {};
  const asked = s.kind === "questions" || (Array.isArray(s.questions) && s.questions.length > 0);
  if (asked) return "needs_input";
  if (s.kind === "test_change") return "test_change";
  if (s.kind === "escalated") return "escalated";
  return run.ok ? "pass" : "fail";
}

/** Writes result.json and events.jsonl; returns what it wrote. */
export function finish(outDir: string, pack: Pack, run: RunOutcome, state: LunaState): StageOutput {
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
  };
  writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [...state.events, { kind: "note", payload: { phase: "stage_end", outcome, pack: pack.id } }];
  writeFileSync(join(outDir, "events.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return result;
}
