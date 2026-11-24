// The loop guard a runtime runs per finished tool call (RFC 0007 §2). It folds the call's Observation
// into the segment's state and says what the runtime does next: nothing, ask a judge, send a redirect,
// or stop the run. In `record` mode, or before the repo has an envelope, it only writes gate events.
// It reads classes and counts, never output text, and it never throws.
import { LOOP_STUCK, type GuardInput, type Observation, type RunEvent } from "@hardness/contracts";

import { backstopHit, editChurn, foldSpiral, gateOpen, newSpiral, redirectText, stagnation, type Spiral } from "./rules.ts";

export type GuardStep =
  | { kind: "none" }
  | { kind: "ask"; digest: string }
  | { kind: "redirect"; text: string }
  | { kind: "stop"; reason: string };

export interface Verdict {
  stuck: boolean;
  confidence: number;
  cause: string;
  redirect?: string;
}

const NONE: GuardStep = { kind: "none" };
/** Segment calls between two judge requests: the base, the growth after a productive verdict, the cap. */
const BASE_GAP = 5;
const GAP_GROWTH = 5;
const MAX_GAP = 20;
const REDIRECT_CAP = 1200;
const CAUSE_CAP = 60;

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);
/** A cause as the host's `EconomyGuardEvent` takes it: letters, digits and a little punctuation, at most `CAUSE_CAP` characters. */
const causeOf = (s: string): string => oneLine(s.replace(/[^A-Za-z0-9_ ,.:-]/g, " "), CAUSE_CAP);
/** Python's `{x:.0f}`: halves go to the even neighbour. */
const whole = (x: number): string => (x % 1 === 0.5 ? String(2 * Math.round(x / 2)) : String(Math.round(x)));

export class LoopGuard {
  private segment: Spiral = newSpiral();
  private run: Spiral = newSpiral();
  private lastAsk = -999;
  private gap = BASE_GAP;
  private asking = false;
  private pending: Verdict | null = null;
  private gateSeen = false;
  private redirectsGiven = 0;
  private stopped: GuardStep | null = null;
  /** Verification, over the whole run: the call of the last edit and of the last test run, and whether that run failed. */
  private lastEdit = 0;
  private lastVerify = 0;
  private lastVerifyFailed = false;
  /** The segment call at which the judge last said, sure of it, that the run is not stuck. */
  private calmAt = -1;

  private readonly input: GuardInput;
  private readonly emit: (event: RunEvent) => void;

  constructor(input: GuardInput, emit: (event: RunEvent) => void) {
    this.input = input;
    this.emit = emit;
  }

  /** Folds one finished call and says what the runtime does next. */
  fold(observation: Observation, call: { tool: string; target: string }): GuardStep {
    try {
      return this.step(observation, call);
    } catch {
      return NONE;
    }
  }

  /** A judge's answer, whenever it arrives; it is applied on the next fold. An answer for a segment that has ended is dropped. */
  verdict(v: Verdict): void {
    if (this.asking) this.pending = v;
  }

  /** The outstanding ask will not be answered: the guard may ask again. No verdict was given, so the gap does not grow. */
  expire(): void {
    this.asking = false;
    this.pending = null;
  }

  /** The last 24 actions as the judge reads them: tool, command cut to 90 characters, base names only, error class. Never output text. */
  digest(): string {
    try {
      const s = this.segment;
      const { envelope } = this.input;
      let head =
        `turns=${s.turns} edit_churn=${editChurn(s)} distinct_edit_files=${s.editCounts.size} ` +
        `error_outputs=${s.errorOutputs} test_runs=${s.testRuns} repeated_identical_failures=${s.repeatedFailures} ` +
        `stagnation=${stagnation(s).toFixed(2)}`;
      if (envelope) {
        head +=
          `\nrepo_context: tasks here usually RESOLVE within ~${whole(envelope)} calls; this trajectory is at ${s.turns} calls = ` +
          `${(s.turns / envelope).toFixed(1)}x that typical length. ${this.verification()} A trajectory far past the typical ` +
          "resolved length with recurring failures is likely a dead-end loop, even if it touches many files.";
      }
      return `${head}\nRecent actions (oldest->newest):\n${s.recent.slice(-24).join("\n")}`;
    } catch {
      return "";
    }
  }

