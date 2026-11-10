// The token economy's port (RFC 0007): what the machine hands a run before it starts and what it learns from it once it is over, per repository.
// The state lives behind `EconomyStore`; this file holds the rules, so they run over a fake store in tests.
import { type EconomyConfig, type EconomyInput, type EconomyStatus, type FactStatus, FactProposal, type GuardEventRow, PACKS, type PackId, type ProposeContext, type Tokens, type ToolsStatus, repoName } from "@hardness/contracts";

import { addSample, envelopeOf } from "../domain/economy/envelope.ts";
import { evidenceOf } from "../domain/economy/envfacts.ts";
import { runFacts } from "../domain/economy/fold.ts";
import { type LedgerRecord, ledgerRecord, summary } from "../domain/economy/ledger.ts";
import { type FactsFile, dropFact, foldFacts, promoteFacts } from "../domain/economy/lifecycle.ts";
import { type Digest, type ObservedCall, digestOf, observedCalls } from "../domain/economy/observe-run.ts";
import { admit, foldProposed } from "../domain/economy/propose.ts";
import { type PackTools, approve, emptyTools, foldTools, maskOf, restoreUnit, unitsOf, usedUnits } from "../domain/economy/prune.ts";
import { manual, selectInjected } from "../domain/economy/render-facts.ts";

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
  /** Adds a run's digest, with the calls it was made of (the proposer's detectors read them), and keeps the last eight of each. */
  appendDigest(repoPath: string, digest: Digest, calls?: ObservedCall[]): Promise<void>;
  /** The calls of the kept digests' runs, by run id. */
  calls(repoPath: string): Promise<Record<string, ObservedCall[]>>;
  /** Changes the proposer's counter as one step. */
  updateProposer(repoPath: string, change: (state: ProposerState) => ProposerState): Promise<void>;
  /** The kept digests, oldest first. */
  digests(repoPath: string): Promise<Digest[]>;
  /** Each pack's tool-pruning state: the evidence per unit, the proposal and the applied mask. */
  tools(repoPath: string): Promise<Record<string, PackTools>>;
  /** Changes the tool-pruning state as one step. */
  updateTools(repoPath: string, change: (all: Record<string, PackTools>) => Record<string, PackTools>): Promise<void>;
  /** The events a finished run wrote (`runs/<runId>/out/events.jsonl`); none when it left no file. */
  events(runId: string): Promise<unknown[]>;
}

/** How many cards of a repository have closed, for the proposer's cadence, and the latest ones counted (a card is counted once). */
export interface ProposerState {
  closed: number;
  counted: string[];
}

/** Runs the fact_propose pack on a context and gives its validated answer and the run's id and cost, or null when it could not run. Bound by the machine. */
export type Propose = (input: ProposeContext) => Promise<{ answer: unknown; runId: string; costUsd?: number | null } | null>;

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
  /** A card of this repository closed. On every `config.propose_every`-th, with `facts: on` and at least two runs digested, `propose` is asked for facts and the ones that are grounded are kept. Never throws. */
  cardClosed(repoPath: string, cardId: string, config: EconomyConfig, propose: Propose): Promise<void>;
  /** The learned facts the retro may promote: active, confirmed on `config.promote_cards` distinct cards, never contradicted; ten at most. */
  promotable(repoPath: string, config: EconomyConfig): Promise<Array<{ id: string; text: string; section?: string }>>;
  /** The retro put these facts in the project context: they are not told again. Returns how many it marked. Never throws. */
  promoted(repoPath: string, ids: readonly string[]): Promise<number>;
  /** A person approves the tools proposed for `pack`: they become its mask, which the next run narrows by. False when there is no proposal. Never throws. */
  approveMask(repoPath: string, pack: PackId): Promise<boolean>;
  /** A person brings back a unit of `pack` (`web`, `agent`, `skill:<name>`, `luna:<tool>`): out of the mask, never proposed again. False for a unit the pack does not have. Never throws. */
  restore(repoPath: string, pack: PackId, unit: string): Promise<boolean>;
  /** `minSamples` is the repository's `economy.guard.envelope_min_samples` (the default, 5, when not given). */
  status(repoPath: string, minSamples?: number): Promise<EconomyStatus>;
}

const GUARD_KEEP = 50;
/** Texts of held facts the proposer is shown, the newest. */
const KNOWN_SHOWN = 20;
/** The most the retro is offered, and the most cards a counter remembers. */
const PROMOTABLE_MAX = 10;
const COUNTED_KEPT = 20;
/** Calls a run keeps for the detectors; a run's digest shows fewer. */
const CALLS_KEPT = 300;

const EMPTY: EconomyStatus = { envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0 } };

