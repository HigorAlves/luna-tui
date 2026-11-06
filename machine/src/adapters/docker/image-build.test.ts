import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ExecResult } from "../process/exec.ts";
import { dockerfileFor, dockerImages } from "./image-build.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const digest = `sha256:${"a".repeat(64)}`;

describe("the Dockerfile generated for a repository", () => {
  it("is the base, the machine's layer copied from the machine's image, and the entrypoint: nothing from the repository but the base", () => {
    const text = dockerfileFor("python:3.13-slim", "hardness-runner:dev");
    expect(text).toContain("FROM python:3.13-slim\n");
    expect(text).toContain("COPY --from=hardness-runner:dev /opt/luna /opt/luna");
    expect(text).toContain('ENTRYPOINT ["/opt/luna/bin/luna-stage"]');
    expect(text).not.toMatch(/ARG|ADD |--mount|secret/);
  });
});

describe("docker for a repository's image", () => {
  it("checks a base: pull, platform, a glibc loader; refuses musl and another architecture", async () => {
    const run = async (_c: string, a: string[]): Promise<ExecResult> => {
      if (a[0] === "pull") return ok();
      if (a[0] === "image") return ok(`${digest}|linux|${process.arch === "arm64" ? "arm64" : "amd64"}\n`);
      return ok("/lib/ld-linux-aarch64.so.1\n/usr/bin/git\n");
    };
    expect(await dockerImages({ exec: run }).checkBase("debian:12")).toEqual({ ok: true, digest });
    const musl = async (_c: string, a: string[]): Promise<ExecResult> => (a[0] === "run" ? ok("\n/usr/bin/git\n") : run(_c, a));
    expect(await dockerImages({ exec: musl }).checkBase("alpine:3")).toMatchObject({ ok: false, reason: expect.stringMatching(/glibc/) });
    const wrongArch = async (_c: string, a: string[]): Promise<ExecResult> => (a[0] === "image" ? ok(`${digest}|linux|riscv64\n`) : run(_c, a));
    expect(await dockerImages({ exec: wrongArch }).checkBase("x:1")).toMatchObject({ ok: false, reason: expect.stringMatching(/architecture/) });
  });

  it("builds with argv only: an empty context, no network, no build argument, no secret, a time limit", async () => {
    const seen: { command: string; args: string[]; timeoutMs?: number; dockerfile: string }[] = [];
    const run = async (command: string, args: string[], o: { timeoutMs?: number } = {}): Promise<ExecResult> => {
      const f = args[args.indexOf("-f") + 1]!;
      seen.push({ command, args, timeoutMs: o.timeoutMs, dockerfile: readFileSync(f, "utf8") });
      return ok();
    };
    const res = await dockerImages({ exec: run }).build({ tag: "hardness-runner-x:1", base: "debian:12", machineImage: "hardness-runner:dev", layerKey: "k1", baseDigest: digest });
    expect(res).toEqual({ ok: true });
    const call = seen[0]!;
    expect(call.command).toBe("docker");
    expect(call.args.slice(0, 2)).toEqual(["build", "--network"]);
    expect(call.args).toContain("none");
    expect(call.args.some((a) => /build-arg|secret|ssh|--add-host|--allow/.test(a))).toBe(false);
    expect(call.args).toContain("hardness-runner-x:1");
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.dockerfile).toContain("FROM debian:12");
  });

  it("returns the build log on failure", async () => {
    const run = async (): Promise<ExecResult> => ({ code: 1, stdout: "out", stderr: "boom" });
    expect(await dockerImages({ exec: run }).build({ tag: "t:1", base: "debian:12", machineImage: "m", layerKey: "k", baseDigest: digest })).toEqual({ ok: false, log: "out\nboom" });
  });
});

describe("a base without git", () => {
  it("is refused with that reason", async () => {
    const run = async (_c: string, a: string[]): Promise<ExecResult> => {
      if (a[0] === "pull") return ok();
      if (a[0] === "image") return ok(`${digest}|linux|${process.arch === "arm64" ? "arm64" : "amd64"}\n`);
      // The probe prints the loader and then `git` when it is found.
      return ok(a.join(" ").includes("command -v git") ? "/lib/ld-linux-x\n" : "");
    };
    expect(await dockerImages({ exec: run }).checkBase("debian:12")).toMatchObject({ ok: false, reason: expect.stringMatching(/git/) });
    const withGit = async (c: string, a: string[]): Promise<ExecResult> => (a[0] === "run" ? ok("/lib/ld-linux-x\n/usr/bin/git\n") : run(c, a));
    expect(await dockerImages({ exec: withGit }).checkBase("debian:12")).toEqual({ ok: true, digest });
  });
});
