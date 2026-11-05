// What a runtime's own usage numbers mean as Build's token count: new work, never the model's text. A long session re-reads its context every turn,
// and counting those reads at full weight would spend a 2-million budget in one run, so the cache's reads are kept beside the count (`cached`) and
// off it. A runtime that gave no numbers gives null.
export interface Tokens {
  /** New input: uncached input plus what was written to the cache (Claude), or input minus its cached part (eve). */
  input: number;
  output: number;
  /** Input read from the cache: kept beside the count, not part of it. */
  cached: number;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function claudeTokens(usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined): Tokens | null {
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  if (input === null || output === null) return null;
  return { input: input + (num(usage?.cache_creation_input_tokens) ?? 0), output, cached: num(usage?.cache_read_input_tokens) ?? 0 };
}

export function eveTokens(usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined): Tokens | null {
  const input = num(usage?.inputTokens);
  const output = num(usage?.outputTokens);
  if (input === null || output === null) return null;
  const cached = Math.min(input, num(usage?.cachedInputTokens) ?? 0);
  return { input: input - cached, output, cached };
}

export function sumTokens(a: Tokens | null, b: Tokens | null): Tokens | null {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached };
}
