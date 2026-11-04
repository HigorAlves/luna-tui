// The Jev runtime against a fake client on each transport: the issue goes as the state and the
// pack's questions in the transport's words; the answer comes back in the pack's schema with the
// model, tokens, cost and duration; a rate limit, an unreachable API and a missing key each end
// the stage with a reason; the Gateway's key, when set, picks the Gateway.
import { PACKS, type StageInput, resolveEngine } from "@hardness/contracts";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunEvent } from "@hardness/contracts";

import type { RunContext } from "../../core/runtime.ts";
import { transcript } from "../../core/transcript.ts";
import { type Decide, gatewayTransport } from "./gateway.ts";
import { costOf, jevRuntime, jevTransport } from "./run.ts";
import { type JevClient, typesafeTransport } from "./typesafe.ts";

const issue = { title: "Board crashes on resize", description: "Resize the terminal and it panics.", labels: ["bug"], source: "jira:HAR-12" };

const input = (context: Partial<StageInput["context"]> = { issue }): StageInput => ({
  schema: 3,
  stage: "triage_signals",
  pack: "triage_signals",
  attempt: 1,
  task: { id: "t1", title: "From the task", description: "Task text", criteria: [], repoPath: "", branch: "", source: null },
  plan: null,
  decisions: [],
  priorFindings: [],
  context: { projectContext: null, ...context },
  limits: { maxTurns: 1, timeoutMs: 60_000 },
  env: {},
});

function context(over: Partial<RunContext> = {}) {
  const lines: string[] = [];
  const events: RunEvent[] = [];
  const print = transcript((line) => lines.push(line));
  const ctx: RunContext = {
    pack: PACKS.triage_signals,
    engine: resolveEngine("jev"),
    input: input(),
    prompt: "",
    paths: { factoryRoot: "/factory", work: "/work", out: "/out", input: "/in", scratch: "/tmp/luna-scratch" },
    luna: { call: async () => null },
    dry: false,
    emit: (event) => {
      events.push(event);
      print(event);
    },
    ...over,
  };
  return { ctx, lines, events };
}

const answers = {
  kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: {} },
  area: { type: "choice", choice: "board", confidence: 0.62, probabilities: {} },
  ready: { type: "noul", noul: 0.83 },
  size: { type: "score", score: 1.4, confidence: 0.75, legend: {}, probabilities: {} },
  urgency: { type: "score", score: 1, confidence: 0.7, legend: {}, probabilities: {} },
  risk: { type: "score", score: 0.5, confidence: 0.8, legend: {}, probabilities: {} },
  archive: { type: "noul", noul: 0.05 },
  archive_reason: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
};

function fake(result: unknown = { model: "jev-2026-10", answers, usage: { input_tokens: 412, output_tokens: 9 } }) {
  const systemOne = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { systemOne } as unknown as JevClient, systemOne };
}

afterEach(() => vi.unstubAllEnvs());

