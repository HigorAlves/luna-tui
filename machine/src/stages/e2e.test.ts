import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectWeb, e2eRunner, missingQaImageRunner } from "./e2e.ts";
import type { StageContext, StageResult } from "./runner.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-"));
});
const pkg = (value: unknown) => writeFileSync(join(dir, "package.json"), JSON.stringify(value));

describe("detectWeb", () => {
  it("is false for a repo with no web surface", async () => {
    pkg({ name: "lib", scripts: { test: "vitest" }, dependencies: { zod: "1" } });
    expect(await detectWeb(dir)).toBe(false);
  });
  it("is false for an empty directory", async () => {
    expect(await detectWeb(dir)).toBe(false);
  });
  it.each(["dev", "start", "preview"])("is true with a %s script", async (name) => {
    pkg({ scripts: { [name]: "x" } });
    expect(await detectWeb(dir)).toBe(true);
  });
  it("is true with a framework dependency, dev or not", async () => {
    pkg({ devDependencies: { svelte: "5" } });
    expect(await detectWeb(dir)).toBe(true);
  });
  it("is true with an index.html at the root or one level down", async () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "index.html"), "<html>");
    expect(await detectWeb(dir)).toBe(true);
  });
  it("ignores an index.html under node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "index.html"), "<html>");
    expect(await detectWeb(dir)).toBe(false);
  });
  it("is true with .orc/targets.json", async () => {
    mkdirSync(join(dir, ".orc"));
    writeFileSync(join(dir, ".orc", "targets.json"), "{}");
    expect(await detectWeb(dir)).toBe(true);
  });
});

const context = (): StageContext =>
  ({ task: { worktreePath: dir }, stage: "e2e", attempt: 1, runId: "r", approvals: [] }) as unknown as StageContext;

const packReturning = (result: StageResult) => vi.fn(async () => result);
const answered = (answer: Record<string, unknown>): StageResult => ({
  outcome: "pass",
  detail: { summary: "s", answer },
});

describe("e2eRunner", () => {
  it("skips with a reason, without running the pack, when there is no web surface", async () => {
    const runPack = packReturning(answered({}));
    const result = await e2eRunner({ runPack, detectWeb: async () => false })(context());
    expect(runPack).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "pass",
      detail: { step: "e2e", skipped: true, reason: "no web surface detected" },
    });
  });

  it.each([
    ["pass", "pass"],
    ["skipped", "pass"],
    ["partial", "fail"],
    ["fail", "fail"],
  ] as const)("maps verdict %s to %s", async (verdict, outcome) => {
    const criteria = [{ text: "works", result: "pass", evidence: ["a.png"] }];
    const runPack = packReturning(answered({ verdict, summary: "done", criteria }));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.outcome).toBe(outcome);
    expect(result.detail).toMatchObject({ step: "e2e", verdict, summary: "done", criteria });
  });

  it("notes a skipped verdict", async () => {
    const runPack = packReturning(answered({ verdict: "skipped", summary: "no server" }));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.detail).toMatchObject({ skipped: true });
    expect(result.detail?.note).toEqual(expect.stringContaining("skipped"));
  });

  it("keeps a pack failure as is, with the step recorded", async () => {
    const runPack = packReturning({ outcome: "fail", detail: { error: "timed out" } });
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result).toMatchObject({ outcome: "fail", detail: { step: "e2e", error: "timed out" } });
  });

  it("keeps artifacts and run facts from the pack", async () => {
    const artifacts = [{ kind: "screenshot" as const, path: "/x/a.png", label: "a.png", sha256: "s" }];
    const runPack = packReturning({ ...answered({ verdict: "pass" }), artifacts, run: { containerId: "c" } });
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.artifacts).toBe(artifacts);
    expect(result.run).toEqual({ containerId: "c" });
  });

  it("treats a pack with no verdict as a fail", async () => {
    const runPack = packReturning(answered({}));
    const result = await e2eRunner({ runPack, detectWeb: async () => true })(context());
    expect(result.outcome).toBe("fail");
  });
});

describe("missingQaImageRunner", () => {
  it("passes with a note that e2e was skipped", async () => {
    const result = await missingQaImageRunner()(context());
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "e2e",
      skipped: true,
      note: "QA image missing (pnpm runner-qa:build); e2e skipped",
    });
  });
});
