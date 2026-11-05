import { describe, expect, it } from "vitest";

import { PUSH_BACKOFF_MS, retryWithBackoff } from "./backoff.ts";

describe("retryWithBackoff", () => {
  const instant = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  };

  it("waits 1 s, 5 s and 25 s between the tries of a push", () => {
    expect(PUSH_BACKOFF_MS).toEqual([1000, 5000, 25000]);
  });

  it("stops at the first success: two failures then a success is three tries and two waits", async () => {
    const t = instant();
    let n = 0;
    const result = await retryWithBackoff(async () => (++n < 3 ? `failed ${n}` : null), { delaysMs: PUSH_BACKOFF_MS, sleep: t.sleep });
    expect(result).toEqual({ error: null, tries: 3 });
    expect(t.waits).toEqual([1000, 5000]);
  });

  it("gives up after the first try and one retry per delay, and says the last error", async () => {
    const t = instant();
    let n = 0;
    const result = await retryWithBackoff(async () => `failed ${++n}`, { delaysMs: PUSH_BACKOFF_MS, sleep: t.sleep });
    expect(result).toEqual({ error: "failed 4", tries: 4 });
    expect(t.waits).toEqual([1000, 5000, 25000]);
  });

  it("stops waiting when the stage's signal aborts, without another try", async () => {
    const controller = new AbortController();
    let n = 0;
    const result = await retryWithBackoff(async () => `failed ${++n}`, { delaysMs: PUSH_BACKOFF_MS, signal: controller.signal, sleep: async () => controller.abort() });
    expect(result).toEqual({ error: "failed 1", tries: 1 });
  });

  it("really waits on a timer that the signal cuts short", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const t0 = Date.now();
    await retryWithBackoff(async () => "no", { delaysMs: [60_000], signal: controller.signal });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("does not try at all once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let n = 0;
    expect(await retryWithBackoff(async () => (n++, null), { delaysMs: [1], signal: controller.signal })).toEqual({ error: "aborted", tries: 0 });
    expect(n).toBe(0);
  });
});
