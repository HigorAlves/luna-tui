import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const machineDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const guardDir = join(machineDir, "runner", "guard");
const read = (path: string): string => readFileSync(path, "utf8");

describe("the stage guard image", () => {
  const dockerfile = (): string => read(join(guardDir, "Dockerfile"));

  it("pins SafeAgents to a full commit sha, installs hashed dependencies, runs non-root, is labelled", () => {
    const text = dockerfile();
    expect(text).toMatch(/github\.com\/huggingface\/safeagents\/archive\/\$\{?SAFEAGENTS_SHA\}?\.tar\.gz/);
    expect(text).toMatch(/ARG SAFEAGENTS_SHA=[0-9a-f]{40}\b/);
    expect(text).toMatch(/ARG SAFEAGENTS_SHA256=[0-9a-f]{64}\b/);
    expect(text).toMatch(/sha256sum -c/);
    expect(text).toContain("--require-hashes");
    expect(text).toContain("--no-deps");
    expect(text).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    expect(text).not.toContain("astral.sh/uv/install");
    expect(text).toContain('LABEL dev.hardness.guard="1"');
    const user = [...text.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(user.length).toBeGreaterThan(0);
    expect(user.at(-1)).toMatch(/^\d+(:\d+)?$/);
    expect(user.at(-1)).not.toMatch(/^0(:|$)/);
    const froms = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThan(0);
    for (const from of froms.filter((f) => f !== "scratch")) expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("installs uv from a pinned PyPI version and bakes in no secret", () => {
    const text = dockerfile();
    expect(text).toMatch(/ARG UV_VERSION=\d+\.\d+\.\d+\n/);
    expect(text).toMatch(/pip install[^\n]*"uv==\$\{UV_VERSION\}"/);
    expect(text).not.toMatch(/^\s*(ENV|ARG)\s+\S*(KEY|TOKEN|SECRET|CREDENTIAL)\S*/im);
    expect(text).toContain("COPY luna-env /opt/luna/bin/luna-env");
    expect(text).toMatch(/ENTRYPOINT \["\/opt\/luna\/bin\/luna-env", "\/opt\/guard\/bin\/safeagents"\]/);
    expect(text).toContain("EXPOSE 8787");
  });

  it("locks every dependency with hashes, and the build context sends only luna-env and guard/", () => {
    const lock = read(join(guardDir, "requirements.lock"));
    expect(lock).toContain("uv pip compile");
    const pins = lock.split("\n").filter((l) => /^[A-Za-z0-9_.-]+==/.test(l));
    expect(pins.length).toBeGreaterThan(5);
    expect(lock.match(/--hash=sha256:[0-9a-f]{64}/g)?.length ?? 0).toBeGreaterThanOrEqual(pins.length);
    const ignore = read(join(guardDir, "Dockerfile.dockerignore"));
    expect(ignore).toMatch(/^\*$/m);
    expect(ignore).toContain("!luna-env");
    expect(ignore).toContain("!guard");
  });

  it("is built by build.sh --guard and by pnpm images", () => {
    const build = read(join(machineDir, "runner", "build.sh"));
    expect(build).toContain("--guard");
    expect(build).toContain("$runner-guard:dev");
    expect(build).toContain("-f \"$here/guard/Dockerfile\"");
    expect(JSON.parse(read(join(machineDir, "..", "package.json"))).scripts.images).toContain("--guard");
  });
});
