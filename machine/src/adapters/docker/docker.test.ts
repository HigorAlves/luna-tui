import { describe, expect, it } from "vitest";

import { sandboxArgs, type SandboxRun } from "./docker.ts";

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
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--tmpfs", "/tmp:rw,size=512m", "--security-opt", "no-new-privileges"]));
    for (const env of ["HOME=/tmp", "TMPDIR=/tmp", "ORC_STATE_DIR=/tmp/orc-state"]) {
      expect(args.join(" ")).toContain(`-e ${env}`);
    }
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
