import type { HostRunInput, PackRunsPort, RunOptions } from "../../application/pack-runs.ts";
import { EngineNotAllowedError, RunFailedError } from "../../application/pack-runs.ts";
import { type RunResult } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

interface Call {
  input: HostRunInput;
  client: string | null;
  options: RunOptions | undefined;
}

const REPO = "/work/projects/luna-tui";
const READY = { reply: "Here is the ticket.", choices: [], notes: "touches board/src/app.rs", draft: { title: "Plan a ticket", description: "d", criteria: ["a"] }, ready: true };

function setup(first: Record<string, unknown> | Error, opts: { repos?: string[]; agents?: boolean } = {}) {
  const calls: Call[] = [];
  const runs: PackRunsPort = {
    run: async (input, client, _signal, options) => {
      calls.push({ input, client, options });
      if (first instanceof Error) throw first;
      return { answer: first, usage: { model: "m", engine: "claude:opus", turns: 1, durationMs: 1, costUsd: 0 } } satisfies RunResult;
    },
  };
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
  const app = createApp({ db, pipeline, bus: new Bus(), knownRepos: async () => opts.repos ?? [REPO], ...(opts.agents === false ? {} : { runs }) });
  const ask = (body: unknown) => app.request("/ticket-chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { calls, ask };
}

describe("POST /ticket-chat", () => {
  it("answers 404 unknown_repo for a repo the machine does not know", async () => {
    const { ask, calls } = setup(READY);
    const response = await ask({ repo: "/somewhere/else", message: "hi" });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown_repo");
    expect(calls).toHaveLength(0);
  });

  it("refuses a relative repo path", async () => {
    const { ask } = setup(READY);
    expect((await ask({ repo: "luna-tui", message: "hi" })).status).toBe(400);
  });

  it("answers 503 agents_off when the machine runs no packs", async () => {
    const { ask } = setup(READY, { agents: false });
    const response = await ask({ repo: REPO, message: "hi" });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("agents_off");
  });

  it("answers 400 when the pack does not allow the engine", async () => {
    const { ask } = setup(new EngineNotAllowedError("ticket_chat does not run on claude:haiku"));
    const response = await ask({ repo: REPO, message: "hi", engine: "claude:haiku" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("engine_not_allowed");
  });

  it("runs the pack on the repo, read-only, as the board client, and answers the planner's answer", async () => {
    const { ask, calls } = setup(READY);
    const history = [{ who: "person", text: "a" }];
    const response = await ask({ repo: `${REPO}/../luna-tui`, engine: "codex:sol", message: "plan it", history, notes: "n", draft: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(READY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.client).toBe("board");
    expect(calls[0]!.options).toEqual({ readRepo: REPO });
    expect(calls[0]!.input).toEqual({ pack: "ticket_chat", engine: "codex:sol", context: { ticketChat: { repo: { name: "luna-tui", path: REPO }, message: "plan it", history, notes: "n", draft: null } } });
  });

  it("defaults history, notes and draft, and leaves the engine to the pack", async () => {
    const { ask, calls } = setup(READY);
    await ask({ repo: REPO, message: "plan it" });
    expect(calls[0]!.input).toEqual({ pack: "ticket_chat", context: { ticketChat: { repo: { name: "luna-tui", path: REPO }, message: "plan it", history: [], notes: "", draft: null } } });
  });

  it("answers 502 ticket_chat_failed when the run fails", async () => {
    const { ask } = setup(new RunFailedError("boom"));
    const response = await ask({ repo: REPO, message: "hi" });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("ticket_chat_failed");
  });

  it("answers 502 ticket_chat_failed when the answer is not valid", async () => {
    const { ask } = setup({ reply: "x" });
    const response = await ask({ repo: REPO, message: "hi" });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("ticket_chat_failed");
  });

  it("gives POST /runs no way to mount a repo: a readRepo in the body never reaches the runs", async () => {
    const calls: Array<RunOptions | undefined> = [];
    const runs: PackRunsPort = { run: async (_input, _client, _signal, options) => (calls.push(options), { answer: {}, usage: { model: "m", engine: "claude:haiku", turns: 1, durationMs: 1, costUsd: 0 } }) };
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const app = createApp({ db, pipeline, bus: new Bus(), runs });
    await app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "ticket_chat", readRepo: "/etc", context: {} }) });
    await app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pack: "foreman", readRepo: "/etc", context: {}, options: { readRepo: "/etc" } }) });
    expect(calls.every((options) => options === undefined)).toBe(true);
  });
});
