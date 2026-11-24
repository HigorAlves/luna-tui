// A real image built from a small glibc base and run through the factory's dry run. Skipped, with the reason, when docker or the
// machine's layer image is not there: RUNNER_TEST_IMAGE names a runner image carrying /opt/luna (built under a test tag, never `dev`).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { repoImages } from "../../application/repo-images.ts";
import { dockerImages } from "./image-build.ts";

const machineImage = process.env.RUNNER_TEST_IMAGE ?? "";
const probe = (...a: string[]) => {
  try {
    execFileSync("docker", a, { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};
const ready = machineImage !== "" && probe("image", "inspect", machineImage) && probe("image", "inspect", machineImage);
if (!ready) console.warn(`skipped: the repository image test needs docker and RUNNER_TEST_IMAGE (a runner image with /opt/luna); got "${machineImage}"`);

describe.skipIf(!ready)("a repository's image, built for real", () => {
  const built: string[] = [];
  afterAll(() => {
    for (const tag of built) probe("rmi", "-f", tag);
  });

  it("is built from a glibc base and runs the factory's dry run", async () => {
    // A small glibc base with git (the machine's layer does not carry git), built locally under a test tag.
    const base = "hardness-runner-test-11b-base:1";
    const dir = mkdtempSync(join(tmpdir(), "repo-image-base-"));
    writeFileSync(join(dir, "Dockerfile"), "FROM python:3.13-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*\n");
    execFileSync("docker", ["build", "-q", "-t", base, dir], { stdio: "ignore", timeout: 300_000 });
    built.push(base);
    rmSync(dir, { recursive: true, force: true });
    const images = repoImages({
      machineImage,
      imageOf: async () => ({ base }),
      slugOf: () => "test-11b-integration",
      docker: dockerImages(),
      approvals: { isApproved: async () => true },
    });
    const { image } = await images.ensure("/anywhere");
    built.push(image);
    expect(image).toMatch(/^hardness-runner-test-11b-integration:[0-9a-f]{16}$/);

    const root = mkdtempSync(join(tmpdir(), "repo-image-"));
    try {
      const [inDir, outDir, work] = ["in", "out", "work"].map((d) => join(root, d)) as [string, string, string];
      for (const d of [inDir, outDir, work]) mkdirSync(d);
      for (const d of [outDir, work]) chmodSync(d, 0o777);
      writeFileSync(join(inDir, "stage.json"), JSON.stringify({
        schema: 1, stage: "implementing", pack: "implementing", attempt: 1,
        task: { id: "it", title: "it", description: "", criteria: [], repoPath: "/x", branch: "task/it-1", source: null },
        plan: { brief: "", criteria: [], assumptions: [] }, decisions: [], priorFindings: [], context: { projectContext: null, tests: [] },
        limits: { maxTurns: 5, timeoutMs: 60000 }, env: { LUNA_FACTORY: "1" },
      }));
      execFileSync("docker", ["run", "--rm", "--network", "none", "-e", "LUNA_STAGE_DRY_RUN=1", "-e", "ANTHROPIC_API_KEY=no-call", "-e", "HOME=/tmp",
        "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--tmpfs", "/tmp", "-v", `${inDir}:/in:ro`, "-v", `${outDir}:/out`, "-v", `${work}:/work`, image], { stdio: "pipe", timeout: 120_000 });
      expect(JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")).summary).toBe("dry-run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 600_000);
});
