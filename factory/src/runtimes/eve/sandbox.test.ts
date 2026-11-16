// The stage-local sandbox runs eve's own scripts (glob, grep, job bookkeeping) as children of the
// eve server. The server's environment holds the stage's credentials; no script may inherit one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connect } from "./sandbox.ts";

const CREDENTIALS = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  OPENAI_API_KEY: "openai-secret",
  CODEX_HOME: "/tmp/.codex",
  AI_GATEWAY_API_KEY: "gateway-secret",
  TYPESAFE_API_KEY: "typesafe-secret",
};

afterEach(() => vi.unstubAllEnvs());

describe("stage-local sandbox command env", () => {
  it("carries no credential variable, even when the server holds them all", async () => {
    for (const [name, value] of Object.entries(CREDENTIALS)) vi.stubEnv(name, value);
    const root = mkdtempSync(join(tmpdir(), "luna-sandbox-"));
    const child = await connect(root).spawn({ command: "env", env: {}, workingDirectory: root, signal: new AbortController().signal });
    const out = await new Response(child.stdout).text();
    await child.wait();
    const names = out.split("\n").map((line) => line.split("=")[0]);
    for (const name of Object.keys(CREDENTIALS)) expect(names).not.toContain(name);
    for (const value of Object.values(CREDENTIALS)) expect(out).not.toContain(value);
    // The probe ran: the explicit env is there.
    expect(names).toContain("PATH");
  });
});
