import { describe, expect, it } from "vitest";

import { envBrokenDetail } from "../../application/env-broken.ts";
import type { ExecResult } from "../process/exec.ts";
import { RuntimeUnavailableError, assertRuntime, runtimeChecker } from "./runtimes.ts";

const info = (stdout: string, code = 0) => async (): Promise<ExecResult> => ({ code, stdout, stderr: code ? "daemon down" : "" });
/** What the daemon answers: its runtimes and its operating system, as one JSON object. */
const answer = (runtimes: object, os = "Ubuntu 24.04.1 LTS") => JSON.stringify({ runtimes, os });

describe("assertRuntime", () => {
  it("asks the daemon for its runtimes", async () => {
    const seen: string[][] = [];
    await assertRuntime(async (_c, args) => (seen.push(args), { code: 0, stdout: answer({ runc: {}, runsc: {} }), stderr: "" }), "runsc");
    expect(seen).toEqual([["info", "--format", '{"runtimes":{{json .Runtimes}},"os":{{json .OperatingSystem}}}']]);
  });

  it("passes a daemon that has the runtime, and asks nothing for runc", async () => {
    await expect(assertRuntime(info(answer({ runc: {}, runsc: { path: "/usr/bin/runsc" } })), "runsc")).resolves.toBeUndefined();
    await expect(assertRuntime(info("", 1), "runc")).resolves.toBeUndefined();
  });

  it("refuses a daemon without it, naming the runtime", async () => {
    await expect(assertRuntime(info(answer({ runc: {} })), "runsc")).rejects.toThrow(/runsc/);
    await expect(assertRuntime(info(answer({ runc: {} })), "runsc")).rejects.toThrow(RuntimeUnavailableError);
  });

  it("refuses gVisor on Docker Desktop, where it shows the files shared from the host as root's and a stage could not read its worktree", async () => {
    const desktop = info(answer({ runc: {}, runsc: { path: "/usr/local/bin/runsc" } }, "Docker Desktop"));
    await expect(assertRuntime(desktop, "runsc")).rejects.toThrow(RuntimeUnavailableError);
    await expect(assertRuntime(desktop, "runsc")).rejects.toThrow(/Docker Desktop.*native Linux/);
  });

  it("refuses when the daemon cannot be asked or answers nonsense", async () => {
    await expect(assertRuntime(info("", 1), "runsc")).rejects.toThrow(RuntimeUnavailableError);
    await expect(assertRuntime(info("nope"), "runsc")).rejects.toThrow(RuntimeUnavailableError);
  });

  it("is an env_broken escalation naming the step", () => {
    expect(envBrokenDetail(new RuntimeUnavailableError("no runsc"))).toMatchObject({ escalation: "env_broken", envBroken: true, step: "runtime", reason: expect.stringContaining("no runsc") });
  });
});

describe("runtimeChecker", () => {
  it("asks once per runtime, remembering only a pass", async () => {
    let asked = 0;
    const check = runtimeChecker(async () => (asked++, { code: 0, stdout: answer({ runsc: {} }), stderr: "" }));
    await check("runsc");
    await check("runsc");
    expect(asked).toBe(1);
    let fail = true;
    const flaky = runtimeChecker(async () => (fail ? { code: 0, stdout: "{}", stderr: "" } : { code: 0, stdout: answer({ runsc: {} }), stderr: "" }));
    await expect(flaky("runsc")).rejects.toThrow();
    fail = false;
    await expect(flaky("runsc")).resolves.toBeUndefined();
  });
});
