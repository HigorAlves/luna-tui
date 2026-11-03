// Which engine runs a pack for a task: the task's own override for that pack, else the repo's
// luna.yaml, else the pack's default. An engine the pack does not allow is never run, and one
// whose credential this machine lacks gives way to the default; either way the reason says so,
// for the task's log. Pure: the caller says which credentials are missing. See RFC 0002.
import { type EngineId, PACKS, type Pack, type PackId, type StageEngines } from "@hardness/contracts";

import { packStates } from "./packs.ts";

export interface EngineChoice {
  engine: EngineId;
  /** Where the engine came from: the task's override, the repo's luna.yaml, or the pack. */
  source: "task" | "config" | "default";
  /** Why an engine someone asked for was passed over; null when nothing was. */
  reason: string | null;
}

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

function notAllowed(pack: Pick<Pack, "id" | "engines">, engine: EngineId): string | null {
  return pack.engines.allowed.includes(engine) ? null : `${engine} is not allowed for ${pack.id} (allowed: ${pack.engines.allowed.join(", ")})`;
}

export function chooseEngine(opts: {
  pack: Pick<Pack, "id" | "engines">;
  /** The task's own overrides, per pack. */
  task?: StageEngines | null;
  /** The repo's luna.yaml `engines`. */
  config?: StageEngines | null;
  /** Why this machine cannot run an engine (its credential is missing), or null when it can. */
  missing: (engine: EngineId) => string | null;
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
    const lacking = opts.missing(engine);
    if (lacking) {
      reasons.push(`${engine} has no credential on this machine (${lacking}); ran ${fallback}, the pack's default`);
      break;
    }
    return { engine, source, reason: reasons.join("; ") || null };
  }
  return { engine: fallback, source: "default", reason: reasons.join("; ") || null };
}
