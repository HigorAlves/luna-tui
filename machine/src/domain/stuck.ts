// The in-run half of the stuck detector: OpenHands' repetition thresholds over the transcript
// a stage streams (`→ <Tool> <target>` per tool call). A loop that will never converge is
// stopped before it spends the rest of its turn budget; the attempt-level half (pipeline.ts)
// then sees the same failure and escalates.

/** The same tool call this many times in a row. */
export const SAME_CALL_LIMIT = 4;
/** Two tool calls alternating this many times (A B A B A B): the red-green loop that never turns green. */
export const ALTERNATING_LIMIT = 6;

export class StuckDetector {
  private readonly calls: string[] = [];

  /** Feeds one transcript line; returns the reason to stop, or null. Text lines are ignored. */
  feed(line: string): string | null {
    if (!line.startsWith("→ ")) return null;
    const call = line.slice(2).trim();
    this.calls.push(call);
    const n = this.calls.length;
    if (n >= SAME_CALL_LIMIT && this.calls.slice(-SAME_CALL_LIMIT).every((c) => c === call)) {
      return `the same call ${SAME_CALL_LIMIT} times in a row: ${call}`;
    }
    if (n >= ALTERNATING_LIMIT) {
      const tail = this.calls.slice(-ALTERNATING_LIMIT);
      const [a, b] = tail;
      if (a !== b && tail.every((c, i) => c === (i % 2 === 0 ? a : b))) {
        return `alternating between two calls ${ALTERNATING_LIMIT} times: ${a} / ${b}`;
      }
    }
    return null;
  }
}
