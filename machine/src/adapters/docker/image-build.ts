// Builds a repository's image with docker on the host. The Dockerfile is generated here from the base's reference (already
// validated by `imageSpecOf`) and the machine's own image; the build context is an empty folder, the network is off, and no
// build argument, secret or mount is ever passed: nothing but the base's name comes from the repository. Everything is argv.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageDocker } from "../../application/repo-images.ts";
import { type ExecResult, exec as hostExec } from "../process/exec.ts";

type Run = (command: string, args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<ExecResult>;

export const BUILD_TIMEOUT_MS = 10 * 60_000;
const PULL_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
export const LAYER_KEY_LABEL = "dev.hardness.build";

/** The host's architecture in docker's words. */
const hostArch = (): string => (process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : process.arch);

export function dockerfileFor(base: string, machineImage: string): string {
  return [
    `FROM ${base}`,
    `COPY --from=${machineImage} /opt/luna /opt/luna`,
    "ENV PATH=/opt/luna/bin:$PATH LUNA_FACTORY_ROOT=/opt/luna/factory-src/factory CODEX_HOME=/tmp/.codex EVE_TELEMETRY_DISABLED=1 GOTOOLCHAIN=local",
    "RUN mkdir -p /cache /work && chmod 0777 /cache",
    "WORKDIR /work",
    'ENTRYPOINT ["/opt/luna/bin/luna-stage"]',
    "",
  ].join("\n");
}

export function dockerImages(deps: { exec?: Run } = {}): ImageDocker {
  const run: Run = deps.exec ?? ((c, a, o) => hostExec(c, a, o));
  return {
    async layerKey(machineImage) {
      const out = await run("docker", ["image", "inspect", "--format", `{{index .Config.Labels "${LAYER_KEY_LABEL}"}}`, machineImage]);
      return out.code === 0 ? out.stdout.trim() || machineImage : machineImage;
    },
    async exists(tag) {
      return (await run("docker", ["image", "inspect", tag])).code === 0;
    },
    async checkBase(base) {
      const pulled = await run("docker", ["pull", "--quiet", base], { timeoutMs: PULL_TIMEOUT_MS });
      if (pulled.code !== 0) return { ok: false, reason: `the base image could not be pulled: ${pulled.stderr || pulled.stdout}` };
      const info = await run("docker", ["image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}", base]);
      const [digest, os, arch] = info.stdout.trim().split("|");
      if (info.code !== 0 || !digest?.startsWith("sha256:")) return { ok: false, reason: "the base image could not be inspected" };
      if (os !== "linux") return { ok: false, reason: `the base image is ${os}, not Linux` };
      if (arch !== hostArch()) return { ok: false, reason: `the base image's architecture is ${arch}, the host's is ${hostArch()}` };
      // A glibc loader in the image (musl images, such as Alpine, have none); the probe runs with no network, no capability, read-only.
      const probe = await run(
        "docker",
        ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m",
         "--entrypoint", "sh", base, "-c", "ls /lib64/ld-linux-* /lib/ld-linux-* /lib/*-linux-gnu/ld-linux-* 2>/dev/null | head -1"],
        { timeoutMs: CHECK_TIMEOUT_MS },
      );
      if (probe.code !== 0 || !probe.stdout.trim()) return { ok: false, reason: "the base image is not glibc Linux with a shell (the machine's layer needs both)" };
      return { ok: true, digest };
    },
    async build(spec) {
      const dir = await mkdtemp(join(tmpdir(), "luna-image-"));
      try {
        const context = join(dir, "context");
        await mkdir(context);
        const file = join(dir, "Dockerfile");
        await writeFile(file, dockerfileFor(spec.base, spec.machineImage), "utf8");
        const out = await run(
          "docker",
          ["build", "--network", "none", "--pull=false", "--progress", "plain", "--label", `${LAYER_KEY_LABEL}=${spec.layerKey}`, "--label", `dev.hardness.base=${spec.baseDigest}`, "-t", spec.tag, "-f", file, context],
          { timeoutMs: BUILD_TIMEOUT_MS, signal: spec.signal },
        );
        return out.code === 0 ? { ok: true } : { ok: false, log: [out.stdout, out.stderr].filter(Boolean).join("\n") };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
