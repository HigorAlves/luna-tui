// How a learned fact is born, earns its place and dies (RFC 0007, te-spec 2.3). A fact is a candidate until three runs confirm it, active
// after, and injected only while it keeps being used (four runs that used what it is about, a fifth of them at least two-fifths where it
// applied). A contradiction counts five times a confirmation, and an active fact whose recency score goes below zero is retired; so is a
// high-stakes one on a single contradiction. Retired and dropped are final: the fact stays in the list, so its key is never made again.
// Pure: the facts and one run's evidence in, the facts out. The proposer's facts (`source: "proposed"`) and promoted ones are not folded here.
import { type Evidence, type Family, factId } from "./envfacts.ts";

/** Confirming runs that make a candidate active. */
export const K_PROMOTE = 3;
/** Recency decay of the score, per run. */
export const GAMMA = 0.8;
/** The weight of a contradiction: a fact fails toward retirement. */
export const LAMBDA = 5;
/** An active fact retires when its score is below this. */
export const SCORE_FLOOR = 0;
/** A fact is injected only when it applied in this share of the runs that used what it is about... */
export const FIRE_GATE = 0.4;
/** ...measured over at least this many of them. */
export const FIRE_MIN_N = 4;
/** A form repair needs this many contradicting runs in a row to count one. */
export const CONTRADICT_STREAK = 2;
/** Cards a fact remembers as having confirmed it. */
const CARDS_KEPT = 20;

/** Facts that are wrong more expensively than they are right: one clean contradiction retires them. */
const HIGH: ReadonlySet<Family> = new Set(["absent_tool", "boundary", "empty_probe"]);

export type FactState = "candidate" | "active" | "retired" | "dropped" | "promoted";

export interface FactRecord {
  id: string;
  family: Family;
  source: "free" | "proposed";
  key: string;
  text: string;
  state: FactState;
  confirmations: number;
  contradictions: number;
  /** Recency score: confirmations count 1, contradictions count -5, each run decays what came before by 0.8. */
  score: number;
  /** Runs that used what the fact is about, and the ones among them where it applied. */
  exercised: number;
  fired: number;
  /** The cards whose runs confirmed it. */
  cards: string[];
  firstRun: string;
  lastRun: string;
  /** Contradicting runs in a row (a form repair only). */
  streak: number;
}

/** What a repository keeps of its facts: every record (retired and dropped ones too, so a key is never learned again) and, per pack, the ids of the facts its latest run was told. */
export interface FactsFile {
  facts: FactRecord[];
  injected: Record<string, string[]>;
}

/** The fact is injected in the next run: active, free, and used often enough that it applied often enough. */
export const fires = (fact: FactRecord): boolean => fact.state === "active" && fact.source === "free" && fact.exercised >= FIRE_MIN_N && fact.fired / fact.exercised >= FIRE_GATE;

const folded = (fact: FactRecord): boolean => fact.source === "free" && (fact.state === "candidate" || fact.state === "active");

function step(fact: FactRecord, ev: Evidence | undefined, run: { runId: string; cardId: string }): FactRecord {
  let confirms = ev?.confirms ?? false;
  let contradicts = ev?.contradicts ?? false;
  let streak = fact.streak;
  if (ev && fact.family === "form_repair" && ev.exercised) {
    streak = contradicts ? streak + 1 : 0;
    if (contradicts && streak < CONTRADICT_STREAK) contradicts = false;
  }
  if (contradicts) confirms = false;
  const next: FactRecord = {
    ...fact,
    text: ev && ev.text !== "" ? ev.text : fact.text,
    confirmations: fact.confirmations + (confirms ? 1 : 0),
    contradictions: fact.contradictions + (contradicts ? 1 : 0),
    score: fact.score * GAMMA + (confirms ? 1 : 0) - (contradicts ? LAMBDA : 0),
    exercised: fact.exercised + (ev?.exercised ? 1 : 0),
    fired: fact.fired + (ev?.exercised && ev.fired ? 1 : 0),
    cards: confirms && !fact.cards.includes(run.cardId) ? [...fact.cards, run.cardId].slice(-CARDS_KEPT) : fact.cards,
    lastRun: ev ? run.runId : fact.lastRun,
    streak,
  };
  if (fact.state === "candidate") {
    if (next.confirmations >= K_PROMOTE) next.state = "active";
    // A high-stakes candidate that is contradicted dies at once; one promoted by this very run does not.
    else if (contradicts && HIGH.has(fact.family)) next.state = "retired";
  } else if ((HIGH.has(fact.family) && contradicts) || next.score < SCORE_FLOOR) next.state = "retired";
  return next;
}

/** The facts after one run: each fact being learned takes what the run says of it (and decays if it says nothing), and a key the run found that no fact holds starts one. */
export function foldFacts(facts: FactRecord[], evidence: Evidence[], run: { runId: string; cardId: string }): FactRecord[] {
  const byId = new Map(evidence.map((e) => [factId(e.family, e.key), e]));
  const held = new Set(facts.map((f) => f.id));
  const out = facts.map((f) => (folded(f) ? step(f, byId.get(f.id), run) : f));
  for (const [id, ev] of byId) {
    if (held.has(id) || ev.text === "") continue;
    const born: FactRecord = { id, family: ev.family, source: "free", key: ev.key, text: "", state: "candidate", confirmations: 0, contradictions: 0, score: 0, exercised: 0, fired: 0, cards: [], firstRun: run.runId, lastRun: run.runId, streak: 0 };
    out.push(step(born, ev, run));
  }
  return out;
}

/** Marks a fact dropped: a person said it is wrong. It stays in the list so the same key is never learned again. */
export function dropFact(facts: FactRecord[], id: string): { facts: FactRecord[]; found: boolean } {
  if (!facts.some((f) => f.id === id)) return { facts, found: false };
  return { facts: facts.map((f) => (f.id === id ? { ...f, state: "dropped" as const } : f)), found: true };
}