describe("the Jev runtime", () => {
  it("sends the issue as the state and the questions in Jev's words, on the engine's pinned model", async () => {
    const { client, systemOne } = fake();
    const { ctx } = context();
    await jevRuntime(() => typesafeTransport(() => client)).run(ctx);
    const [request, options] = systemOne.mock.calls[0] as unknown as [Record<string, any>, { signal?: AbortSignal }];
    expect(request.state).toEqual(issue);
    expect(request.model).toBe(resolveEngine("jev").modelId);
    expect(request.questions.ready).toEqual({ type: "noul", instructions: expect.stringMatching(/acceptance criteria/) });
    expect(Object.keys(request.questions)).toEqual(["kind", "area", "ready", "size", "urgency", "risk", "archive", "archive_reason"]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the task's title and description when the input carries no issue", async () => {
    const { client, systemOne } = fake();
    await jevRuntime(() => typesafeTransport(() => client)).run(context({ input: input({}) }).ctx);
    expect((systemOne.mock.calls[0] as unknown as [{ state: unknown }])[0].state).toEqual({ title: "From the task", description: "Task text" });
  });

  it("answers in the pack's schema, with the model, one turn, the duration, the tokens and their cost at the catalog's price", async () => {
    const { client } = fake();
    const { ctx, lines, events } = context();
    const run = await jevRuntime(() => typesafeTransport(() => client)).run(ctx);
    expect(run).toMatchObject({ ok: true, error: null, turns: 1, model: "jev-2026-10", rateLimited: false });
    expect(run.costUsd).toBeCloseTo((412 * 0.042) / 1_000_000, 8);
    expect(run.structured).toEqual({ kind: { choice: "bug", confidence: 0.91 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.75 }, urgency: { score: 1, confidence: 0.7 }, risk: { score: 0.5, confidence: 0.8 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.9 } });
    expect(PACKS.triage_signals.answer.safeParse(run.structured).success).toBe(true);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.text).toBe("kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · urgency 1 (0.70) · risk 0.5 (0.80) · archive no (p 0.05) · archive_reason none (0.90) · below 0.7: area");
    expect(events).toContainEqual({ kind: "usage", payload: { model: "jev-2026-10", inputTokens: 412, outputTokens: 9, costUsd: 0.0000173 } });
    expect(lines.join("\n")).toContain("412 in · 9 out");
  });

  it("fails the stage when an answer does not fit the pack", async () => {
    const { client } = fake({ model: "m", answers: { ...answers, kind: { type: "choice", choice: "epic", confidence: 0.9, probabilities: {} } }, usage: { input_tokens: null, output_tokens: null } });
    const run = await jevRuntime(() => typesafeTransport(() => client)).run(context().ctx);
    expect(run).toMatchObject({ ok: false, structured: null });
    expect(run.error).toMatch(/kind/);
  });

  it("marks a 429 rate limited, with when to retry", async () => {
    const limited = APIError.fromResponse(429, { error: "slow down" }, new Headers({ "retry-after": "30" }));
    const { client } = fake(limited);
    const before = Math.floor(Date.now() / 1000);
    const run = await jevRuntime(() => typesafeTransport(() => client)).run(context().ctx);
    expect(run).toMatchObject({ ok: false, rateLimited: true });
    expect(run.resetsAt).toBeGreaterThanOrEqual(before + 30);
    expect(run.error).toMatch(/429/);
  });

  it("ends the stage with the reason when the API errs, cannot be reached, times out or outlasts the stage", async () => {
    for (const [error, reason] of [
      [APIError.fromResponse(500, { error: "boom" }, new Headers()), /500/],
      [new APIConnectionError("getaddrinfo ENOTFOUND api.typesafe.ai"), /ENOTFOUND/],
      [new APITimeoutError(10_000), /10000|timed out/i],
      [new APIUserAbortError(), /time ran out/],
    ] as const) {
      const run = await jevRuntime(() => typesafeTransport(() => fake(error).client)).run(context().ctx);
      expect(run).toMatchObject({ ok: false, rateLimited: false, structured: null });
      expect(run.error).toMatch(reason);
      expect(run.error).toMatch(/^jev: /);
    }
  });

  it("without either key ends the stage with ok false and names both, never throws", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const run = await jevRuntime().run(context().ctx);
    expect(run).toMatchObject({ ok: false, structured: null, costUsd: null });
    expect(run.error).toMatch(/AI_GATEWAY_API_KEY nor TYPESAFE_API_KEY/);
  });

  it("goes through the Gateway when its key is set, through TypeSafe's API otherwise", () => {
    expect(jevTransport({ AI_GATEWAY_API_KEY: "gw", TYPESAFE_API_KEY: "ts" }).via).toBe("gateway");
    expect(jevTransport({ AI_GATEWAY_API_KEY: " ", TYPESAFE_API_KEY: "ts" }).via).toBe("typesafe");
    expect(jevTransport({}).via).toBe("typesafe");
  });

  it("ends the stage with the reason when the questions cannot be put in Jev's words, never throws", async () => {
    const { client } = fake();
    const pack = { ...PACKS.triage_signals, questions: { kind: { type: "choice", instructions: "x", criteria: [] } } } as unknown as RunContext["pack"];
    const run = await jevRuntime(() => typesafeTransport(() => client)).run(context({ pack }).ctx);
    expect(run).toMatchObject({ ok: false, structured: null, error: expect.stringMatching(/^jev: .*criteria/) });
  });

  it("dry: prints the questions and the state it would send, and calls nothing", async () => {
    const { client, systemOne } = fake();
    const { ctx, lines } = context({ dry: true });
    const run = await jevRuntime(() => typesafeTransport(() => client)).run(ctx);
    expect(systemOne).not.toHaveBeenCalled();
    expect(run).toMatchObject({ ok: true, text: "dry-run" });
    const printed = JSON.parse(lines.join("\n").slice(lines.join("\n").indexOf("{")));
    expect(printed).toMatchObject({ model: resolveEngine("jev").modelId, state: issue, questions: { ready: { type: "noul" } } });
  });
});

const decided = {
  kind: { type: "choice", choice: "bug", probabilities: { bug: 0.91, feature: 0.05, chore: 0.03, question: 0.01 } },
  area: { type: "choice", choice: "board", probabilities: { board: 0.62, machine: 0.38 } },
  ready: { type: "boolean", probability: 0.83 },
  size: { type: "score", score: 1.4, probabilities: { 0: 0.05, 1: 0.5, 2: 0.4, 3: 0.05 } },
  urgency: { type: "score", score: 1, probabilities: { 1: 1 } },
  risk: { type: "score", score: 0.5, probabilities: { 0: 0.5, 1: 0.5 } },
  archive: { type: "boolean", probability: 0.05 },
  archive_reason: { type: "choice", choice: "none", probabilities: { none: 0.9, stale: 0.1 } },
};

