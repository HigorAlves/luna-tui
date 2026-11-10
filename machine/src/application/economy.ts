// The token economy's port (RFC 0007): what the machine hands a run before it starts and what it learns from it once it is over, per repository.
// The state lives behind `EconomyStore`; this file holds the rules, so they run over a fake store in tests.
import { type EconomyConfig, type EconomyInput, type EconomyStatus, type GuardEventRow, PACKS, type PackId, type Tokens } from "@hardness/contracts";

import { addSample, envelopeOf } from "../domain/economy/envelope.ts";
import { runFacts } from "../domain/economy/fold.ts";
import { type LedgerRecord, ledgerRecord, summary } from "../domain/economy/ledger.ts";

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
  /** `minSamples` is the repository's `economy.guard.envelope_min_samples` (the default, 5, when not given). */
  status(repoPath: string, minSamples?: number): Promise<EconomyStatus>;
}

const GUARD_KEEP = 50;

const EMPTY: EconomyStatus = { envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0 } };

/** The economy of a machine with it off: no input, nothing kept. */
export function noEconomy(): Economy {
  return { inputFor: async () => undefined, afterRun: async () => {}, recordOverhead: async () => {}, status: async () => EMPTY };
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
  return {
    inputFor: (repoPath, pack, config) =>
      kept(
        "input",
        async () => {
          const spec = PACKS[pack];
          if (config.loop_guard !== "on" || spec.kind !== "agent") return undefined;
          const envelope = envelopeOf((await store.envelopes(repoPath))[pack] ?? [], config.guard.envelope_min_samples);
          return {
            guard: {
              mode: envelope === null ? "record" : "on",
              // The pack runner asks the judge for the same packs: those that run shell commands.
              judge: spec.access.commands.length > 0,
              envelope,
              judgeConfidence: config.guard.judge_confidence,
              redirects: config.guard.redirects,
              backstopMult: config.guard.backstop_mult,
            },
          };
        },
        undefined,
      ),
    afterRun: (run) =>
      kept(
        "fold",
        async () => {
          const at = new Date().toISOString();
          const facts = runFacts(await store.events(run.runId));
          await store.appendLedger(run.repoPath, ledgerRecord({ at, runId: run.runId, pack: run.pack, cardId: run.cardId, tokens: run.tokens }));
          if (run.outcome === "pass" && facts.calls > 0) {
            await store.updateEnvelopes(run.repoPath, (all) => ({ ...all, [run.pack]: addSample(all[run.pack] ?? [], facts.calls) }));
          }
          if (facts.guard.length > 0) await store.appendGuard(run.repoPath, facts.guard.map((e) => ({ ...e, at, runId: run.runId, pack: run.pack })));
        },
        undefined,
      ),
    recordOverhead: (run) => kept("overhead", () => store.appendLedger(run.repoPath, ledgerRecord({ at: new Date().toISOString(), ...run })), undefined),
    status: (repoPath, minSamples = 5) =>
      kept(
        "status",
        async () => {
          const envelopes = await store.envelopes(repoPath);
          return {
            envelopes: Object.fromEntries(Object.entries(envelopes).map(([pack, samples]) => [pack, { samples: samples.length, envelope: envelopeOf(samples, minSamples) }])),
            guard: (await store.guard(repoPath)).slice(-GUARD_KEEP),
            cost: summary(await store.ledger(repoPath)),
          };
        },
        EMPTY,
      ),
  };
}
