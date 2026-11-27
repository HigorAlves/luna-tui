// The regression sweep's failing checks, asked again on the base: what fails there the same way is the repository's own, not the change's,
// and does not block Build (DISC-53: develop's lint has 24 errors in files the card never touched, and lambdas it never touched fail their
// unit tests in the sandbox). A check is the base's only when every failing line the card shows is in the base's output too; a line only the
// card has keeps the check the card's, so a lint error in the card's own file never hides behind a red base.
import type { CheckSpec } from "@hardness/contracts";

import { checkCommand } from "../../domain/checks.ts";
import { FAILING_LINE, LOGGED_LINE, placeOf, type SweepOutcome } from "./sweep.ts";

/** A failing line as two runs can compare it: whitespace collapsed, durations and timings left out. */
const comparable = (line: string): string =>
  line
    .replace(/\s+/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|m)\b/g, "")
    .replace(/\bin\s+\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The lines of an output that say what failed, each with the line above that names its file (`placeOf`), made comparable. */
export function failingLinesOf(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (!FAILING_LINE.test(line) || LOGGED_LINE.test(line)) return [];
    const place = placeOf(lines, i);
    return [place !== null ? `${comparable(lines[place]!)} | ${comparable(line)}` : comparable(line)];
  }).filter(Boolean);
}

/** Whether the card's failing check fails on the base the same way: the base failed, and every failing line of the card is in the base's output. */
export function alsoOnBase(cardOutput: string, baseOutput: string): boolean {
  if (!baseOutput.trim()) return false;
  const base = new Set(failingLinesOf(baseOutput));
  const card = failingLinesOf(cardOutput);
  // No failing line to compare on the card: only an output the same as the base's, timings aside, is the base's.
  if (card.length === 0) {
    const whole = (text: string) => text.split("\n").map(comparable).filter(Boolean).join("\n");
    return whole(cardOutput) !== "" && whole(cardOutput) === whole(baseOutput);
  }
  if (base.size === 0) return false;
  return card.every((line) => base.has(line));
}

export interface SweepBaselineDeps {
  /** The commit the change is measured from; null when unknown. */
  base: () => Promise<string | null>;
  clone: (sha: string) => Promise<{ path: string }>;
  remove: (path: string) => Promise<void>;
  /** Runs the checks in a folder (the machine installs there first), as the sweep runs them. */
  run: (commands: ReturnType<typeof checkCommand>[], cwd: string) => Promise<{ reports: Array<{ name: string; ok: boolean; tail: string }> }>;
  /** The repository's checks, to find each failing one's command by name. */
  checks: readonly CheckSpec[];
}

/** The sweep's outcome once its failing checks were asked on the base: those failing there the same way are noted in `redOnBase` and leave
 *  `failed`. Anything that cannot be asked (no base, no clone, a run that throws) leaves the outcome as it was. */
export async function confirmOnBase(outcome: SweepOutcome, deps: SweepBaselineDeps): Promise<SweepOutcome & { redOnBase?: string[]; base?: string }> {
  if (outcome.status !== "failed" || outcome.failed.length === 0 || outcome.escalated || outcome.aborted) return outcome;
  const specs = outcome.failed.map((f) => deps.checks.find((c) => c.name === f.name)).filter((c): c is CheckSpec => c !== undefined);
  if (specs.length === 0) return outcome;
  const base = await deps.base().catch(() => null);
  if (!base) return outcome;
  let clone: { path: string } | null = null;
  try {
    clone = await deps.clone(base);
    const ran = await deps.run(specs.map(checkCommand), clone.path);
    const red = outcome.failed.filter((f) => {
      const there = ran.reports.find((r) => r.name === f.name);
      return there !== undefined && !there.ok && alsoOnBase(f.tail, there.tail);
    }).map((f) => f.name);
    // A check red on the base too, with lines only the change has: Build gets those lines last (its input keeps the end), so it fixes its own
    // and leaves the repository's (DISC-53: the full lint list mixed develop's errors with the card's, inviting a repo-wide reformat).
    const marked = outcome.failed.filter((f) => !red.includes(f.name)).map((f) => {
      const there = ran.reports.find((r) => r.name === f.name);
      if (!there || there.ok) return f;
      const onBase = new Set(failingLinesOf(there.tail));
      const own = failingLinesOf(f.tail).filter((line) => !onBase.has(line));
      if (own.length === 0) return f;
      return { ...f, tail: `${f.tail}\n--- only these failing lines are this change's; the others fail on the base (${base.slice(0, 8)}) too and are not yours to fix ---\n${[...new Set(own)].join("\n")}` };
    });
    if (red.length === 0) return { ...outcome, failed: marked };
    const failed = marked;
    const note = `already failing on the base (${base.slice(0, 8)}) the same way, so not the change's: ${red.join(", ")}`;
    return { ...outcome, failed, status: failed.length > 0 ? "failed" : "passed", note: outcome.note ? `${outcome.note}; ${note}` : note, redOnBase: red, base };
  } catch {
    return outcome;
  } finally {
    if (clone) await deps.remove(clone.path).catch(() => {});
  }
}