  private verification(): string {
    if (this.lastVerify === 0) return "No test or verification run has been seen in this turn.";
    const edited = this.lastEdit > this.lastVerify ? " There have been edits since." : "";
    return `The last verification run ${this.lastVerifyFailed ? "failed" : "passed"}.${edited}`;
  }

  private step(o: Observation, call: { tool: string; target: string }): GuardStep {
    if (this.stopped) return this.stopped;
    foldSpiral(this.segment, o, call);
    foldSpiral(this.run, o, call);
    this.trackVerification(o);
    const s = this.segment;

    const acting = this.input.mode === "on" && this.input.envelope !== null;
    const open = gateOpen(s);
    if (open && !this.gateSeen) {
      this.gateSeen = true;
      this.emit({
        kind: "economy.guard",
        payload: { action: "gate", calls: s.turns, cause: s.repeatedFailures >= 1 ? "repeat" : "errors", ...(s.lastRepeat ? { failure: s.lastRepeat } : {}) },
      });
    }
    if (!acting) return NONE;

    // The verdict that arrived since the last call. Only a verdict that is not stuck grows the gap; a stuck one under the bar resets it.
    let judged: Verdict | null = null;
    if (this.pending) {
      const v = this.pending;
      this.pending = null;
      this.asking = false;
      if (v.stuck && v.confidence >= this.input.judgeConfidence) judged = v;
      else this.gap = v.stuck ? BASE_GAP : Math.min(MAX_GAP, this.gap + GAP_GROWTH);
      if (!v.stuck && v.confidence >= this.input.judgeConfidence) this.calmAt = s.turns;
    }
    if (judged) return this.act(judged);
    // A sure "not stuck" holds the backstop off for a while (a passing suite that prints error markers reads as failing), never past twice its length.
    const calm = this.calmAt >= 0 && s.turns - this.calmAt < MAX_GAP && this.input.envelope !== null && this.run.turns < 2 * this.input.envelope * this.input.backstopMult;
    if (!calm && backstopHit(s, this.run, this.input.envelope, this.input.backstopMult)) return this.act({ stuck: true, confidence: 1, cause: "backstop" });

    if (this.input.judge && open && !this.asking && s.turns - this.lastAsk >= this.gap) {
      this.lastAsk = s.turns;
      this.asking = true;
      this.emit({ kind: "economy.guard", payload: { action: "judge", calls: s.turns } });
      return { kind: "ask", digest: this.digest() };
    }
    return NONE;
  }

  /** A stuck verdict: a redirect while any are left, then the stop. */
  private act(v: Verdict): GuardStep {
    const s = this.segment;
    const cause = causeOf(v.cause);
    const payload = { calls: s.turns, cause, confidence: v.confidence, ...(s.lastRepeat ? { failure: s.lastRepeat } : {}) };
    if (this.redirectsGiven < this.input.redirects) {
      const written = v.redirect?.trim().slice(0, REDIRECT_CAP);
      const text = written || redirectText(s);
      this.emit({ kind: "economy.guard", payload: { action: "redirect", ...payload } });
      this.redirectsGiven++;
      this.segment = newSpiral();
      this.lastAsk = -999;
      this.gap = BASE_GAP;
      this.asking = false;
      this.pending = null;
      this.gateSeen = false;
      this.calmAt = -1;
      return { kind: "redirect", text };
    }
    this.emit({ kind: "economy.guard", payload: { action: "stop", ...payload } });
    this.stopped = { kind: "stop", reason: `${LOOP_STUCK}: ${cause}, the same failure ${this.run.repeatedFailures} times over ${this.run.turns} calls` };
    return this.stopped;
  }

  private trackVerification(o: Observation): void {
    const n = this.run.turns;
    if (o.edits && o.edits.length > 0) this.lastEdit = n;
    if (o.testsRan === true || o.intent === "test" || o.intent === "build") {
      this.lastVerify = n;
      this.lastVerifyFailed = o.errorClass !== undefined || o.failure !== undefined;
    }
  }
}