function fakeDecide(result: unknown = { answers: decided, usage: { inputTokens: 380, outputTokens: 0 }, response: { modelId: "typesafe-ai/jev-1.14.0" }, providerMetadata: { typesafe: { confidence: { kind: 0.93 } } } }) {
  const decide = vi.fn(async (_call: Parameters<Decide>[0]) => {
    if (result instanceof Error) throw result;
    return result as Awaited<ReturnType<Decide>>;
  });
  return { transport: gatewayTransport(decide), decide };
}

/** An error as the Gateway provider throws one: a status, and the API call error under it. */
const gatewayError = (statusCode: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { name: "GatewayRateLimitError", statusCode, cause: { responseHeaders: headers } });

describe("the Jev runtime on the Vercel AI Gateway", () => {
  it("sends the issue as the state and the questions in the decision API's words, on the catalog's Gateway ID", async () => {
    const { transport, decide } = fakeDecide();
    await jevRuntime(() => transport).run(context().ctx);
    const call = decide.mock.calls[0]![0];
    expect(call.model).toBe("typesafe-ai/jev");
    expect(call.state).toEqual(issue);
    expect(call.questions.ready).toEqual({ type: "boolean", instructions: expect.stringMatching(/acceptance criteria/) });
    expect(call.questions.size).toMatchObject({ type: "score", criteria: [expect.stringMatching(/^tiny: /), expect.anything(), expect.anything(), expect.stringMatching(/^large: /)] });
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("answers in the pack's schema, as TypeSafe's answers do (its reported confidence first), with the tokens and their cost", async () => {
    const { transport } = fakeDecide();
    const { ctx, lines } = context();
    const run = await jevRuntime(() => transport).run(ctx);
    expect(run).toMatchObject({ ok: true, turns: 1, model: "typesafe-ai/jev-1.14.0" });
    expect(run.structured).toEqual({ kind: { choice: "bug", confidence: 0.93 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.5 }, urgency: { score: 1, confidence: 1 }, risk: { score: 0.5, confidence: 0.5 }, archive: { value: false, p: 0.05 }, archive_reason: { choice: "none", confidence: 0.9 } });
    expect(run.costUsd).toBeCloseTo((380 * 0.042) / 1_000_000, 12);
    expect(lines.join("\n")).toContain("via gateway · 380 in · 0 out");
  });

  it("marks a 429 rate limited with when to retry, under the AI SDK's retries too", async () => {
    const limited = gatewayError(429, "Rate limit exceeded", { "retry-after": "30" });
    const before = Math.floor(Date.now() / 1000);
    for (const thrown of [limited, Object.assign(new Error("Failed after 3 attempts"), { name: "AI_RetryError", lastError: limited })]) {
      const run = await jevRuntime(() => fakeDecide(thrown).transport).run(context().ctx);
      expect(run).toMatchObject({ ok: false, rateLimited: true, error: expect.stringMatching(/^jev: HTTP 429/) });
      expect(run.resetsAt).toBeGreaterThanOrEqual(before + 30);
    }
  });

  it("ends the stage with the reason on a refused key, a server error, a deadline or a refusal", async () => {
    for (const [error, reason] of [
      [gatewayError(401, "Invalid API key"), /HTTP 401: Invalid API key/],
      [gatewayError(500, "boom"), /HTTP 500/],
      [Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), /time ran out/],
      [new Error("The model refused to answer: kind"), /refused/],
    ] as const) {
      const run = await jevRuntime(() => fakeDecide(error).transport).run(context().ctx);
      expect(run).toMatchObject({ ok: false, rateLimited: false, resetsAt: null, structured: null });
      expect(run.error).toMatch(reason);
      expect(run.error).toMatch(/^jev: /);
    }
  });

  it("dry: prints the Gateway request it would send, and calls nothing", async () => {
    const { transport, decide } = fakeDecide();
    const { ctx, lines } = context({ dry: true });
    await jevRuntime(() => transport).run(ctx);
    expect(decide).not.toHaveBeenCalled();
    const printed = JSON.parse(lines.join("\n").slice(lines.join("\n").indexOf("{")));
    expect(printed).toMatchObject({ model: "typesafe-ai/jev", state: issue, questions: { ready: { type: "boolean" } } });
  });
});

describe("costOf", () => {
  it("prices the input tokens at the catalog's rate, rounded to 8 decimals as pack_runs keeps it", () => {
    const pricing = resolveEngine("jev").pricing;
    expect(costOf(pricing, 775, 125)).toBe(0.00003255);
    expect(costOf(pricing, null, 125)).toBeNull();
    expect(costOf(undefined, 775, 0)).toBeNull();
  });
});
