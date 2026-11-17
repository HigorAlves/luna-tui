// Against Docker, for real: the stage guard image runs under the stage flags with no secret in its environment, as a non-root user, and
// `safeagents --help` needs no network. Skipped, with the reason, unless docker and RUNNER_TEST_GUARD_IMAGE (an image labelled
// dev.hardness.guard, built by `bash machine/runner/build.sh --guard`) are there.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const image = process.env.RUNNER_TEST_GUARD_IMAGE ?? "";
const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
const tryDocker = (...args: string[]): string | null => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const ready = image !== "" && tryDocker("image", "inspect", "-f", '{{index .Config.Labels "dev.hardness.guard"}}', image) === "1";
if (!ready) console.warn(`skipped: the guard tests need docker and RUNNER_TEST_GUARD_IMAGE (an image labelled dev.hardness.guard); got "${image}"`);

// The stage's own flags (docker.ts runSandbox): a read-only root, a tmpfs /tmp, no capability, a private IPC namespace, no privilege gain, a pids cap.
const STAGE_FLAGS = ["--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--ipc", "private", "--security-opt", "no-new-privileges", "--pids-limit", "128"];
const run = (extra: string[], ...command: string[]): string => docker("run", "--rm", ...STAGE_FLAGS, ...extra, "--entrypoint", command[0] as string, image, ...command.slice(1));

describe.skipIf(!ready)("the stage guard image", () => {
  it("has no variable named like a key, token, secret or credential", () => {
    const names = run([], "env").split("\n").map((l) => l.split("=")[0] ?? "");
    expect(names.filter((n) => /KEY|TOKEN|SECRET|CREDENTIAL/i.test(n))).toEqual([]);
  });

  it("runs `safeagents --help` read-only with no network", () => {
    expect(run(["--network", "none"], "/opt/luna/bin/luna-env", "/opt/guard/bin/safeagents", "--help")).toMatch(/safeagents/i);
  });

  it("does not run as root", () => {
    expect(run([], "id", "-u")).not.toBe("0");
  });

  it("has no package installer at run time", () => {
    expect(tryDocker("run", "--rm", "--entrypoint", "sh", image, "-c", "command -v uv pip pip3 hatchling")).toBeNull();
    expect(tryDocker("run", "--rm", "--entrypoint", "/usr/local/bin/python", image, "-m", "pip", "--version")).toBeNull();
  });
});
