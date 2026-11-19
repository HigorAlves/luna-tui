// The designer agents' own budget for one card (RFC 0013, Budget): the tokens and minutes of every designer run, from the machine's `design.run`
// rows (written by designRun from the runtime's own count, never a model's text), counted from the last `design.budget_reset`. Pure.
export interface DesignLimits {
  max_tokens: number;
  max_minutes: number;
}

export interface DesignBudget {
  tokens: number | null;
  tokensCounted: boolean;
  minutes: number;
  spent: "tokens" | "minutes" | null;
  limits: DesignLimits;
}

const whole = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function designBudget(events: readonly { kind: string; payload: Record<string, unknown> }[], limits: DesignLimits): DesignBudget {
  const from = events.findLastIndex((e) => e.kind === "design.budget_reset") + 1;
  let tokens: number | null = null;
  let minutes = 0;
  for (const { kind, payload } of events.slice(from)) {
    if (kind !== "design.run") continue;
    if (whole(payload.tokens)) tokens = (tokens ?? 0) + payload.tokens;
    if (typeof payload.minutes === "number" && payload.minutes >= 0) minutes += payload.minutes;
  }
  minutes = round1(minutes);
  const spent = tokens !== null && tokens > limits.max_tokens ? "tokens" : minutes > limits.max_minutes ? "minutes" : null;
  return { tokens, tokensCounted: tokens !== null, minutes, spent, limits };
}
