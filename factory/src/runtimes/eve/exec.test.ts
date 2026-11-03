import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { STAGE_PATH, commandEnv, runArgv } from "./exec.ts";

const SECRETS = {
  LUNA_EVE_PASSWORD: "pw",
  LUNA_EVE_BRIDGE_TOKEN: "bt",
  GH_TOKEN: "gh-secret",
  GITHUB_TOKEN: "gh-secret-2",
  OPENAI_API_KEY: "sk-x",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  ANTHROPIC_API_KEY: "ak",
  TYPESAFE_API_KEY: "ts",
  CODEX_HOME: "/tmp/.codex",
  LUNA_EVE_GUARD: "{}",
};

describe("commandEnv", () => {
  const source = { ...SECRETS, PATH: "/usr/bin", HOME: "/tmp", LANG: "C.UTF-8", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", GOTOOLCHAIN: "local", LUNA_FACTORY: "1" };

  it("is an explicit list: no credential, no runner variable, nothing a login shell would source", () => {
    const env = commandEnv("cat", { source, home: "/tmp/scratch" });
    for (const key of Object.keys(SECRETS)) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ LANG: "C.UTF-8", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", GOTOOLCHAIN: "local", LUNA_FACTORY: "1", HOME: "/tmp/scratch", TMPDIR: "/tmp/scratch" });
  });

  it("gives the stage's toolchains on PATH, whatever the server's PATH was", () => {
    expect(commandEnv("go", { source, home: "/tmp/s" }).PATH).toBe(STAGE_PATH);
    expect(STAGE_PATH.split(":")).toEqual(expect.arrayContaining(["/usr/local/go/bin", "/usr/local/cargo/bin", "/usr/local/bin", "/usr/bin", "/bin"]));
  });

  it("hands the GitHub token to gh alone", () => {
    expect(commandEnv("gh", { source, home: "/tmp/s", ghToken: "gh-secret" })).toMatchObject({ GH_TOKEN: "gh-secret" });
    expect(commandEnv("git", { source, home: "/tmp/s", ghToken: "gh-secret" })).not.toHaveProperty("GH_TOKEN");
  });
});

describe("runArgv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "eve-exec-"));
  const env = { PATH: STAGE_PATH + ":" + (process.env.PATH ?? ""), HOME: cwd };

  it("runs argv as one process: what a shell would expand is passed as text", async () => {
    const result = await runArgv(["echo", "$(id)", "`id`", "*", "a b"], { cwd, env });
    expect(result).toEqual({ exitCode: 0, stdout: "$(id) `id` * a b\n", stderr: "", truncated: false });
  });

  it("never sources a profile", async () => {
    writeFileSync(join(cwd, ".bash_profile"), "echo PROFILE\n");
    writeFileSync(join(cwd, ".bashrc"), "echo RC\n");
    expect((await runArgv(["pwd"], { cwd, env })).stdout).not.toMatch(/PROFILE|RC/);
  });

  it("reports the exit code and stderr of a failing command", async () => {
    const result = await runArgv(["ls", "no-such-file"], { cwd, env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no-such-file/);
  });

  it("reports a command that does not exist as exit 127", async () => {
    expect(await runArgv(["no-such-command-xyz"], { cwd, env })).toMatchObject({ exitCode: 127, stderr: expect.stringMatching(/not found/) });
  });

  it("keeps the tail of a long output", async () => {
    const result = await runArgv([process.execPath, "-e", "process.stdout.write('x'.repeat(200000) + 'END')"], { cwd, env });
    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stdout.length).toBeLessThan(60_000);
  });

  it("stops the command when the call is aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runArgv(["sleep", "30"], { cwd, env, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