/** The economy of a machine with it off: no input, nothing kept. */
export function noEconomy(): Economy {
  return { inputFor: async () => undefined, afterRun: async () => {}, recordOverhead: async () => {}, dropFact: async () => false, cardClosed: async () => {}, promotable: async () => [], promoted: async () => 0, approveMask: async () => false, restore: async () => false, status: async () => EMPTY };
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
          // `free` is the free layer alone; `on` adds the proposer's manual.
          const facts = config.facts === "off" ? [] : await kept("facts", () => told(repoPath, pack), [] as string[]);
          const lines = config.facts === "on" ? await kept("manual", async () => manual((await store.facts(repoPath)).facts, repoPath), [] as string[]) : [];
          // The approved mask goes whatever the guard and the facts are; `tool_prune: off` stops it too.
          const mask = config.tool_prune === "off" ? {} : maskOf((await kept("tools", () => store.tools(repoPath), {} as Record<string, PackTools>))[pack] ?? emptyTools());
          const masked = Object.keys(mask).length > 0;
          if (!guard && facts.length === 0 && lines.length === 0 && !masked) return undefined;
          return { ...(guard ? { guard } : {}), ...(facts.length > 0 ? { facts } : {}), ...(lines.length > 0 ? { manual: lines } : {}), ...(masked ? { mask } : {}) };
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
      // A run with no events says nothing about which tools were used.
      if (run.config.tool_prune !== "off" && events.length > 0) {
        await kept(
          "tools",
          async () => {
            const spec = PACKS[run.pack];
            const units = unitsOf(spec);
            if (units.length === 0) return;
            const used = usedUnits(events);
            await store.updateTools(run.repoPath, (all) => ({ ...all, [run.pack]: foldTools(all[run.pack] ?? emptyTools(), { units, used, cardId: run.cardId, prune: run.config.prune }) }));
          },
          undefined,
        );
      }
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
            const folded = foldFacts(file.facts, evidence, { runId: run.runId, cardId: run.cardId });
            return { ...file, facts: foldProposed(folded, { runId: run.runId, cardId: run.cardId, calls }) };
          });
          await store.appendDigest(run.repoPath, digestOf({ at: new Date().toISOString(), runId: run.runId, pack: run.pack, cardId: run.cardId, outcome: run.outcome }, calls), calls.slice(0, CALLS_KEPT));
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
    cardClosed: (repoPath, cardId, config, propose) =>
      kept(
        "propose",
        async () => {
          if (config.facts === "off") return;
          let tick = false;
          await store.updateProposer(repoPath, (state) => {
            if (state.counted.includes(cardId)) return state;
            const closed = state.closed + 1;
            tick = closed % Math.max(1, config.propose_every) === 0;
            return { closed, counted: [...state.counted, cardId].slice(-COUNTED_KEPT) };
          });
          if (!tick || config.facts !== "on") return;
          const digests = await store.digests(repoPath);
          if (digests.length < 2) return;
          const held = (await store.facts(repoPath)).facts;
          const known = held.map((f) => f.text).filter((t) => t !== "" && t.length <= 240).slice(-KNOWN_SHOWN);
          const reply = await propose({ repo: repoName(repoPath), digests: digests.map((d) => ({ ...d, lines: d.lines.map((l) => l.slice(0, 300)) })), known });
          if (!reply) return;
          await kept("overhead", () => store.appendLedger(repoPath, ledgerRecord({ at: new Date().toISOString(), runId: reply.runId, pack: "fact_propose", cardId, tokens: null, costUsd: reply.costUsd })), undefined);
          const answer = FactProposal.safeParse(reply.answer);
          if (!answer.success) return;
          const calls = await store.calls(repoPath);
          await store.updateFacts(repoPath, (file) => {
            const fresh = admit(answer.data, digests, calls, file.facts);
            return fresh.length === 0 ? file : { ...file, facts: [...file.facts, ...fresh] };
          });
        },
        undefined,
      ),
    promotable: (repoPath, config) =>
      kept(
        "promotable",
        async () => {
          if (config.facts === "off") return [];
          const facts = (await store.facts(repoPath)).facts.filter((f) => f.state === "active" && f.contradictions === 0 && new Set(f.cards).size >= config.promote_cards);
          return facts.slice(0, PROMOTABLE_MAX).map((f) => ({ id: f.id, text: f.text, ...(f.section ? { section: f.section } : {}) }));
        },
        [],
      ),
    promoted: (repoPath, ids) =>
      kept(
        "promoted",
        async () => {
          let count = 0;
          await store.updateFacts(repoPath, (file) => {
            const done = promoteFacts(file.facts, ids);
            count = done.promoted;
            return done.promoted > 0 ? { ...file, facts: done.facts } : file;
          });
          return count;
        },
        0,
      ),
    approveMask: (repoPath, pack) =>
      kept(
        "approve",
        async () => {
          let found = false;
          await store.updateTools(repoPath, (all) => {
            const state = all[pack];
            found = (state?.proposal.length ?? 0) > 0;
            return found ? { ...all, [pack]: approve(state!) } : all;
          });
          return found;
        },
        false,
      ),
    restore: (repoPath, pack, unit) =>
      kept(
        "restore",
        async () => {
          if (!unitsOf(PACKS[pack]).includes(unit)) return false;
          await store.updateTools(repoPath, (all) => ({ ...all, [pack]: restoreUnit(all[pack] ?? emptyTools(), unit) }));
          return true;
        },
        false,
      ),
    recordOverhead: (run) => kept("overhead", () => store.appendLedger(run.repoPath, ledgerRecord({ at: new Date().toISOString(), ...run })), undefined),
    status: (repoPath, minSamples = 5) =>
      kept<EconomyStatus>(
        "status",
        async () => {
          const envelopes = await store.envelopes(repoPath);
          const tools = await store.tools(repoPath);
          return {
            envelopes: Object.fromEntries(Object.entries(envelopes).map(([pack, samples]) => [pack, { samples: samples.length, envelope: envelopeOf(samples, minSamples) }])),
            guard: (await store.guard(repoPath)).slice(-GUARD_KEEP),
            cost: summary(await store.ledger(repoPath)),
            facts: (await store.facts(repoPath)).facts.map<FactStatus>((f) => ({ id: f.id, family: f.family, source: f.source, state: f.state, text: f.text, confirmations: f.confirmations, contradictions: f.contradictions, exercised: f.exercised, fired: f.fired })),
            tools: Object.fromEntries(Object.entries(tools).map<[string, ToolsStatus]>(([pack, t]) => [pack, { mask: t.mask, proposal: t.proposal.map((unit) => ({ unit, unusedRuns: t.units[unit]?.unusedRuns ?? 0, cards: t.units[unit]?.unusedCards.length ?? 0 })) }])),
          };
        },
        EMPTY,
      ),
  };
}
