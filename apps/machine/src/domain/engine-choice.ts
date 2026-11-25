// Which engine runs a pack for a task: the task's own override for that pack, else the repo's
// luna.yaml, else the pack's default. An engine the pack does not allow is never run, and one
// whose credential this machine lacks gives way to the default; either way the reason says so,
// for the task's log. Pure: the caller says which credentials are missing. See RFC 0002.
import { type CredentialOwner, type Effort, type EngineId, PACKS, type Pack, type PackId, type StageEfforts, type StageEngines, credentialOwner, effortProblem, isReviewHelper, visionProblem } from "@hardness/contracts";

import { packStates } from "./packs.ts";

export interface EngineChoice {
  engine: EngineId;
  /** Where the engine came from: the task's override, the repo's luna.yaml, or the pack. */
  source: "task" | "config" | "default";
  /** Why an engine someone asked for was passed over; null when nothing was. */
  reason: string | null;
  /** One line for the task's activity when the engine asked for gave way to the default for want of
   *  its credential (`triage ran on claude:opus: codex:sol has no Codex login on this machine`), or
   *  because the machine holds it back (`… codex:sol is disabled by MACHINE_DISABLE_RUNTIMES`). */
  note?: string;
}

/** What each credential is called in a line for you. */
const CREDENTIAL_NAMES: Record<CredentialOwner, string> = {
  claude: "Claude credential",
  codex: "Codex login",
  openai: "OpenAI API key",
  typesafe: "Jev credential (a Vercel AI Gateway or TypeSafe key)",
};

/** Why `engine` cannot run `pack`, or null when the pack allows it. */
export function engineProblem(pack: PackId, engine: EngineId): string | null {
  return notAllowed(PACKS[pack], engine);
}

/** The first `<pack>: <problem>` among stage engines (a task's `stages`, luna.yaml's `engines`), else null. */
export function stagesProblem(stages: StageEngines): string | null {
  for (const [pack, engine] of Object.entries(stages) as [PackId, EngineId | undefined][]) {
    const problem = engine === undefined ? null : engineProblem(pack, engine);
    if (problem) return `${pack}: ${problem}`;
  }
  return null;
}

/** The same for a task's own `stages` (null clears one): a pack that never runs in a task cannot be set on one either. */
export function taskStagesProblem(stages: Partial<Record<PackId, EngineId | null>>): string | null {
  for (const [pack, engine] of Object.entries(stages) as [PackId, EngineId | null | undefined][]) {
    if (packStates(pack).length === 0) return `${pack}: runs on its own, not in a task`;
    const problem = engine == null ? null : engineProblem(pack, engine);
    if (problem) return `${pack}: ${problem}`;
  }
  return null;
}

/** What the choice needs of a pack: its engines, and whether it reads images. */
type Choosable = Pick<Pack, "id" | "engines"> & { vision?: boolean };

function notAllowed(pack: Choosable, engine: EngineId): string | null {
  if (!pack.engines.allowed.includes(engine)) return `${engine} is not allowed for ${pack.id} (allowed: ${pack.engines.allowed.join(", ")})`;
  // A pack that reads images runs only where the model can (RFC 0013), refused like an engine it does not allow.
  return visionProblem(pack, engine);
}

