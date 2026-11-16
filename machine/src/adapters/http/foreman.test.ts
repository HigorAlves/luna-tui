import type { HostRunInput, PackRunsPort } from "../../application/pack-runs.ts";
import { RunFailedError } from "../../application/pack-runs.ts";
import { type RunResult } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("delete from tasks");
});

interface Call {
  input: HostRunInput;
  client: string | null;
}

function setup(first: Record<string, unknown> | Error) {
  let answer = first;
  const calls: Call[] = [];
  const runs: PackRunsPort = {
    run: async (input, client) => {
      calls.push({ input, client });
      if (answer instanceof Error) throw answer;
      return { answer, usage: { model: "m", engine: "claude:haiku", turns: 1, durationMs: 1, costUsd: 0 } } satisfies RunResult;
    },
  };
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
  const app = createApp({ db, pipeline, bus: new Bus(), runs });
  const ask = (body: unknown) => app.request("/foreman", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { calls, pipeline, app, ask, willAnswer: (next: Record<string, unknown>) => void (answer = next) };
}

describe("POST /foreman", () => {
  it("runs the foreman pack with the board and the question, as the board client, and answers its reply and actions", async () => {
    const { calls, pipeline, ask } = setup({ reply: "Start the draft.", actions: [] });
    const task = await pipeline.createTask({ title: "Export CSV" });
    const response = await ask({ question: "what needs me?", history: [{ who: "person", text: "hi" }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: "Start the draft.", actions: [], dropped: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.client).toBe("board");
    expect(calls[0]!.input.pack).toBe("foreman");
    const context = (calls[0]!.input.context as { foreman: { question: string; history: unknown[]; board: { cards: Array<{ id: string; title: string }> } } }).foreman;
    expect(context.question).toBe("what needs me?");
    expect(context.history).toEqual([{ who: "person", text: "hi" }]);
    expect(context.board.cards.map((c) => [c.id, c.title])).toEqual([[task.id, "Export CSV"]]);
  });

  it("passes the actions the board can take and drops the ones it cannot, each with its problem", async () => {
    const { pipeline, ask, willAnswer } = setup({});
    const task = await pipeline.createTask({ title: "Export CSV" });
    const good = { kind: "start", taskId: task.id, why: "a draft" };
    const noGate = { kind: "approve", taskId: task.id, why: "no gate" };
    const ghost = { kind: "abort", taskId: "nope", why: "unknown" };
    willAnswer({ reply: "Do both.", actions: [good, noGate, ghost] });
    const body = await (await ask({ question: "go" })).json();
    expect(body.reply).toBe("Do both.");
    expect(body.actions).toEqual([{ ...good, approvalId: null }]);
    expect(body.dropped).toEqual([
      { action: noGate, problem: `card ${task.id} has no gate to approve` },
      { action: ghost, problem: "card nope is not on the board" },
    ]);
  });

  it("rewrites an answer's question ids to the question texts the answers route keys by", async () => {
    const { pipeline, ask, calls, willAnswer } = setup({ reply: "", actions: [] });
    const task = await pipeline.createTask({ title: "Needs answers" });
    await db.query("update tasks set state = 'awaiting_answers' where id = $1", [task.id]);
    await db.query("insert into approvals (task_id, kind, requested) values ($1, 'awaiting_answers', $2)", [task.id, JSON.stringify({ questions: [{ question: "Which format?", recommended: "csv" }] })]);
    await ask({ question: "first" });
    const card = (calls[0]!.input.context as { foreman: { board: { cards: Array<{ questions: unknown[] }> } } }).foreman.board.cards[0]!;
    expect(card.questions).toEqual([{ id: "q1", question: "Which format?", recommended: "csv" }]);
    willAnswer({ reply: "Answered.", actions: [{ kind: "answer", taskId: task.id, why: "recommended", answers: { q1: "csv" } }] });
    const body = await (await ask({ question: "answer it" })).json();
    expect(body.dropped).toEqual([]);
    expect(body.actions).toEqual([{ kind: "answer", taskId: task.id, why: "recommended", answers: { "Which format?": "csv" }, approvalId: expect.any(String) }]);
  });

  it("stamps every action with the open approval id of the card it names, as the snapshot saw it", async () => {
    const { pipeline, ask, willAnswer } = setup({});
    const task = await pipeline.createTask({ title: "Needs answers" });
    await db.query("update tasks set state = 'awaiting_answers' where id = $1", [task.id]);
    const [row] = (await db.query("insert into approvals (task_id, kind, requested) values ($1, 'awaiting_answers', $2) returning id", [task.id, JSON.stringify({ questions: [{ question: "Which format?", recommended: "csv" }] })])) as { id: string }[];
    const plain = await pipeline.createTask({ title: "A draft" });
    willAnswer({ reply: "", actions: [{ kind: "answer", taskId: task.id, why: "w", answers: { q1: "csv" } }, { kind: "start", taskId: plain.id, why: "w" }] });
    const body = await (await ask({ question: "go" })).json();
    expect(body.actions.map((a: { taskId: string; approvalId: string | null }) => [a.taskId, a.approvalId])).toEqual([[task.id, row!.id], [plain.id, null]]);
  });

  it("rejects a body with no question, a long history or a bad turn", async () => {
    const { ask, calls } = setup({ reply: "", actions: [] });
    expect((await ask({})).status).toBe(400);
    expect((await ask({ question: "" })).status).toBe(400);
    expect((await ask({ question: "x", history: Array.from({ length: 11 }, () => ({ who: "person", text: "t" })) })).status).toBe(400);
    expect((await ask({ question: "x", history: [{ who: "robot", text: "t" }] })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 502 when the pack fails or gives an answer that is not a foreman answer", async () => {
    const failed = await setup(new RunFailedError("model gave no answer")).ask({ question: "x" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: "foreman_failed", message: "model gave no answer" });
    const odd = await setup({ reply: 1 }).ask({ question: "x" });
    expect(odd.status).toBe(502);
  });

  it("answers 503 when agents are off", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const app = createApp({ db, pipeline, bus: new Bus() });
    const response = await app.request("/foreman", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "x" }) });
    expect(response.status).toBe(503);
  });
});
