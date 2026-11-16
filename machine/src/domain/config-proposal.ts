// The rule that turns evidence into a luna.yaml change: a pack's scorecards (what each engine and effort scored and cost) and
// the repo's own run signals (how often the pack escalated or got stuck here). A fixed rule decides; no model is called, and
// `why` is built from the numbers, never from model text. Pure: the caller reads the evidence and says what time it is.
import { type Effort, type EngineId, PACKS, type PackId, type StageEfforts, type StageEngines, effortProblem } from "@hardness/contracts";
import { Document, parse as parseYaml, parseDocument } from "yaml";

import { PolicyParseError } from "./policy.ts";
import { validateLunaConfig } from "./luna-config.ts";

/** Fewest scorecard cases a candidate needs to count. */
export const MIN_CASES = 3;
/** Fewest runs in the repo before its trouble rate says anything. */
export const MIN_RUNS = 10;
/** How much quality a cheaper candidate may lose. */
export const TOLERANCE = 0.05;
/** A cheaper candidate costs at most this share of the current one. */
export const CHEAPER = 0.7;
/** The trouble rate at or above which a pack steps up. */
export const TROUBLE = 0.25;
/** The trouble rate below which a pack may step down. */
export const CALM = 0.1;
/** How much quality a stronger candidate must add. */
export const GAIN = 0.1;
/** The share of a pack's runs one engine must have for it to count as the engine the repo runs. */
export const ENGINE_SHARE = 0.8;
/** Days a declined change stays out of new proposals. */
export const DECLINE_DAYS = 30;
/** Most changes in one proposal. */
export const MAX_CHANGES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One scorecard row: an engine at an effort, over `n` cases. `quality` is the pass rate (agent pack) or the acted-on accuracy (decision pack). */
export interface Candidate {
  engine: EngineId;
  effort: Effort | null;
  n: number;
  quality: number;
  costPerCase: number;
  at: string;
}

/** What a pack did in the repo over the window. */
export interface RepoSignal {
  runs: number;
  escalations: number;
  /** The loop guard's stops. Evidence only: `escalations` is read from the event log, where the pipeline escalates each stop, so they are already in it. Said in `why`, not counted again. */
  stuck: number;
  costUsd: number;
  /** Runs per engine (`stage_runs.engine`; a run with no engine recorded is left out). Absent: the engine is taken from the config. */
  engines?: Partial<Record<EngineId, number>>;
}

export interface ProposalInput {
  /** The repo's luna.yaml today. */
  current: { engines: StageEngines; effort: StageEfforts };
  /** From scorecards. */
  candidates: Partial<Record<PackId, Candidate[]>>;
  /** From the repo's own runs. */
  signals: Partial<Record<PackId, RepoSignal>>;
  declined: Array<{ pack: PackId; field: "engine" | "effort"; to: string; at: string }>;
  now: string;
}

export interface ConfigChange {
  pack: PackId;
  engine: { from: EngineId; to: EngineId } | null;
  effort: { from: Effort; to: Effort } | null;
  why: string;
  evidence: { current: Candidate; next: Candidate; signal: RepoSignal };
}

type Step = "up" | "down";
interface Drafted {
  change: ConfigChange;
  step: Step;
  saving: number;
}

/** The changes to put to the person, at most `MAX_CHANGES`, step-ups first, then the largest saving. */
export function proposeConfig(input: ProposalInput): ConfigChange[] {
  const drafted: Drafted[] = [];
  for (const pack of Object.keys(input.candidates) as PackId[]) {
    const draft = draftFor(pack, input);
    if (draft && !wasDeclined(draft.change, input)) drafted.push(draft);
  }
  drafted.sort((a, b) => (a.step === b.step ? b.saving - a.saving : a.step === "up" ? -1 : 1));
  return drafted.slice(0, MAX_CHANGES).map((d) => d.change);
}

/** The engine a pack ran on most in the repo, when one ran at least `ENGINE_SHARE` of its runs. `skip` says why none did. */
function observedEngine(pack: PackId, signal: RepoSignal | undefined): { engine: EngineId | null; skip: string | null } {
  const counts = Object.entries(signal?.engines ?? {}) as Array<[EngineId, number]>;
  if (!signal || counts.length === 0) return { engine: null, skip: null };
  const [top, n] = counts.sort((a, b) => b[1] - a[1])[0]!;
  if (n / signal.runs < ENGINE_SHARE) return { engine: null, skip: `${pack} ran on mixed engines: ${top} ${n} of ${signal.runs} runs, under ${ENGINE_SHARE * 100}%` };
  return { engine: top, skip: null };
}

/** The packs the rule left out because no single engine ran most of their runs, with the reason. */
export function proposalSkips(input: ProposalInput): Array<{ pack: PackId; reason: string }> {
  const out: Array<{ pack: PackId; reason: string }> = [];
  for (const pack of Object.keys(input.candidates) as PackId[]) {
    const { skip } = observedEngine(pack, input.signals[pack]);
    if (skip) out.push({ pack, reason: skip });
  }
  return out;
}

