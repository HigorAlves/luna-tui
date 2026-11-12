import { describe, expect, it } from "vitest";

import { claudeTokens, eveTokens, sumTokens } from "./usage.ts";

describe("tokens count new work, with the cache's reads kept beside it", () => {
  it("on Claude: uncached input plus cache writes plus output; the cache reads are `cached`, off the count", () => {
    expect(claudeTokens({ input_tokens: 1000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 900_000, output_tokens: 500 })).toEqual({ input: 5000, output: 500, cached: 900_000, cacheWrite5m: 4000 });
    expect(claudeTokens({ input_tokens: 10, output_tokens: 2 })).toEqual({ input: 10, output: 2, cached: 0 });
  });

  it("on Claude: the cache writes keep the lifetime the SDK names, and without it all count as five-minute writes", () => {
    const usage = { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 1500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1000 } };
    expect(claudeTokens(usage)).toEqual({ input: 1600, output: 5, cached: 0, cacheWrite5m: 500, cacheWrite1h: 1000 });
    expect(claudeTokens({ ...usage, cache_creation: { ephemeral_1h_input_tokens: 1500 } })).toEqual({ input: 1600, output: 5, cached: 0, cacheWrite5m: 0, cacheWrite1h: 1500 });
    expect(claudeTokens({ ...usage, cache_creation: undefined })).toEqual({ input: 1600, output: 5, cached: 0, cacheWrite5m: 1500 });
  });

  it("on eve: input minus its cached part, plus output; the cached part is `cached`", () => {
    expect(eveTokens({ inputTokens: 100_000, cacheReadTokens: 90_000, outputTokens: 700 })).toEqual({ input: 10_000, output: 700, cached: 90_000 });
    expect(eveTokens({ inputTokens: 500, outputTokens: 50 })).toEqual({ input: 500, output: 50, cached: 0 });
    expect(eveTokens({ inputTokens: 100, cacheReadTokens: 500, outputTokens: 1 })).toEqual({ input: 0, output: 1, cached: 100 });
  });

  it("is null where the runtime gave no numbers, never a guess", () => {
    expect(claudeTokens(undefined)).toBeNull();
    expect(claudeTokens({ input_tokens: 5 })).toBeNull();
    expect(eveTokens({ outputTokens: 5 })).toBeNull();
  });

  it("adds counts, treating a missing one as nothing", () => {
    expect(sumTokens({ input: 1, output: 2, cached: 3 }, { input: 10, output: 20, cached: 30 })).toEqual({ input: 11, output: 22, cached: 33 });
    expect(sumTokens({ input: 1, output: 1, cached: 0, cacheWrite5m: 4 }, { input: 1, output: 1, cached: 0, cacheWrite1h: 6 })).toEqual({ input: 2, output: 2, cached: 0, cacheWrite5m: 4, cacheWrite1h: 6 });
    expect(sumTokens(null, { input: 1, output: 2, cached: 0 })).toEqual({ input: 1, output: 2, cached: 0 });
  });
});
