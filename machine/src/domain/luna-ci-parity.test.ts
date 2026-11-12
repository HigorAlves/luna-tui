import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (file: string): unknown => parseYaml(readFileSync(join(root, file), "utf8"));

interface Step { name?: string; run?: string }
interface Job { steps?: Step[]; defaults?: { run?: { "working-directory"?: string } } }
interface Check { name: string; run: string; cwd?: string; paths?: string[] }

const workflow = read(".github/workflows/validate.yml") as { jobs: Record<string, Job> };
const checks = (read("luna.yaml") as { checks: Check[] }).checks;

// What a card cannot run, or does not need to: CI's own setup, and the fresh-clone job, which builds docker images.
const CI_ONLY = new Set(["pnpm install --frozen-lockfile", "git config --global user.email ci@example.invalid && git config --global user.name ci", "bash machine/runner/build.sh", "pnpm --filter @hardness/machine smoke:sandbox"]);

describe("luna.yaml's checks follow validate.yml", () => {
  it("has a check for every step CI runs, with the same command and folder", () => {
    const declared = new Set(checks.map((check) => `${check.cwd ?? "."}::${check.run}`));
    const missing: string[] = [];
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const cwd = job.defaults?.run?.["working-directory"] ?? ".";
      for (const step of job.steps ?? []) {
        if (!step.run || CI_ONLY.has(step.run.trim())) continue;
        if (!declared.has(`${cwd}::${step.run.trim()}`)) missing.push(`${jobName}: ${step.name ?? step.run}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("runs the setup scripts' checks for a card that changes only scripts/setup", () => {
    const check = checks.find((c) => c.run.includes("shellcheck"));
    expect(check?.paths).toBeDefined();
    expect(picomatch(check!.paths!, { dot: true })("scripts/setup/doctor.sh")).toBe(true);
  });

  it("runs the golden selftest for a card that changes the helpers it imports", () => {
    const check = checks.find((c) => c.run.includes("golden-task.mjs --selftest"));
    const matches = picomatch(check!.paths!, { dot: true });
    expect(matches("machine/scripts/golden-lib.mjs")).toBe(true);
    expect(matches("machine/scripts/golden-task.mjs")).toBe(true);
  });
});
