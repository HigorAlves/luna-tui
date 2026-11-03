// A scripted Jev client for the conformance table: it plays a script the way TypeSafe's API would
// answer one systemOne call. A decision runtime makes one call and no tool calls, so only the
// first step that answers, limits, fails or hangs matters.
import { APIError, APIUserAbortError } from "@typesafe-ai/sdk";

import type { ScriptStep } from "../conformance/table.ts";
import type { JevClient } from "./run.ts";

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
