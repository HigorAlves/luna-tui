// Scripted Jev calls for the conformance table: a client that plays a script the way TypeSafe's
// API would answer one systemOne call, and a decide that plays it the way the Gateway would. A decision runtime makes one call and no tool calls, so only the
// first step that answers, limits, fails or hangs matters.
import { APIError, APIUserAbortError } from "@typesafe-ai/sdk";

import type { ScriptStep } from "../conformance/table.ts";
import type { Decide } from "./gateway.ts";
import type { JevClient } from "./typesafe.ts";

export function scriptedClient(script: ScriptStep[]): JevClient {
  return {
    async systemOne(_request, options) {
      const step = script.find((s): s is Exclude<ScriptStep, { call: string }> => !("call" in s));
      if (step === undefined || "hang" in step) {
        const signal = options?.signal;
        await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
        throw new APIUserAbortError();
      }
      if ("rateLimit" in step) throw APIError.fromResponse(429, { error: "Rate limit reached" }, new Headers({ "retry-after": "30" }));
      if ("fail" in step) throw APIError.fromResponse(400, { error: step.fail }, new Headers());
      return { model: "jev-scripted", answers: step.answer, usage: { input_tokens: 10, output_tokens: 2 } } as unknown as Awaited<ReturnType<JevClient["systemOne"]>>;
    },
  };
}

export function scriptedDecide(script: ScriptStep[]): Decide {
  return async ({ abortSignal }) => {
    const step = script.find((s): s is Exclude<ScriptStep, { call: string }> => !("call" in s));
    if (step === undefined || "hang" in step) {
      await new Promise<void>((resolve) => (abortSignal.aborted ? resolve() : abortSignal.addEventListener("abort", () => resolve(), { once: true })));
      throw abortSignal.reason;
    }
    if ("rateLimit" in step) throw Object.assign(new Error("Rate limit exceeded"), { statusCode: 429, cause: { responseHeaders: {} } });
    if ("fail" in step) throw Object.assign(new Error(step.fail), { statusCode: 400 });
    return { answers: step.answer as Awaited<ReturnType<Decide>>["answers"], usage: { inputTokens: 10, outputTokens: 0 }, response: { modelId: "jev-scripted" } };
  };
}
