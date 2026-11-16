import { describe, expect, it } from "vitest";

import { envBrokenDetail } from "../../application/env-broken.ts";
import type { ExecResult } from "../process/exec.ts";
import { SeccompUnavailableError, assertSeccomp } from "./seccomp.ts";

const info = (stdout: string, code = 0) => async (): Promise<ExecResult> => ({ code, stdout, stderr: code ? "daemon down" : "" });

describe("assertSeccomp", () => {
  it("asks the daemon for its security options", async () => {
    const seen: string[][] = [];
    await assertSeccomp(async (_c, args) => (seen.push(args), { code: 0, stdout: '["name=seccomp,profile=builtin"]', stderr: "" }));
    expect(seen).toEqual([["info", "--format", "{{json .SecurityOptions}}"]]);
  });

  it("passes a daemon with the builtin or a custom profile", async () => {
    await expect(assertSeccomp(info('["name=seccomp,profile=builtin","name=cgroupns"]'))).resolves.toBeUndefined();
    await expect(assertSeccomp(info('["name=seccomp,profile=/etc/docker/profile.json"]'))).resolves.toBeUndefined();
  });

  it("refuses a daemon with no seccomp entry", async () => {
    await expect(assertSeccomp(info('["name=apparmor","name=cgroupns"]'))).rejects.toThrow(SeccompUnavailableError);
  });

  it("refuses an unconfined default profile", async () => {
    await expect(assertSeccomp(info('["name=seccomp,profile=unconfined"]'))).rejects.toThrow(/unconfined/);
  });

  it("refuses when the daemon cannot be asked or answers nonsense", async () => {
    await expect(assertSeccomp(info("", 1))).rejects.toThrow(SeccompUnavailableError);
    await expect(assertSeccomp(info("not json"))).rejects.toThrow(SeccompUnavailableError);
  });

  it("is an env_broken escalation naming the step", () => {
    expect(envBrokenDetail(new SeccompUnavailableError("no filter"))).toMatchObject({ escalation: "env_broken", envBroken: true, step: "seccomp", reason: expect.stringContaining("no filter") });
  });
});
