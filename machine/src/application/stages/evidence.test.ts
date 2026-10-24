import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { evidenceRunner } from "./evidence.ts";
import type { StageContext } from "../ports.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "evidence-"));
});

const context = { task: { id: "t1" }, stage: "evidence", attempt: 1, runId: "ev", approvals: [] } as unknown as StageContext;

function qaDir(runId = "e2e-run"): string {
  const dir = join(stateDir, "runs", runId, "files", "qa");
  mkdirSync(dir, { recursive: true });
  return dir;
}
const runner = (e2e: { runId: string; detail?: Record<string, unknown> } | null) =>
  evidenceRunner({ stateDir, latestE2e: async () => e2e });

describe("evidenceRunner", () => {
  it("passes on a pass manifest and lists artifacts and thumbnails", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "pass" }));
    for (const f of ["a.png", "b.png", "c.png", "d.png"]) writeFileSync(join(dir, f), f);
    writeFileSync(join(dir, "walk.webm"), "v");
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "evidence",
      verdict: "pass",
      artifactCount: 6,
      manifestPath: join(dir, "qa-manifest.json"),
      thumbnails: [join(dir, "a.png"), join(dir, "b.png"), join(dir, "c.png")],
    });
    expect(result.detail?.evidence).toEqual({
      verdict: "pass",
      artifactCount: 6,
      manifest: join(dir, "qa-manifest.json"),
      thumbnails: [join(dir, "a.png"), join(dir, "b.png"), join(dir, "c.png")],
    });
    expect(result.artifacts).toHaveLength(6);
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({ kind: "qa-manifest", path: join(dir, "qa-manifest.json"), label: "qa-manifest.json" }),
    );
    expect(result.artifacts).toContainEqual(expect.objectContaining({ kind: "video", label: "walk.webm" }));
    expect(result.artifacts?.every((a) => a.sha256.length === 64)).toBe(true);
  });

  it("fails on a fail manifest", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "fail" }));
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ step: "evidence", verdict: "fail" });
  });

  it("fails on a partial manifest and on an unreadable one", async () => {
    const dir = qaDir();
    writeFileSync(join(dir, "qa-manifest.json"), JSON.stringify({ verdict: "partial" }));
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("fail");
    writeFileSync(join(dir, "qa-manifest.json"), "{not json");
    expect((await runner({ runId: "e2e-run" })(context)).outcome).toBe("fail");
  });

  it("passes a skipped manifest", async () => {
    writeFileSync(join(qaDir(), "qa-manifest.json"), JSON.stringify({ verdict: "skipped" }));
    const result = await runner({ runId: "e2e-run" })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "skipped" });
  });

  it("passes with the same note when e2e was skipped and left no manifest", async () => {
    const result = await runner({ runId: "e2e-run", detail: { skipped: true, reason: "no web surface detected" } })(context);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({
      step: "evidence",
      verdict: "skipped",
      artifactCount: 0,
      note: "e2e skipped: no web surface detected",
    });
  });

  it("fails with no manifest when e2e did not skip", async () => {
    const result = await runner({ runId: "e2e-run", detail: { verdict: "pass" } })(context);
    expect(result.outcome).toBe("fail");
    expect(result.detail).toMatchObject({ step: "evidence", error: expect.stringContaining("qa-manifest.json") });
  });

  it("fails when there is no e2e run at all", async () => {
    expect((await runner(null)(context)).outcome).toBe("fail");
  });
});
