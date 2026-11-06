// Against Docker, for real: `openApp` starts, seeds and probes an app in the test image, and a container on its own network joins the app's.
// Skipped, with the reason, without RUNNER_TEST_IMAGE (a runner image with the egress proxy). Everything it makes is removed in afterAll.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { execInSandbox } from "../adapters/docker/docker.ts";
import { openCardNetwork, openPlainNetwork } from "../adapters/docker/egress.ts";
import { startServices } from "../adapters/docker/services.ts";
import { exec } from "../adapters/process/exec.ts";
import { parseLunaConfig } from "../domain/luna-config.ts";
import { openApp } from "./app-session.ts";

const image = process.env.RUNNER_TEST_IMAGE ?? "";
const tryDocker = (...a: string[]): string | null => {
  try {
    return execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
  } catch {
    return null;
  }
};
const ready = image !== "" && tryDocker("image", "inspect", "-f", '{{index .Config.Labels "dev.hardness.egress"}}', image) === "1";
if (!ready) console.warn(`skipped: the app test needs docker and RUNNER_TEST_IMAGE (a runner image with the egress proxy); got "${image}"`);

const tag = `${process.pid}`;
const work = ready ? mkdtempSync(join(tmpdir(), "app-test-")) : "";
afterAll(() => {
  for (const f of ["^hardness-egress-test-", "-app-"]) {
    const ids = tryDocker("ps", "-aq", "--filter", `name=${f}`);
    if (ids) tryDocker("rm", "-f", ...ids.split("\n"));
  }
  const nets = tryDocker("network", "ls", "-q", "--filter", "name=hardness-card-");
  if (nets) for (const id of nets.split("\n")) tryDocker("network", "rm", id);
  if (work) rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!ready)("openApp against Docker", () => {
  it("seeds, starts the app, answers its readiness path, is reached as luna-app by a container on the app's network, and leaves nothing", async () => {
    const policy = parseLunaConfig(`verify:\n  e2e:\n    start:\n      command: exec /opt/luna/bin/node -e "require('node:http').createServer((q,r)=>r.end('hello-app')).listen(4000,'0.0.0.0')"\n      port: 4000\n      ready_timeout_s: 60\n    seed:\n      command: echo seeded > /work/seed.txt\n`);
    const opened = await openApp(
      {
        policies: { for: async () => policy },
        imageFor: async () => image,
        install: async () => ({ ok: true, ran: [], notes: [], blocked: [] }),
        egress: { for: async () => ({ allow: ["github.com:443"], allowPrivate: [], proxyImage: image }) },
        openCardNetwork,
        openPlainNetwork,
        startServices,
        exec: execInSandbox,
        docker: (args, options) => exec("docker", args, options ?? {}),
      },
      { taskId: `${tag}00000000`, repoPath: work, workspace: work, commit: "c".repeat(40), attempt: 1, onBlocked: () => {} },
    );
    if (!opened.ok) throw new Error(`the app did not open: ${JSON.stringify(opened.detail)}`);
    try {
      expect(existsSync(join(work, "seed.txt"))).toBe(true);
      expect(opened.target.baseUrl).toBe("http://luna-app:4000");
      // a container on the app's network reaches it by name, directly
      const out = tryDocker("run", "--rm", "--network", opened.network, "--entrypoint", "/opt/luna/bin/node", image, "-e", "fetch('http://luna-app:4000').then(r=>r.text()).then(t=>console.log('GOT '+t),e=>console.log('ERR '+e.cause?.code))");
      expect(out).toContain("GOT hello-app");
      // no port is published on the host
      expect(tryDocker("ps", "--filter", `name=-app-1`, "--format", "{{.Ports}}")).not.toMatch(/->/);
    } finally {
      await opened.close();
    }
    expect(tryDocker("ps", "-aq", "--filter", "name=-app-1")).toBe("");
    expect(tryDocker("network", "ls", "-q", "--filter", "name=hardness-card-")).toBe("");
  }, 240_000);
});
