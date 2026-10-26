import { describe, expect, it } from "vitest";

import { sandboxArgs, sandboxExecArgs, type SandboxRun } from "./docker.ts";

function run(over: Partial<SandboxRun> = {}): SandboxRun {
  return {
    name: "c1",
    image: "img:1",
    runDir: "/state/runs/r1",
    worktree: "/wt",
    writable: false,
    gitDir: null,
    input: {},
    timeoutMs: 1000,
    credential: { name: "ANTHROPIC_API_KEY", value: "sk-secret-value" } as SandboxRun["credential"],
    labels: { "dev.hardness.task": "t1" },
    ...over,
  };
}

describe("sandboxArgs", () => {
  it("hardens the container and points HOME, TMPDIR and orc state at the tmpfs", () => {
    const args = sandboxArgs(run(), "/state/runs/r1/in", "/state/runs/r1/out");
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges"]));
    for (const env of ["HOME=/tmp", "TMPDIR=/tmp", "ORC_STATE_DIR=/tmp/orc-state"]) {
      expect(args.join(" ")).toContain(`-e ${env}`);
    }
  });

  it("keeps orc's state on the host when given a state mount, so a ledger survives the attempt", () => {
    const args = sandboxArgs(run({ stateMount: "/state/tasks/t1/orc" }), "/in", "/out");
    expect(args).toEqual(expect.arrayContaining(["-v", "/state/tasks/t1/orc:/state", "-e", "ORC_STATE_DIR=/state"]));
    expect(args).not.toContain("ORC_STATE_DIR=/tmp/orc-state");
    expect(sandboxArgs(run(), "/in", "/out")).toContain("ORC_STATE_DIR=/tmp/orc-state");
  });

  it("caps memory, cpu and process count, so a runaway stage cannot take the machine down", () => {
    const args = sandboxArgs(run(), "/i", "/o").join(" ");
    expect(args).toContain("--memory 4g");
    expect(args).toContain("--cpus 2");
    expect(args).toContain("--pids-limit 1024");
  });

  it("mounts the worktree read-only unless writable", () => {
    expect(sandboxArgs(run(), "/i", "/o")).toContain("/wt:/work:ro");
    expect(sandboxArgs(run({ writable: true }), "/i", "/o")).toContain("/wt:/work");
  });

  it("mounts the git dir read-only and passes extraEnv", () => {
    const args = sandboxArgs(run({ gitDir: "/g/.git", extraEnv: { ORC_STAGE_DRY_RUN: "1" } }), "/i", "/o");
    expect(args).toContain("/g/.git:/g/.git:ro");
    expect(args.join(" ")).toContain("-e ORC_STAGE_DRY_RUN=1");
  });

  it("mounts the git dir writable for a writable stage, which commits", () => {
    const args = sandboxArgs(run({ writable: true, gitDir: "/g/.git" }), "/i", "/o");
    expect(args).toContain("/g/.git:/g/.git");
    expect(args).not.toContain("/g/.git:/g/.git:ro");
  });

  it("keeps hooks and config read-only inside a writable git dir, so a stage cannot plant a hook", () => {
    const args = sandboxArgs(run({ writable: true, gitDir: "/g/.git", gitReadOnly: ["hooks", "config"] }), "/i", "/o");
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts.indexOf("/g/.git:/g/.git")).toBeLessThan(mounts.indexOf("/g/.git/hooks:/g/.git/hooks:ro"));
    expect(mounts).toContain("/g/.git/config:/g/.git/config:ro");
  });

  it("commits as you, unsigned: the container has no gitconfig and no gpg key", () => {
    const args = sandboxArgs(run({ gitIdentity: { name: "Ada L", email: "ada@x.dev" } }), "/i", "/o").join(" ");
    for (const env of ["GIT_AUTHOR_NAME=Ada L", "GIT_AUTHOR_EMAIL=ada@x.dev", "GIT_COMMITTER_NAME=Ada L", "GIT_COMMITTER_EMAIL=ada@x.dev"]) {
      expect(args).toContain(`-e ${env}`);
    }
    expect(args).toContain("-e GIT_CONFIG_COUNT=2");
    expect(args).toContain("-e GIT_CONFIG_KEY_1=commit.gpgsign -e GIT_CONFIG_VALUE_1=false");
    expect(sandboxArgs(run(), "/i", "/o").join(" ")).not.toContain("GIT_AUTHOR_NAME");
  });

  it("passes the credential by name, never its value", () => {
    const args = sandboxArgs(run(), "/i", "/o");
    expect(args).toContain("ANTHROPIC_API_KEY");
    expect(args.join(" ")).not.toContain("sk-secret-value");
  });
});

describe("sandboxExecArgs", () => {
  // A project's own checks (verify Step A, the locked-test replay) run in the stage image,
  // not on the host: node_modules installed by a Linux container hold Linux binaries.
  const args = sandboxExecArgs({
    name: "chk1",
    image: "img:1",
    worktree: "/wt",
    argv: ["npm", "run", "test"],
    env: { HARDNESS_STAGE: "verifying" },
  });

  it("runs the command as the entrypoint in the worktree, writable, and removes the container after", () => {
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toEqual(expect.arrayContaining(["--name", "chk1", "-v", "/wt:/work", "-w", "/work", "--entrypoint", "npm"]));
    expect(args.slice(-3)).toEqual(["img:1", "run", "test"]);
  });

  it("is hardened like a stage: read-only root, exec tmpfs, no new privileges, the limits, HOME on the tmpfs", () => {
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,exec,size=512m", "--security-opt", "no-new-privileges", "-e", "HOME=/tmp", "-e", "TMPDIR=/tmp", "--memory", "4g"]));
  });

  it("passes only the env it was given, never the host's, and no credential", () => {
    const envs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envs).toEqual(["HOME=/tmp", "TMPDIR=/tmp", "HARDNESS_STAGE=verifying"]);
    expect(args.join(" ")).not.toMatch(/ANTHROPIC|CLAUDE/);
  });
});