function draftFor(pack: PackId, input: ProposalInput): Drafted | null {
  const def = PACKS[pack];
  const isDecision = def.kind === "decision";
  const observed = observedEngine(pack, input.signals[pack]);
  if (observed.skip) return null;
  // The engine the repo really ran beats the config and the default: a reviewer may run on codex:sol while the pack defaults to claude:opus.
  const engine = observed.engine ?? input.current.engines[pack] ?? def.engines.default;
  const effort: Effort | null = isDecision ? null : (input.current.effort[pack] ?? (def as { effort: Effort }).effort);
  const all = input.candidates[pack] ?? [];

  // 1. The baseline: the candidate for the pair the repo runs today.
  const baseline = all.find((c) => c.engine === engine && c.effort === effort);
  if (!baseline || baseline.n < MIN_CASES) return null;

  // 3. The repo's own signal.
  const signal = input.signals[pack];
  if (!signal || signal.runs < MIN_RUNS) return null;
  // `escalations` counts every `stage_done escalated` event (loop-guard and stuck-detector stops, scope reds), and a stage run
  // stores those as `fail`, so `stuck` is a subset of it: adding it here would count a stuck run twice.
  const trouble = signal.escalations / signal.runs;

  // 2. Only candidates the pack may run.
  const usable = all.filter((c) => c !== baseline && c.n >= MIN_CASES && def.engines.allowed.includes(c.engine) && validEffort(pack, c, isDecision) && !(c.engine === engine && c.effort === effort));

  let next: Candidate | undefined;
  let step: Step;
  if (trouble >= TROUBLE) {
    // 4. Step up: the best quality that clears the gain, the lower cost on a tie.
    step = "up";
    next = usable.filter((c) => c.quality >= baseline.quality + GAIN).sort((a, b) => b.quality - a.quality || a.costPerCase - b.costPerCase)[0];
  } else if (trouble < CALM) {
    // 5. Step down: the cheapest that is much cheaper and about as good.
    step = "down";
    next = usable.filter((c) => c.costPerCase <= baseline.costPerCase * CHEAPER && c.quality >= baseline.quality - TOLERANCE).sort((a, b) => a.costPerCase - b.costPerCase)[0];
  } else return null;
  if (!next) return null;

  const change: ConfigChange = {
    pack,
    engine: next.engine === engine ? null : { from: engine, to: next.engine },
    effort: next.effort !== null && effort !== null && next.effort !== effort ? { from: effort, to: next.effort } : null,
    why: whyOf(pack, step, signal, baseline, next, isDecision),
    evidence: { current: baseline, next, signal },
  };
  return { change, step, saving: baseline.costPerCase - next.costPerCase };
}

/** An agent pack's candidate names an effort its engine can run; a decision pack's names none. */
function validEffort(pack: PackId, c: Candidate, isDecision: boolean): boolean {
  if (isDecision) return c.effort === null;
  return c.effort !== null && effortProblem(pack, c.engine, c.effort) === null;
}

/** 6. A change that repeats one the person declined within `DECLINE_DAYS` is dropped. */
function wasDeclined(change: ConfigChange, input: ProposalInput): boolean {
  const now = Date.parse(input.now);
  return input.declined.some((d) => {
    if (d.pack !== change.pack || now - Date.parse(d.at) > DECLINE_DAYS * DAY_MS) return false;
    return d.field === "engine" ? change.engine?.to === d.to : change.effort?.to === d.to;
  });
}

const label = (c: Candidate): string => (c.effort ? `${c.engine} at ${c.effort}` : c.engine);
const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** One sentence from the numbers. */
function whyOf(pack: PackId, step: Step, signal: RepoSignal, current: Candidate, next: Candidate, isDecision: boolean): string {
  const verb = isDecision ? "scored" : "passed";
  const trouble = `escalated ${signal.escalations} of ${signal.runs} runs${signal.stuck > 0 ? ` (${signal.stuck} stuck in a loop)` : ""}`;
  const head = `${pack} ${trouble}; ${label(next)} ${verb} ${next.quality.toFixed(2)} vs ${current.quality.toFixed(2)}`;
  return step === "up" ? head : `${head} at ${money(next.costPerCase)} a case vs ${money(current.costPerCase)}`;
}

/** The new luna.yaml text: the current file edited in place, so comments, key order and keys this module does not know stay. Only
 *  `engines.<pack>` and `effort.<pack>` are set. Throws a `PolicyParseError` naming the path when the current file or the result is
 *  not a valid luna.yaml, so nothing invalid is proposed. */
export function renderProposal(currentText: string, changes: ConfigChange[]): string {
  validateLunaConfig(parseMapping(currentText));
  const parsed = parseDocument(currentText);
  const doc: Document = parsed.contents === null ? new Document({}) : parsed;
  for (const change of changes) {
    if (change.engine) doc.setIn(["engines", change.pack], change.engine.to);
    if (change.effort) doc.setIn(["effort", change.pack], change.effort.to);
  }
  const text = String(doc);
  validateLunaConfig(parseMapping(text));
  return text;
}

/** The engines and efforts a luna.yaml text sets today; none for an empty text. Throws a `PolicyParseError` for a file that does not load. */
export function choicesOf(text: string): ProposalInput["current"] {
  const config = validateLunaConfig(parseMapping(text));
  return { engines: config.engines ?? {}, effort: config.effort ?? {} };
}

/** The first field a card changes that a person edited since the card was made (`engines.plan`, `effort.plan`), or null. A field counts as
 *  edited when the value the repo runs (the file's, else the pack's default) is not what it was when the card was built. Throws a
 *  `PolicyParseError` for a file that does not load. */
export function editedByHand(previousText: string, currentText: string, changes: ConfigChange[]): string | null {
  const was = choicesOf(previousText);
  const now = choicesOf(currentText);
  for (const { pack, engine, effort } of changes) {
    const def = PACKS[pack];
    if (engine && (now.engines[pack] ?? def.engines.default) !== (was.engines[pack] ?? def.engines.default)) return `engines.${pack}`;
    const base = def.kind === "decision" ? null : def.effort;
    if (effort && (now.effort[pack] ?? base) !== (was.effort[pack] ?? base)) return `effort.${pack}`;
  }
  return null;
}

function parseMapping(text: string): unknown {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyParseError(`not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  return raw ?? {};
}
