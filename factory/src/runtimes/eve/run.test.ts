// The eve runner's own pieces, without a server: what the server's environment holds, where the
// run's secrets go, and the luna bridge's token check.
import { PACKS } from "@hardness/contracts";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { settle } from "../../core/output.ts";
import { TurnFollower, serveLuna, serverEnv, stop, waitHealthy, writeSecrets } from "./run.ts";

const SOURCE = {
  PATH: "/usr/bin",
  HOME: "/tmp",
  CODEX_HOME: "/tmp/.codex",
  GH_TOKEN: "gh-secret",
  GITHUB_TOKEN: "gh-secret-2",
  OPENAI_API_KEY: "sk-secret",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  ANTHROPIC_API_KEY: "ak-secret",
  TYPESAFE_API_KEY: "ts-secret",
  SOME_SERVICE_TOKEN: "x-secret",
  GIT_CONFIG_KEY_0: "safe.directory",
};

describe("serverEnv", () => {
  it("passes the server no credential: they reach it through the secrets file", () => {
    const env = serverEnv(SOURCE, { LUNA_EVE_SECRETS: "/tmp/luna-eve-secrets-x/secrets.json" });
    for (const value of Object.values(env)) expect(value).not.toMatch(/^[a-z-]+-secret(-2)?$/);
    expect(env).toMatchObject({ PATH: "/usr/bin", CODEX_HOME: "/tmp/.codex", GIT_CONFIG_KEY_0: "safe.directory", LUNA_EVE_SECRETS: "/tmp/luna-eve-secrets-x/secrets.json" });
    expect(Object.keys(env).filter((k) => /PASSWORD|BRIDGE_TOKEN/.test(k))).toEqual([]);
  });
});

describe("writeSecrets", () => {
  it("writes the run's secrets to a file only its user can read, in a folder of its own", () => {
    const file = writeSecrets({ password: "pw", bridgeToken: "bt", ghToken: "gh" });
    try {
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ password: "pw", bridgeToken: "bt", ghToken: "gh" });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});

describe("serveLuna", () => {
  it("answers a call with the run's token and refuses any other", async () => {
    const token = "a".repeat(48);
    const bridge = await serveLuna(async (tool, args) => ({ tool, args }), token);
    try {
      const call = (authorization: string) => fetch(`${bridge.url}/step`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: '{"label":"x"}' });
      expect(await (await call(`Bearer ${token}`)).json()).toEqual({ tool: "step", args: { label: "x" } });
      expect((await call(`Bearer ${"b".repeat(48)}`)).status).toBe(403);
      expect((await call(`Bearer ${token.slice(1)}`)).status).toBe(403);
      expect((await call("")).status).toBe(403);
    } finally {
      bridge.server.close();
    }
  });
});

describe("stop", () => {
  // The reviewer's stop probe: a server killed by a signal (an OOM kill) has exitCode null after
  // its exit event, and stop() waited for an exit that had already happened.
  it("resolves for a server that already died by a signal", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((r) => child.once("spawn", r));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(child.exitCode).toBeNull();
    const started = Date.now();
    await stop(child);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops a running server", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((r) => child.once("spawn", r));
    await stop(child);
    expect(child.signalCode ?? child.exitCode).not.toBeNull();
  });
});

describe("waitHealthy", () => {
  it("gives up as soon as the server dies, not at the deadline", async () => {
    const child = spawn(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    const started = Date.now();
    await expect(waitHealthy(async () => ({ ok: false }), child, ["boom"])).rejects.toThrow(/never became healthy[\s\S]*boom/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("TurnFollower", () => {
  const PACK = PACKS.implementing;
  const requested = (n: number) => ({ type: "model.requested", data: { owner: { turnId: "turn_0" }, runId: `run_${n}` } });
  const settled = (n: number) => ({ type: "model.settled", data: { finishReason: "tool-calls", outcome: "completed", runId: `run_${n}` } });
  const follower = (maxTurns = 3) => new TurnFollower(PACK, maxTurns, () => {});

  it("cancels the turn when its last allowed model call settles without an answer, not a call later", () => {
    const turn = follower(3);
    const cancels = [1, 2, 3].flatMap((n) => [turn.take(requested(n)), turn.take(settled(n))]);
    expect(cancels).toEqual([false, false, false, false, false, true]);
    turn.take({ type: "turn.settled", data: { outcome: "cancelled" } });
    expect(turn.result).toMatchObject({ ok: false, turns: 3, error: expect.stringMatching(/no answer the implementing schema accepts within 3 model calls/) });
  });

  it("lets the last allowed call answer", () => {
    const turn = follower(2);
    turn.take(requested(1));
    turn.take(settled(1));
    turn.take(requested(2));
    turn.take({ type: "content.completed", data: { kind: "result", value: { kind: "done", summary: "x" } } });
    expect(turn.take(settled(2))).toBe(false);
    turn.take({ type: "turn.settled", data: { outcome: "completed" } });
    expect(turn.result).toMatchObject({ ok: true, structured: { kind: "done", summary: "x" }, turns: 2 });
  });

  it("reports a paused turn or eve's usage limit as the pack's own budget, never a rate limit", () => {
    const paused = follower();
    expect(paused.take({ type: "turn.paused", data: { awaiting: [{ interactionId: "i" }] } })).toBe(true);
    paused.take({ type: "turn.settled", data: { outcome: "cancelled" } });
    expect(settle(paused.result, PACK)).toMatchObject({ ok: false, rateLimited: false, error: expect.stringMatching(/own budget/) });

    const failed = follower();
    failed.take({ type: "turn.settled", data: { outcome: "failed", error: { code: "SESSION_USAGE_LIMIT_REACHED", message: "The session reached its usage limit." } } });
    expect(settle(failed.result, PACK)).toMatchObject({ ok: false, rateLimited: false, error: expect.stringMatching(/own budget/) });
  });

  it("marks a provider's 429 as a rate limit", () => {
    const turn = follower();
    turn.take({ type: "model.settled", data: { error: { code: "APICallError", message: "Rate limit reached for requests (429)" } } });
    turn.take({ type: "turn.settled", data: { outcome: "failed" } });
    expect(turn.result).toMatchObject({ ok: false, rateLimited: true });
  });

  it("takes an answer the model gave as text only when it parses against the schema", () => {
    const schemaMissed = { type: "turn.settled", data: { outcome: "failed", error: { code: "OUTPUT_SCHEMA_NOT_FULFILLED", message: "no reply" } } };
    const good = follower();
    good.take({ type: "content.completed", data: { kind: "text", phase: "reply", value: JSON.stringify({ kind: "done", summary: "x" }) } });
    good.take(schemaMissed);
    expect(good.result).toMatchObject({ ok: true, structured: { kind: "done", summary: "x" } });

    for (const text of ["{not json", '{"kind":"maybe"}', '{"kind":"done","summary":"x"} trailing']) {
      const bad = follower();
      bad.take({ type: "content.completed", data: { kind: "text", phase: "reply", value: text } });
      bad.take(schemaMissed);
      expect(bad.result).toMatchObject({ ok: false, structured: null, error: expect.stringMatching(/OUTPUT_SCHEMA_NOT_FULFILLED/) });
    }
  });
});
