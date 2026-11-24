// Jev through TypeSafe's own API: `systemOne` on `@typesafe-ai/sdk`, with TYPESAFE_API_KEY. The
// SDK is loaded on a call only, so an agent stage does not pay for it at start.
import type { RequestOptions, SystemOneRequest, SystemOneResult, Questions } from "@typesafe-ai/sdk";

import type { JevTransport } from "./run.ts";

type Sdk = typeof import("@typesafe-ai/sdk");

/** The part of the SDK's client the transport uses; tests pass a fake. */
export interface JevClient {
  systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): PromiseLike<SystemOneResult<Questions>>;
}

/** The runtime's words when neither key is there: the only way a Jev stage ends before a call. */
export const NO_JEV_CREDENTIAL = "no Jev credential: neither AI_GATEWAY_API_KEY nor TYPESAFE_API_KEY is set, and Jev is opt-in and metered, so a decision pack does not run without one";

async function typesafeClient(): Promise<JevClient> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error(NO_JEV_CREDENTIAL);
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  return new TypeSafeClient();
}

/** The SDK's failure as the stage's: a 429 is a rate limit with when to retry, the rest a reason. */
function failed(e: unknown, { APIConnectionError, APIError, APIUserAbortError, RateLimitError }: Sdk): ReturnType<JevTransport["failed"]> {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof APIError) {
    const retryMs = e instanceof RateLimitError ? e.retryAfterMs : undefined;
    const resetsAt = retryMs !== undefined ? Math.ceil((Date.now() + retryMs) / 1000) : null;
    return { error: `jev: HTTP ${e.status}: ${message}`, rateLimited: e.status === 429, resetsAt: e.status === 429 ? resetsAt : null };
  }
  // The stage's own deadline, passed as the call's signal, cut the SDK's retries short.
  if (e instanceof APIUserAbortError) return { error: "jev: no answer before the stage's time ran out", rateLimited: false, resetsAt: null };
  if (e instanceof APIConnectionError) return { error: `jev: could not reach the API: ${message}`, rateLimited: false, resetsAt: null };
  return { error: `jev: ${message}`, rateLimited: false, resetsAt: null };
}

export function typesafeTransport(client: () => JevClient | Promise<JevClient> = typesafeClient): JevTransport {
  let sdk: Sdk | null = null;
  return {
    via: "typesafe",
    async request({ state, questions, engine }) {
      const { toJev } = await import("./questions.ts");
      return { state, questions: toJev(questions), model: engine.modelId };
    },
    async decide(call, signal) {
      sdk = await import("@typesafe-ai/sdk");
      const { fromJev } = await import("./questions.ts");
      const request = (await this.request(call)) as unknown as SystemOneRequest<Questions>;
      const result = await (await client()).systemOne(request, { signal });
      return { model: result.model, answer: fromJev(call.questions, result.answers), inputTokens: result.usage.input_tokens ?? null, outputTokens: result.usage.output_tokens ?? null };
    },
    failed: (e) => (sdk ? failed(e, sdk) : { error: `jev: ${e instanceof Error ? e.message : String(e)}`, rateLimited: false, resetsAt: null }),
  };
}
