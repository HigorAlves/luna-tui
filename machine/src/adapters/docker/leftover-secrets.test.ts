import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { sweepRunSecrets } from "./leftover-secrets.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the start-up sweep of a killed machine's credentials", () => {
  it("removes every run's relay and secrets folders, and leaves the rest of the run alone", async () => {
    const state = mkdtempSync(join(tmpdir(), "sweep-secrets-"));
    dirs.push(state);
    for (const run of ["r1", "r2"]) {
      mkdirSync(join(state, "runs", run, "relay"), { recursive: true });
      writeFileSync(join(state, "runs", run, "relay", "anthropic"), "sk-real");
      mkdirSync(join(state, "runs", run, "secrets"), { recursive: true });
      writeFileSync(join(state, "runs", run, "secrets", "TOKEN"), "v");
      mkdirSync(join(state, "runs", run, "out"), { recursive: true });
      writeFileSync(join(state, "runs", run, "out", "result.json"), "{}");
    }
    expect(await sweepRunSecrets(state)).toBe(4);
    for (const run of ["r1", "r2"]) {
      expect(existsSync(join(state, "runs", run, "relay"))).toBe(false);
      expect(existsSync(join(state, "runs", run, "secrets"))).toBe(false);
      expect(existsSync(join(state, "runs", run, "out", "result.json"))).toBe(true);
    }
  });

  it("is nothing to do when there are no runs", async () => {
    const state = mkdtempSync(join(tmpdir(), "sweep-secrets-"));
    dirs.push(state);
    expect(await sweepRunSecrets(state)).toBe(0);
  });
});
