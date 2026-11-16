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

  it("asks the probe for the declared toolchains' versions and returns the mismatches as warnings, never a refusal", async () => {
    const scripts: string[] = [];
    const run = async (_c: string, a: string[]): Promise<ExecResult> => {
      if (a[0] === "image") return ok(`${digest}|linux|${process.arch === "arm64" ? "arm64" : "amd64"}\n`);
      if (a[0] === "run") return (scripts.push(a.at(-1)!), ok("/lib/ld-linux-aarch64.so.1\n/usr/bin/git\nluna-tool:node=v22.3.0\nluna-tool:go=\n"));
      return ok();
    };
    const got = await dockerImages({ exec: run }).checkBase("debian:12", undefined, { node: "24", go: "1.22", mystery: "1" });
    expect(got).toEqual({ ok: true, digest, toolchainWarnings: ["toolchains node: the image has 22.3, luna.yaml wants 24", "toolchains go: the image has none, luna.yaml wants 1.22"] });
    expect(scripts[0]).toContain("luna-tool:node=");
    expect(scripts[0]).not.toContain("mystery");
    // no toolchains: the probe and its answer are what they were
    expect(await dockerImages({ exec: run }).checkBase("debian:12")).toEqual({ ok: true, digest });
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

describe("a repository's approved Dockerfile", () => {
  const spec = { tag: "hardness-devcontainer-x:abc", key: `dockerfile=sha256:${"a".repeat(64)}`, text: "FROM debian:12\nRUN true\n", context: "/repo/.devcontainer", args: { B: "2", A: "1" } };

  it("builds from the approved bytes in a temp file, on the default network, with only the key's label and its build args", async () => {
    const seen: Array<{ command: string; args: string[]; file: string }> = [];
    const run = async (command: string, args: string[]): Promise<ExecResult> => {
      seen.push({ command, args, file: readFileSync(args[args.indexOf("-f") + 1]!, "utf8") });
      return { code: 0, stdout: "built", stderr: "warn" };
    };
    expect(await dockerImages({ exec: run }).buildDockerfile(spec)).toEqual({ ok: true, log: "built\nwarn" });
    const { command, args, file } = seen[0]!;
    expect(command).toBe("docker");
    expect(args.slice(0, 4)).toEqual(["build", "--progress", "plain", "--label"]);
    expect(args).toContain(`dev.hardness.dockerfile=${spec.key}`);
    expect(args.filter((_a, i) => args[i - 1] === "--build-arg")).toEqual(["A=1", "B=2"]);
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", spec.tag]);
    expect(args.at(-1)).toBe("/repo/.devcontainer");
    expect(file).toBe(spec.text);
    expect(args.some((a) => /--network|--secret|--ssh|--allow|--add-host/.test(a))).toBe(false);
  });

  it("returns the log on failure", async () => {
    const run = async (): Promise<ExecResult> => ({ code: 1, stdout: "out", stderr: "RUN failed" });
    expect(await dockerImages({ exec: run }).buildDockerfile(spec)).toEqual({ ok: false, log: "out\nRUN failed" });
  });

  it("probes a built image locally: no pull, and a missing image is refused", async () => {
    const cmds: string[][] = [];
    const run = async (_c: string, a: string[]): Promise<ExecResult> => {
      cmds.push(a);
      if (a[0] === "image") return ok(`${digest}|linux|${process.arch === "arm64" ? "arm64" : "amd64"}\n`);
      return ok("/lib/ld-linux-x\n/usr/bin/git\n");
    };
    expect(await dockerImages({ exec: run }).checkBase("hardness-devcontainer-x:abc", undefined, {}, { local: true })).toEqual({ ok: true, digest });
    expect(cmds.some((a) => a[0] === "pull")).toBe(false);
    const gone = async (): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "no such image" });
    expect(await dockerImages({ exec: gone }).checkBase("hardness-devcontainer-x:abc", undefined, {}, { local: true })).toMatchObject({ ok: false });
  });
});
