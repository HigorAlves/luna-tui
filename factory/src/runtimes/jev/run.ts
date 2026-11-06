// The Jev runtime: a decision pack's questions to Jev in one call. No prompt, tools or turns: the
// issue is the state, and the answer comes back in the pack's derived schema. Two transports reach
// the same model: the Vercel AI Gateway through the AI SDK's decision API (AI_GATEWAY_API_KEY,
// preferred when set) and TypeSafe's own SDK (TYPESAFE_API_KEY). Jev is opt-in and metered: with
// neither key the stage ends with a reason, not a crash. A call's cost is its tokens at the
// catalog's price.
import { type QuestionSet, type ResolvedEngine, lowestBar } from "@hardness/contracts";

import { decisionSummary, stateOf } from "../../core/decide.ts";
import { EMPTY_RUN, type RunOutcome } from "../../core/output.ts";
import { NO_TELEMETRY } from "../../core/telemetry.ts";
import { NO_INSTRUCTIONS, type RunContext, type Runtime, deadlineMs } from "../../core/runtime.ts";
import { gatewayTransport } from "./gateway.ts";
import { typesafeTransport } from "./typesafe.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What one call asks, in no transport's words. */
export interface JevCall {
  state: Record<string, Json>;
  questions: QuestionSet;
  engine: ResolvedEngine;
}

/** What one call answered: the answers already in the pack's words, not yet validated. */
export interface JevReply {
  model: string;
  answer: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** One way to Jev: the request it would send (what a dry run prints), the call, and its failure as the stage's. */
export interface JevTransport {
  via: "typesafe" | "gateway";
  request(call: JevCall): Promise<Record<string, unknown>>;
  decide(call: JevCall, signal: AbortSignal): Promise<JevReply>;
  failed(e: unknown): Pick<RunOutcome, "error" | "rateLimited" | "resetsAt">;
}

/** The credential decides: the Gateway when its key is set, else TypeSafe's API (which says so
 *  when its key is missing too). */
export function jevTransport(env: NodeJS.ProcessEnv = process.env): JevTransport {
  return env.AI_GATEWAY_API_KEY?.trim() ? gatewayTransport() : typesafeTransport();
}

/** The call's cost at the catalog's price; null without a price or a token count. */
export function costOf(pricing: ResolvedEngine["pricing"], inputTokens: number | null, outputTokens: number | null): number | null {
  if (!pricing || inputTokens === null) return null;
  // Rounded to 8 decimals, what pack_runs keeps: float noise (0.00003255000000000001) stops there.
  const usd = (inputTokens * pricing.inputPerMTokUsd + (outputTokens ?? 0) * (pricing.outputPerMTokUsd ?? 0)) / 1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

export function jevRuntime(transport: () => JevTransport = jevTransport): Runtime {
  return {
    id: "jev",
    // The SDK this run's transport loads, so the run record names the one that answered.
    get sdk() {
      return jevTransport().via === "gateway" ? "ai" : "@typesafe-ai/sdk";
    },
    // No role, rules or skills: the pack's questions are all it is told.
    instructions: () => NO_INSTRUCTIONS,
    async run({ pack, engine, input, dry, emit, telemetry }: RunContext): Promise<RunOutcome> {
      if (pack.kind !== "decision") return { ...EMPTY_RUN, error: `pack ${pack.id} is not a decision pack` };
      const t0 = Date.now();
      let via: JevTransport | null = null;
      try {
        via = transport();
        const call: JevCall = { state: stateOf(input), questions: pack.questions, engine };
        if (dry) {
          emit({ kind: "session", payload: { model: engine.modelId, text: JSON.stringify(await via.request(call), null, 2) } });
          let structured: Record<string, unknown> | null = null;
          try {
            structured = process.env.LUNA_STAGE_DRY_STRUCTURED ? (JSON.parse(process.env.LUNA_STAGE_DRY_STRUCTURED) as Record<string, unknown>) : null; // test seam
          } catch {}
          return { ...EMPTY_RUN, ok: true, structured, text: "dry-run" };
        }
        // Laminar's AI SDK integration, for the Gateway path (experimental_decide); TypeSafe's SDK has none.
        if (via.via === "gateway") {
          await (telemetry ?? NO_TELEMETRY).aiSdk(async (integration) => {
            const { registerTelemetry } = await import("ai");
            registerTelemetry(integration as Parameters<typeof registerTelemetry>[0]);
          });
        }
        const reply = await via.decide(call, AbortSignal.timeout(deadlineMs(input.limits.timeoutMs)));
        const durationMs = Date.now() - t0;
        const { model, inputTokens, outputTokens } = reply;
        const costUsd = costOf(engine.pricing, inputTokens, outputTokens);
        const cost = costUsd === null ? "" : ` · $${costUsd.toFixed(8)}`;
        emit({ kind: "session", payload: { model, text: `jev · model ${model} via ${via.via} · ${inputTokens ?? "?"} in · ${outputTokens ?? "?"} out${cost} · ${durationMs} ms` } });
        emit({ kind: "usage", payload: { model, ...(inputTokens != null && { inputTokens }), ...(outputTokens != null && { outputTokens }), ...(costUsd != null && { costUsd }) } });
        const run = { ...EMPTY_RUN, turns: 1, durationMs, model, costUsd };
        const parsed = pack.answer.safeParse(reply.answer);
        if (!parsed.success) {
          const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          return { ...run, error: `jev: the answer does not fit ${pack.id}: ${issues}` };
        }
        const answer = parsed.data as Record<string, unknown>;
        const text = decisionSummary(pack.questions, answer, lowestBar(pack.policy));
        emit({ kind: "text", payload: { text } });
        return { ...run, ok: true, structured: answer, text };
      } catch (e) {
        const reason = via ? via.failed(e) : { error: `jev: ${e instanceof Error ? e.message : String(e)}`, rateLimited: false, resetsAt: null };
        return { ...EMPTY_RUN, ...reason, durationMs: Date.now() - t0 };
      }
    },
  };
}

export const jev = jevRuntime();
