// The token economy's port (RFC 0007): what the machine hands a run before it starts and what it learns from it once it is over, per repository.
// The state lives behind `EconomyStore`; this file holds the rules, so they run over a fake store in tests.
import { type EconomyConfig, type EconomyInput, type EconomyStatus, type FactStatus, type GuardEventRow, PACKS, type PackId, type Tokens } from "@hardness/contracts";

import { addSample, envelopeOf } from "../domain/economy/envelope.ts";
import { evidenceOf } from "../domain/economy/envfacts.ts";
import { runFacts } from "../domain/economy/fold.ts";
import { type LedgerRecord, ledgerRecord, summary } from "../domain/economy/ledger.ts";
import { type FactsFile, dropFact, foldFacts } from "../domain/economy/lifecycle.ts";
import { type Digest, digestOf, observedCalls } from "../domain/economy/observe-run.ts";
import { selectInjected } from "../domain/economy/render-facts.ts";

/** What the economy keeps for a repository. Every method is for one repository's folder; a corrupt file reads as empty. */
export interface EconomyStore {
  /** Passing runs' tool-call counts, per pack. */
  envelopes(repoPath: string): Promise<Record<string, number[]>>;
  /** Changes the envelopes as one step: two runs finishing together never lose a sample. */
  updateEnvelopes(repoPath: string, change: (all: Record<string, number[]>) => Record<string, number[]>): Promise<void>;
  appendLedger(repoPath: string, record: LedgerRecord): Promise<void>;
  ledger(repoPath: string): Promise<LedgerRecord[]>;
  appendGuard(repoPath: string, rows: GuardEventRow[]): Promise<void>;
  /** The newest guard events, oldest first. */
  guard(repoPath: string): Promise<GuardEventRow[]>;
  /** The learned facts, and for each pack the ids of the facts its latest run was told. */
  facts(repoPath: string): Promise<FactsFile>;
  /** Changes the facts file as one step: two runs finishing together never lose an update. */
  updateFacts(repoPath: string, change: (file: FactsFile) => FactsFile): Promise<void>;
  /** Adds a run's digest and keeps the last eight. */
  appendDigest(repoPath: string, digest: Digest): Promise<void>;
  /** The kept digests, oldest first. */
  digests(repoPath: string): Promise<Digest[]>;
  /** The events a finished run wrote (`runs/<runId>/out/events.jsonl`); none when it left no file. */
  events(runId: string): Promise<unknown[]>;
}

/** One finished run, as the economy folds it. */
export interface FinishedRun {
  repoPath: string;
  runId: string;
  pack: PackId;
  cardId: string;
  /** The stage's outcome (`pass`, `fail`, ...): only a pass teaches the envelope. */
  outcome: string;
  tokens: Tokens | null;
  config: EconomyConfig;
}

export interface Economy {
  /** What the next run of this pack in this repository starts with; undefined when the economy is off for it. */
  inputFor(repoPath: string, pack: PackId, config: EconomyConfig): Promise<EconomyInput | undefined>;
  /** Folds one finished run. Never throws. */
  afterRun(run: FinishedRun): Promise<void>;
  /** An on-demand run of the economy's own (the judge, the redirect writer) cost this much: an overhead record, no fold. Never throws. */
  recordOverhead(run: { repoPath: string; runId: string; pack: string; cardId: string; tokens: Tokens | null; costUsd?: number | null }): Promise<void>;
  /** A person says a learned fact is wrong: it is never told again and its key is never learned again. False for an id the repository does not hold. Never throws. */
  dropFact(repoPath: string, id: string): Promise<boolean>;
  /** `minSamples` is the repository's `economy.guard.envelope_min_samples` (the default, 5, when not given). */
  status(repoPath: string, minSamples?: number): Promise<EconomyStatus>;
}

const GUARD_KEEP = 50;

const EMPTY: EconomyStatus = { envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0 } };

/** The economy of a machine with it off: no input, nothing kept. */
export function noEconomy(): Economy {
  return { inputFor: async () => undefined, afterRun: async () => {}, recordOverhead: async () => {}, dropFact: async () => false, status: async () => EMPTY };
}

