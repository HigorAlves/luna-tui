// The loop guard's rules (RFC 0007 §2, ported from TokenEconomizer's `loopguard`): how one finished call
// folds into a segment's state, the free gate that wakes the judge, the strict stuck test, the backstop
// and the redirect text. Pure: the guard in guard.ts owns the segments, the judge and the events.
import type { Observation } from "@hardness/contracts";

/** The default preset, verbatim. The plugin's gate waits for `min_turns`, so one number serves both. */
export const THRESHOLDS = {
  minTurns: 20,
  editChurn: 4,
  distinctEditFiles: 3,
  errorOutputs: 6,
  stagnation: 0.2,
  gateErrorOutputs: 8,
} as const;

/** One segment's loop signals: the stretch of a run between two redirects. */
export interface Spiral {
  turns: number;
  editCounts: Map<string, number>;
  errorOutputs: number;
  testRuns: number;
  failSigs: Map<string, number>;
  repeatedFailures: number;
  /** The last failure fingerprint that repeated, for the log. */
  lastRepeat?: string;
  /** One line per call, with base names only: never output text. */
  recent: string[];
}

export function newSpiral(): Spiral {
  return { turns: 0, editCounts: new Map(), errorOutputs: 0, testRuns: 0, failSigs: new Map(), repeatedFailures: 0, recent: [] };
}

/** The last path component, for `/` and `\` alike. */
export function baseName(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() ?? "";
}

/** A shell command as the judge reads it: every path cut to its base name, blanks collapsed, 90 characters at most. */
function shortCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?:[^\s/\\]*[/\\]+)+([^\s/\\]*)/g, (_, last: string) => last)
    .slice(0, 90);
}

function actionOf(call: { tool: string; target: string }): string {
  const tool = call.tool.toLowerCase();
  if (tool === "bash" || tool === "shell") return call.target ? `$ ${shortCommand(call.target)}` : tool;
  return call.target ? `${tool} ${baseName(call.target).slice(0, 40)}` : tool;
}

/** Folds one finished call into the state. A call with an empty observation still counts as a call. */
export function foldSpiral(s: Spiral, o: Observation, call: { tool: string; target: string }): void {
  s.turns++;
  const edits = (o.edits ?? []).map(baseName).filter(Boolean);
  for (const name of edits) s.editCounts.set(name, (s.editCounts.get(name) ?? 0) + 1);
  if (o.testsRan === true || o.intent === "test" || o.intent === "build") s.testRuns++;
  let tag = "";
  if (o.errorClass !== undefined || o.failure !== undefined) {
    s.errorOutputs++;
    if (o.failure !== undefined) {
      if (s.failSigs.has(o.failure)) {
        s.repeatedFailures++;
        s.lastRepeat = o.failure;
      }
      s.failSigs.set(o.failure, (s.failSigs.get(o.failure) ?? 0) + 1);
    }
    tag = `  [${o.errorClass ?? "error"}${o.failure ? `#${o.failure}` : ""}]`;
  }
  const shown = edits.slice(0, 4).join(", ") + (edits.length > 4 ? ", ..." : "");
  const edited = edits.length > 0 ? `  [edits ${shown}]` : "";
  s.recent.push(`${String(s.turns).padStart(3)}: ${actionOf(call)}${edited}${tag}`);
  if (s.recent.length > 40) s.recent = s.recent.slice(-40);
}

export function editChurn(s: Spiral): number {
  return Math.max(0, ...s.editCounts.values());
}

/** The share of failures that repeat an earlier one, 0 without failures. */
export function stagnation(s: Spiral): number {
  let failures = 0;
  for (const n of s.failSigs.values()) failures += n;
  return failures === 0 ? 0 : s.repeatedFailures / failures;
}

/** The free gate: worth a paid look? Permissive on purpose; the judge supplies the precision. */
export function gateOpen(s: Spiral): boolean {
  if (s.turns < THRESHOLDS.minTurns) return false;
  return s.repeatedFailures >= 1 || s.errorOutputs >= THRESHOLDS.gateErrorOutputs;
}

/** The strict heuristic: churn, noise and repetition together, after a fair run of calls. */
export function isStuck(s: Spiral): boolean {
  if (s.turns < THRESHOLDS.minTurns) return false;
  const churny = editChurn(s) >= THRESHOLDS.editChurn || s.editCounts.size >= THRESHOLDS.distinctEditFiles;
  return churny && s.errorOutputs >= THRESHOLDS.errorOutputs && stagnation(s) >= THRESHOLDS.stagnation;
}

/** The hard backstop, upstream's cumulative one: once the run's calls, over every segment, reach the envelope times the multiple, a stuck
 *  segment is stuck whatever the judge says. After a redirect the fresh segment therefore gets a short rope. */
export function backstopHit(s: Spiral, run: Spiral, envelope: number | null, mult: number): boolean {
  return envelope !== null && run.turns >= envelope * mult && isStuck(s);
}

/** The redirect: the agent's own repeated actions mirrored back at it. Nothing in it but counts and a base name. */
export function redirectText(s: Spiral): string {
  let busiest = "one file";
  let most = 0;
  for (const [name, n] of s.editCounts) {
    if (n > most) {
      most = n;
      busiest = name;
    }
  }
  let edits = 0;
  for (const n of s.editCounts.values()) edits += n;
  return (
    "Process check (automated): so far you've made " +
    `${edits} edits across ` +
    `${s.editCounts.size} file(s) (most to \`${busiest}\`) and run ` +
    `${s.testRuns} verification(s), and the same failure has recurred ` +
    `${s.repeatedFailures} time(s) without the tests going green. This ` +
    "looks like a repetitive loop. Do NOT stop — instead step back and try a " +
    "MATERIALLY DIFFERENT hypothesis: re-read the failing test's expectation, " +
    "consider a different file or root cause than the ones you've been editing, " +
    "and verify the new hypothesis directly before editing again."
  );
}
