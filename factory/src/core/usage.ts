// What a runtime's own usage numbers mean as Build's token count: see `Tokens` in contracts/src/economy.ts. A runtime that gave no numbers gives null.
import type { Tokens } from "@hardness/contracts";

export type { Tokens };

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function claudeTokens(
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null } | undefined,
): Tokens | null {
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  if (input === null || output === null) return null;
  const created = num(usage?.cache_creation_input_tokens) ?? 0;
  // The SDK splits the writes by lifetime when it can; when it does not, every write is priced as the common five-minute one.
  const write5m = num(usage?.cache_creation?.ephemeral_5m_input_tokens);
  const write1h = num(usage?.cache_creation?.ephemeral_1h_input_tokens);
  const tokens: Tokens = { input: input + created, output, cached: num(usage?.cache_read_input_tokens) ?? 0 };
  if (write5m !== null || write1h !== null) {
    tokens.cacheWrite5m = write5m ?? 0;
    tokens.cacheWrite1h = write1h ?? 0;
  } else if (created > 0) tokens.cacheWrite5m = created;
  return tokens;
}

/** eve's `Usage` (`usage.recorded`): `inputTokens` is every input token, `cacheReadTokens` the part of it served from the cache. */
export function eveTokens(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | undefined): Tokens | null {
  const input = num(usage?.inputTokens);
  const output = num(usage?.outputTokens);
  if (input === null || output === null) return null;
  const cached = Math.min(input, num(usage?.cacheReadTokens) ?? 0);
  return { input: input - cached, output, cached };
}

export function sumTokens(a: Tokens | null, b: Tokens | null): Tokens | null {
  if (!a) return b;
  if (!b) return a;
  const total: Tokens = { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached };
  if (a.cacheWrite5m !== undefined || b.cacheWrite5m !== undefined) total.cacheWrite5m = (a.cacheWrite5m ?? 0) + (b.cacheWrite5m ?? 0);
  if (a.cacheWrite1h !== undefined || b.cacheWrite1h !== undefined) total.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
  return total;
}
