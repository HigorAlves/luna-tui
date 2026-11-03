// Jev through the Vercel AI Gateway: the AI SDK's decision API (`experimental_decide`) on the
// catalog's Gateway ID, with AI_GATEWAY_API_KEY. The `ai` package is the one eve already brings;
// it is loaded on a call only.
import type { Experimental_DecisionQuestion, JSONValue } from "ai";

import type { DecideAnswer } from "./questions.ts";
import type { JevTransport } from "./run.ts";

/** One decision call as the transport makes it; the model is the Gateway's ID. Tests pass a fake. */
export type Decide = (call: {
  model: string;
  state: Record<string, JSONValue>;
  questions: Record<string, Experimental_DecisionQuestion>;
  abortSignal: AbortSignal;
}) => Promise<{
  answers: Record<string, DecideAnswer>;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  response: { modelId: string };
  /** The Gateway passes TypeSafe's own confidences here, under `typesafe.confidence`. */
  providerMetadata?: Record<string, Record<string, unknown>> | undefined;
}>;

/** The AI SDK's own call, on the Gateway provider, which reads AI_GATEWAY_API_KEY. */
const aiSdkDecide: Decide = async (call) => {
  const { experimental_decide, gateway } = await import("ai");
  return experimental_decide({ ...call, model: gateway.decisionModel(call.model) });
};

/** The error under the AI SDK's retries: the last attempt's, which carries the status. */
const lastAttempt = (e: unknown): unknown => (e && typeof e === "object" && "lastError" in e && (e as { lastError: unknown }).lastError) || e;

/** A rate limit's `retry-after` (seconds), from the error or the API call error it wraps. */
function retryAfterSecs(e: unknown): number | null {
  for (const at of [e, (e as { cause?: unknown })?.cause]) {
    const value = (at as { responseHeaders?: Record<string, string> } | undefined)?.responseHeaders?.["retry-after"];
    if (value !== undefined && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/** The call's failure as the stage's: a 429 is a rate limit, an abort the stage's deadline, the rest a reason. */
function failed(thrown: unknown): ReturnType<JevTransport["failed"]> {
  const e = lastAttempt(thrown);
  const name = (e as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") return { error: "jev: no answer before the stage's time ran out", rateLimited: false, resetsAt: null };
  const message = e instanceof Error ? e.message : String(e);
  const status = (e as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number") {
    const after = status === 429 ? retryAfterSecs(e) : null;
    return { error: `jev: HTTP ${status}: ${message}`, rateLimited: status === 429, resetsAt: after === null ? null : Math.ceil(Date.now() / 1000 + after) };
  }
  return { error: `jev: ${message}`, rateLimited: false, resetsAt: null };
}

export function gatewayTransport(decide: Decide = aiSdkDecide): JevTransport {
  return {
    via: "gateway",
    async request({ state, questions, engine }) {
      if (!engine.gatewayId) throw new Error(`engine ${engine.id} is not served on the Vercel AI Gateway`);
      const { toDecide } = await import("./questions.ts");
      return { model: engine.gatewayId, state, questions: toDecide(questions) };
    },
    async decide(call, signal) {
      const { fromDecide } = await import("./questions.ts");
      const request = (await this.request(call)) as unknown as Omit<Parameters<Decide>[0], "abortSignal">;
      const result = await decide({ ...request, abortSignal: signal });
      const reported = (result.providerMetadata?.typesafe?.confidence ?? {}) as Record<string, number>;
      return { model: result.response.modelId, answer: fromDecide(call.questions, result.answers, reported), inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null };
    },
    failed,
  };
}