export function chooseEngine(opts: {
  pack: Choosable;
  /** The task's own overrides, per pack. */
  task?: StageEngines | null;
  /** The repo's luna.yaml `engines`. */
  config?: StageEngines | null;
  /** Why this machine cannot run an engine (its credential is missing), or null when it can. */
  missing: (engine: EngineId) => string | null;
  /** Why this machine holds an engine back though it may have the credential (`disabled by
   *  MACHINE_DISABLE_RUNTIMES`), or null. Said on the task the same way. */
  unavailable?: (engine: EngineId) => string | null;
}): EngineChoice {
  const { pack } = opts;
  const fallback = pack.engines.default;
  const reasons: string[] = [];
  const asked: Array<{ source: "task" | "config"; who: string; engine: EngineId | undefined }> = [
    { source: "task", who: "the task's", engine: opts.task?.[pack.id] },
    { source: "config", who: "luna.yaml's", engine: opts.config?.[pack.id] },
  ];
  for (const { source, who, engine } of asked) {
    if (engine === undefined) continue;
    const problem = notAllowed(pack, engine);
    if (problem) {
      reasons.push(`${who} ${problem}; ignored`);
      continue;
    }
    if (engine === fallback) return { engine, source, reason: reasons.join("; ") || null };
    const held = opts.unavailable?.(engine) ?? null;
    if (held) {
      reasons.push(`${engine} is ${held}; ran ${fallback}, the pack's default`);
      return { engine: fallback, source: "default", reason: reasons.join("; "), note: `${pack.id} ran on ${fallback}: ${engine} is ${held}` };
    }
    const lacking = opts.missing(engine);
    if (lacking) {
      reasons.push(`${engine} has no credential on this machine (${lacking}); ran ${fallback}, the pack's default`);
      const note = `${pack.id} ran on ${fallback}: ${engine} has no ${CREDENTIAL_NAMES[credentialOwner(engine)]} on this machine`;
      return { engine: fallback, source: "default", reason: reasons.join("; "), note };
    }
    return { engine, source, reason: reasons.join("; ") || null };
  }
  return { engine: fallback, source: "default", reason: reasons.join("; ") || null };
}

export interface EffortChoice {
  effort: Effort;
  /** Where the effort came from: the repo's luna.yaml, or the pack. */
  source: "config" | "default";
  /** Why an effort the repo asked for was passed over; null when nothing was. */
  reason: string | null;
}

/** The effort a pack runs at on `engine`: the repo's luna.yaml `effort`, else the pack's own. An
 *  effort the engine cannot serve (the engine may differ per task) gives way to the pack's, with why. */
export function chooseEffort(opts: {
  pack: Pick<Pack, "id" | "kind"> & { effort?: Effort };
  /** The engine the stage runs on. */
  engine: EngineId;
  /** The repo's luna.yaml `effort`. */
  config?: StageEfforts | null;
}): EffortChoice {
  const { pack } = opts;
  const own = pack.effort ?? "low";
  const asked = opts.config?.[pack.id];
  if (asked === undefined) return { effort: own, source: "default", reason: null };
  const problem = effortProblem(pack.id, opts.engine, asked);
  if (problem) return { effort: own, source: "default", reason: `luna.yaml's effort ${asked} for ${pack.id}: ${problem}; ignored` };
  return { effort: asked, source: "config", reason: null };
}

/** The first `<pack>: <problem>` among a repo's efforts, else null: a pack that takes no effort, or runs on its own, cannot be given one. The engine
 *  is not checked here, it may differ per task; `chooseEffort` does that at run time. */
export function effortsProblem(efforts: StageEfforts): string | null {
  for (const pack of Object.keys(efforts) as PackId[]) {
    if (PACKS[pack].kind === "decision") return `${pack}: ${pack} is a decision pack and takes no effort`;
    // An on-demand pack never runs in a task, so nothing would apply the entry. A review pass runs inside the review stage, so its entry applies.
    if (packStates(pack).length === 0 && !isReviewHelper(pack)) return `${pack}: runs on its own, not in a task`;
  }
  return null;
}

/** The engines a pack may move to after a usage limit, in its order: its `fallback` list less the
 *  engines that already ran the stage this time. The caller drops those it cannot run now. */
export function fallbackCandidates(pack: Pick<Pack, "engines"> & Partial<Choosable>, tried: Iterable<EngineId>): EngineId[] {
  const done = new Set(tried);
  // A blind engine never takes over a pack that reads images (RFC 0013).
  return (pack.engines.fallback ?? []).filter((engine) => !done.has(engine) && (pack.id === undefined || visionProblem({ id: pack.id, vision: pack.vision }, engine) === null));
}

/** The engine a reviewing pack runs on when it should not share the implementer's model family: the first allowed engine of another credential owner whose
 *  credential this machine has, with the line that says why. Null when there is none (one family's credential, or a pack that allows one family): the pack runs as it does today. */
export function reviewerEngine(pack: Pick<Pack, "engines">, implementer: EngineId, available: (engine: EngineId) => boolean): { engine: EngineId; reason: string } | null {
  const own = credentialOwner(implementer);
  const engine = pack.engines.allowed.find((e) => credentialOwner(e) !== own && available(e));
  return engine ? { engine, reason: `the reviewer runs on another model family than the implementer (${implementer}): ${engine}` } : null;
}