export function economy(store: EconomyStore, log: (line: string) => void = () => {}): Economy {
  const kept = async <T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      log(`economy: ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };
  /** The lines the next run of `pack` is told, with the ids of the facts they are recorded under: the run's fold counts a fact as applied only if it was told. */
  const told = async (repoPath: string, pack: PackId): Promise<string[]> => {
    const file = await store.facts(repoPath);
    const chosen = selectInjected(file.facts);
    const ids = chosen.map((f) => f.id);
    const had = file.injected[pack] ?? [];
    if (ids.length !== had.length || ids.some((id, i) => id !== had[i])) {
      await store.updateFacts(repoPath, (now) => ({ ...now, injected: { ...now.injected, [pack]: ids } }));
    }
    return chosen.map((f) => f.text);
  };
  return {
    inputFor: (repoPath, pack, config) =>
      kept(
        "input",
        async () => {
          const spec = PACKS[pack];
          if (spec.kind !== "agent") return undefined;
          const guard =
            config.loop_guard === "on"
              ? await (async () => {
                  const envelope = envelopeOf((await store.envelopes(repoPath))[pack] ?? [], config.guard.envelope_min_samples);
                  return {
                    mode: envelope === null ? ("record" as const) : ("on" as const),
                    // The pack runner asks the judge for the same packs: those that run shell commands.
                    judge: spec.access.commands.length > 0,
                    envelope,
                    judgeConfidence: config.guard.judge_confidence,
                    redirects: config.guard.redirects,
                    backstopMult: config.guard.backstop_mult,
                  };
                })()
              : undefined;
          // `free` is the free layer alone, which is all there is until the proposer; it tells what `on` tells.
          const facts = config.facts === "off" ? [] : await kept("facts", () => told(repoPath, pack), [] as string[]);
          if (!guard && facts.length === 0) return undefined;
          return { ...(guard ? { guard } : {}), ...(facts.length > 0 ? { facts } : {}) };
        },
        undefined,
      ),
    afterRun: async (run) => {
      const events = await kept("events", () => store.events(run.runId), [] as unknown[]);
      await kept(
        "fold",
        async () => {
          const at = new Date().toISOString();
          const facts = runFacts(events);
          await store.appendLedger(run.repoPath, ledgerRecord({ at, runId: run.runId, pack: run.pack, cardId: run.cardId, tokens: run.tokens }));
          if (run.outcome === "pass" && facts.calls > 0) {
            await store.updateEnvelopes(run.repoPath, (all) => ({ ...all, [run.pack]: addSample(all[run.pack] ?? [], facts.calls) }));
          }
          if (facts.guard.length > 0) await store.appendGuard(run.repoPath, facts.guard.map((e) => ({ ...e, at, runId: run.runId, pack: run.pack })));
        },
        undefined,
      );
      if (run.config.facts === "off") return;
      await kept(
        "facts",
        async () => {
          const calls = observedCalls(events);
          // A run that observed nothing taught nothing; it is not a session that ages the facts.
          if (calls.length === 0) return;
          await store.updateFacts(run.repoPath, (file) => {
            const known = file.facts.filter((f) => f.source === "free").map(({ family, key, text }) => ({ family, key, text }));
            const evidence = evidenceOf(calls, { known, injected: new Set(file.injected[run.pack] ?? []) });
            return { ...file, facts: foldFacts(file.facts, evidence, { runId: run.runId, cardId: run.cardId }) };
          });
          await store.appendDigest(run.repoPath, digestOf({ at: new Date().toISOString(), runId: run.runId, pack: run.pack, cardId: run.cardId, outcome: run.outcome }, calls));
        },
        undefined,
      );
    },
    dropFact: (repoPath, id) =>
      kept(
        "drop",
        async () => {
          let found = false;
          await store.updateFacts(repoPath, (file) => {
            const dropped = dropFact(file.facts, id);
            found = dropped.found;
            return dropped.found ? { ...file, facts: dropped.facts } : file;
          });
          return found;
        },
        false,
      ),
    recordOverhead: (run) => kept("overhead", () => store.appendLedger(run.repoPath, ledgerRecord({ at: new Date().toISOString(), ...run })), undefined),
    status: (repoPath, minSamples = 5) =>
      kept<EconomyStatus>(
        "status",
        async () => {
          const envelopes = await store.envelopes(repoPath);
          return {
            envelopes: Object.fromEntries(Object.entries(envelopes).map(([pack, samples]) => [pack, { samples: samples.length, envelope: envelopeOf(samples, minSamples) }])),
            guard: (await store.guard(repoPath)).slice(-GUARD_KEEP),
            cost: summary(await store.ledger(repoPath)),
            facts: (await store.facts(repoPath)).facts.map<FactStatus>((f) => ({ id: f.id, family: f.family, source: f.source, state: f.state, text: f.text, confirmations: f.confirmations, contradictions: f.contradictions, exercised: f.exercised, fired: f.fired })),
          };
        },
        EMPTY,
      ),
  };
}
