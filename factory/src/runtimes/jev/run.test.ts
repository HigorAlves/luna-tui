// The Jev runtime against a fake client: the issue goes as the state and the pack's questions in
// Jev's words; the answer comes back in the pack's schema with the model, tokens and duration;
// a rate limit, an unreachable API and a missing key each end the stage with a reason.
import { PACKS, type StageInput, resolveEngine } from "@hardness/contracts";
import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LunaState } from "../../core/output.ts";
import type { RunContext } from "../../core/runtime.ts";
import { type JevClient, jevRuntime } from "./run.ts";

const issue = { title: "Board crashes on resize", description: "Resize the terminal and it panics.", labels: ["bug"], source: "jira:HAR-12" };

const input = (context: Partial<StageInput["context"]> = { issue }): StageInput => ({
  schema: 3,
  stage: "issue_classify",
  pack: "issue_classify",
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
  const state: LunaState = { ledger: { schema: 1, slices: [] }, events: [] };
  const ctx: RunContext = {
    pack: PACKS.issue_classify,
    engine: resolveEngine("jev"),
    input: input(),
    prompt: "",
    paths: { factoryRoot: "/factory", work: "/work", out: "/out", input: "/in", scratch: "/tmp/luna-scratch" },
    luna: { state, server: null, call: async () => null },
    dry: false,
    out: (line) => lines.push(line),
    ...over,
  };
  return { ctx, lines, state };
}

const answers = {
  kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: {} },
  area: { type: "choice", choice: "board", confidence: 0.62, probabilities: {} },
  ready: { type: "noul", noul: 0.83 },
  size: { type: "score", score: 1.4, confidence: 0.75, legend: {}, probabilities: {} },
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
    await jevRuntime(() => client).run(ctx);
    const [request, options] = systemOne.mock.calls[0] as unknown as [Record<string, any>, { signal?: AbortSignal }];
    expect(request.state).toEqual(issue);
    expect(request.model).toBe(resolveEngine("jev").modelId);
    expect(request.questions.ready).toEqual({ type: "noul", instructions: expect.stringMatching(/acceptance criteria/) });
    expect(Object.keys(request.questions)).toEqual(["kind", "area", "ready", "size"]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the task's title and description when the input carries no issue", async () => {
    const { client, systemOne } = fake();
    await jevRuntime(() => client).run(context({ input: input({}) }).ctx);
    expect((systemOne.mock.calls[0] as unknown as [{ state: unknown }])[0].state).toEqual({ title: "From the task", description: "Task text" });
  });

  it("answers in the pack's schema, with the model, one turn, the duration and the tokens; no cost without a rate", async () => {
    const { client } = fake();
    const { ctx, lines, state } = context();
    const run = await jevRuntime(() => client).run(ctx);
    expect(run).toMatchObject({ ok: true, error: null, turns: 1, costUsd: null, model: "jev-2026-10", rateLimited: false });
    expect(run.structured).toEqual({ kind: { choice: "bug", confidence: 0.91 }, area: { choice: "board", confidence: 0.62 }, ready: { value: true, p: 0.83 }, size: { score: 1.4, confidence: 0.75 } });
    expect(PACKS.issue_classify.answer.safeParse(run.structured).success).toBe(true);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.text).toBe("kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · below 0.7: area");
    expect(state.events).toContainEqual({ kind: "note", payload: { phase: "usage", model: "jev-2026-10", inputTokens: 412, outputTokens: 9 } });
    expect(lines.join("\n")).toContain("412 in · 9 out");
  });

  it("fails the stage when an answer does not fit the pack", async () => {
    const { client } = fake({ model: "m", answers: { ...answers, kind: { type: "choice", choice: "epic", confidence: 0.9, probabilities: {} } }, usage: { input_tokens: null, output_tokens: null } });
    const run = await jevRuntime(() => client).run(context().ctx);
    expect(run).toMatchObject({ ok: false, structured: null });
    expect(run.error).toMatch(/kind/);
  });

  it("marks a 429 rate limited, with when to retry", async () => {
    const limited = APIError.fromResponse(429, { error: "slow down" }, new Headers({ "retry-after": "30" }));
    const { client } = fake(limited);
    const before = Math.floor(Date.now() / 1000);
    const run = await jevRuntime(() => client).run(context().ctx);
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
      const run = await jevRuntime(() => fake(error).client).run(context().ctx);
      expect(run).toMatchObject({ ok: false, rateLimited: false, structured: null });
      expect(run.error).toMatch(reason);
      expect(run.error).toMatch(/^jev: /);
    }
  });

  it("without TYPESAFE_API_KEY ends the stage with ok false and says why, never throws", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const run = await jevRuntime().run(context().ctx);
    expect(run).toMatchObject({ ok: false, structured: null });
    expect(run.error).toMatch(/TYPESAFE_API_KEY/);
  });

  it("dry: prints the questions and the state it would send, and calls nothing", async () => {
    const { client, systemOne } = fake();
    const { ctx, lines } = context({ dry: true });
    const run = await jevRuntime(() => client).run(ctx);
    expect(systemOne).not.toHaveBeenCalled();
    expect(run).toMatchObject({ ok: true, text: "dry-run" });
    const printed = JSON.parse(lines.join("\n").slice(lines.join("\n").indexOf("{")));
    expect(printed).toMatchObject({ model: resolveEngine("jev").modelId, state: issue, questions: { ready: { type: "noul" } } });
  });
});
