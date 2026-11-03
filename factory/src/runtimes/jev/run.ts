// The Jev runtime: a decision pack's questions to TypeSafe's `systemOne` in one call. No prompt,
// tools or turns: the issue is the state, and the answer comes back in the pack's derived schema.
// Jev is opt-in and metered: without TYPESAFE_API_KEY the stage ends with a reason, not a crash.
// The SDK is loaded on a Jev run only, so an agent stage does not pay for it at start.
import type { StageInput } from "@hardness/contracts";
import type { JsonValue, Questions, RequestOptions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

import { EMPTY_RUN, type RunOutcome } from "../../core/output.ts";
import type { RunContext, Runtime } from "../../core/runtime.ts";

type Sdk = typeof import("@typesafe-ai/sdk");

/** The part of the SDK's client the runtime uses; tests pass a fake. */
export interface JevClient {
  systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): PromiseLike<SystemOneResult<Questions>>;
}

async function typesafeClient(): Promise<JevClient> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is not set: Jev is opt-in and metered, so a decision pack does not run without it");
  const { TypeSafeClient } = await import("@typesafe-ai/sdk");
  return new TypeSafeClient();
}

/** What Jev reads: the issue the notch or intake sent, else the task's own title and description. */
export function stateOf(input: StageInput): Record<string, JsonValue> {
  const { title, description, labels, source } = input.context.issue ?? { title: input.task.title, description: input.task.description };
  return { title, description, ...(labels && { labels }), ...(source && { source }) };
}

const two = (n: number) => n.toFixed(2);

/** One line per answer for the board, and which fall below the pack's confidence floor. */
function summary(answer: Record<string, any>, minConfidence: number): string {
  const low: string[] = [];
  const parts = Object.entries(answer).map(([name, a]) => {
    const confidence = "p" in a ? Math.max(a.p, 1 - a.p) : a.confidence;
    if (confidence < minConfidence) low.push(name);
    if ("choice" in a) return `${name} ${a.choice} (${two(a.confidence)})`;
    if ("p" in a) return `${name} ${a.value ? "yes" : "no"} (p ${two(a.p)})`;
    return `${name} ${Math.round(a.score * 100) / 100} (${two(a.confidence)})`;
  });
  return [...parts, ...(low.length > 0 ? [`below ${minConfidence}: ${low.join(", ")}`] : [])].join(" · ");
}

/** The SDK's failure as the stage's: a 429 is a rate limit with when to retry, the rest a reason. */
function failed(e: unknown, { APIConnectionError, APIError, APIUserAbortError, RateLimitError }: Sdk): Pick<RunOutcome, "error" | "rateLimited" | "resetsAt"> {
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

export function jevRuntime(client: () => JevClient | Promise<JevClient> = typesafeClient): Runtime {
  return {
    id: "jev",
    async run({ pack, engine, input, luna, dry, out }: RunContext): Promise<RunOutcome> {
      if (pack.kind !== "decision") return { ...EMPTY_RUN, error: `pack ${pack.id} is not a decision pack` };
      const t0 = Date.now();
      let sdk: Sdk | null = null;
      try {
        sdk = await import("@typesafe-ai/sdk");
        const { fromJev, toJev } = await import("./questions.ts");
        const request = { state: stateOf(input), questions: toJev(pack.questions), model: engine.modelId };
        if (dry) {
          out(JSON.stringify(request, null, 2));
          let structured: Record<string, unknown> | null = null;
          try {
            structured = process.env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(process.env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
          } catch {}
          return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
        }
        const result = await (await client()).systemOne(request, { signal: AbortSignal.timeout(input.limits.timeoutMs) });
        const durationMs = Date.now() - t0;
        const { input_tokens: tokensIn, output_tokens: tokensOut } = result.usage;
        out(`jev · model ${result.model} · ${tokensIn ?? "?"} in · ${tokensOut ?? "?"} out · ${durationMs} ms`);
        luna.state.events.push({ kind: "note", payload: { phase: "usage", model: result.model, inputTokens: tokensIn, outputTokens: tokensOut } });
        const run = { ...EMPTY_RUN, turns: 1, durationMs, model: result.model };
        const parsed = pack.answer.safeParse(fromJev(pack.questions, result.answers));
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          return { ...run, error: `jev: the answer does not fit ${pack.id}: ${issues}` };
        }
        const answer = parsed.data as Record<string, unknown>;
        const text = summary(answer, pack.minConfidence);
        out(text);
        return { ...run, ok: true, structured: answer, text };
      } catch (e) {
        const reason = sdk ? failed(e, sdk) : { error: `jev: ${e instanceof Error ? e.message : String(e)}`, rateLimited: false, resetsAt: null };
        return { ...EMPTY_RUN, ...reason, durationMs: Date.now() - t0 };
      }
    },
  };
}

export const jev = jevRuntime();
