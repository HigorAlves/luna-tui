// The paid proposer's facts (te-spec 2.3 and 2.4): what is let in from a model's answer, and how a proposed fact is folded run by run. A fact is
// admitted only when its detector confirms on every run it cites; it forms by the different-files rule (a confirming run counts when it edited
// nothing, or edited no file that an earlier counted run edited), so three runs of one change cannot make it active; it retires as a free fact does, on its
// recency score. Pure: the answer, the window and the facts in, the facts out.
import { Detector, type FactProposal } from "@hardness/contracts";

import { evaluate, filesOf } from "./detector.ts";
import { factId } from "./envfacts.ts";
import { GAMMA, K_PROMOTE, LAMBDA, type FactRecord, SCORE_FLOOR } from "./lifecycle.ts";
import type { Digest, ObservedCall } from "./observe-run.ts";
import { sayableText } from "./render-facts.ts";

/** Facts admitted per tick. */
export const MAX_ADMITTED = 4;
/** Runs a fact must cite, each one a run of the window on which its detector confirms. */
export const MIN_CITES = 2;
/** Edited-file sets a proposed fact remembers (the newest), and the paths of each. */
const SETS_KEPT = 10;
const PATHS_KEPT = 50;
/** Cards a fact remembers as having confirmed it. */
const CARDS_KEPT = 20;

/** A text as two statements of one fact agree on it: lower case, words only. */
export const normalised = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface Run {
  runId: string;
  cardId: string;
  calls: readonly ObservedCall[];
}

/** One run's effect on a proposed fact being learned. */
function step(fact: FactRecord, run: Run): FactRecord {
  if (!fact.detector) return fact;
  const verdict = evaluate(fact.detector, run.calls);
  const sets = fact.fileSets ?? [];
  // upstream's rule: a confirming run counts when its file set is empty or disjoint from every kept set; only counted runs' sets are kept.
  const files = verdict.confirms ? filesOf(run.calls) : [];
  const counts = verdict.confirms && files.every((f) => !sets.some((set) => set.includes(f)));
  const next: FactRecord = {
    ...fact,
    confirmations: fact.confirmations + (counts ? 1 : 0),
    contradictions: fact.contradictions + (verdict.contradicts ? 1 : 0),
    score: fact.score * GAMMA + (verdict.confirms ? 1 : 0) - (verdict.contradicts ? LAMBDA : 0),
    exercised: fact.exercised + (verdict.exercised ? 1 : 0),
    // Upstream's `fired` defaults to the scope: a proposed fact applies whenever it is in scope.
    fired: fact.fired + (verdict.exercised ? 1 : 0),
    cards: verdict.confirms && !fact.cards.includes(run.cardId) ? [...fact.cards, run.cardId].slice(-CARDS_KEPT) : fact.cards,
    fileSets: counts && files.length > 0 ? [...sets, files.slice(0, PATHS_KEPT)].slice(-SETS_KEPT) : sets,
    lastRun: verdict.exercised ? run.runId : fact.lastRun,
  };
  if (fact.state === "candidate" && next.confirmations >= K_PROMOTE) next.state = "active";
  else if (fact.state === "active" && next.score < SCORE_FLOOR) next.state = "retired";
  return next;
}

/** The facts after one run: each proposed fact still being learned or told takes what its detector says of the run. Other facts are as they were. */
export function foldProposed(facts: FactRecord[], run: Run): FactRecord[] {
  return facts.map((f) => (f.source === "proposed" && (f.state === "candidate" || f.state === "active") ? step(f, run) : f));
}

/** The facts of a proposer's answer the machine lets in: each cites runs of the window (at least two) on which its detector confirms, says one line the free facts' lint and secret check let through, and is no copy of a fact held in any state. A fact enters as if the window had been folded through it. */
export function admit(answer: FactProposal, digests: readonly Digest[], callsByRun: Readonly<Record<string, readonly ObservedCall[]>>, known: readonly FactRecord[]): FactRecord[] {
  const held = new Set(known.map((f) => normalised(f.text)));
  const out: FactRecord[] = [];
  for (const proposed of answer.facts) {
    if (out.length >= MAX_ADMITTED) break;
    const detector = Detector.safeParse(proposed.detector);
    const text = proposed.text.trim();
    const key = normalised(text);
    if (!detector.success || key === "" || held.has(key) || !sayableText(text)) continue;
    const cites = [...new Set(proposed.cites)];
    const grounded = cites.length >= MIN_CITES && cites.every((id) => digests.some((d) => d.runId === id) && evaluate(detector.data, callsByRun[id] ?? []).confirms);
    if (!grounded) continue;
    held.add(key);
    const born: FactRecord = { id: factId("proposed", key), family: "proposed", source: "proposed", key, text, state: "candidate", confirmations: 0, contradictions: 0, score: 0, exercised: 0, fired: 0, cards: [], firstRun: cites[0]!, lastRun: cites[0]!, streak: 0, detector: detector.data, fileSets: [], section: proposed.section };
    out.push(digests.reduce((fact, d) => (callsByRun[d.runId] ? foldProposed([fact], { runId: d.runId, cardId: d.cardId, calls: callsByRun[d.runId]! })[0]! : fact), born));
  }
  return out;
}
