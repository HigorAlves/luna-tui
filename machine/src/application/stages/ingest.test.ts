import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ingestStageOutput, toStageResult } from "./ingest.ts";

const output = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  ok: true,
  outcome: "pass",
  summary: "done",
  needsInput: null,
  requested: [],
  findings: [],
  artifacts: [],
  slices: { done: 1, total: 1 },
  commit: "abc123",
  usage: { turns: 3, costUsd: 0.5, durationMs: 10, model: "m" },
  error: null,
  rateLimited: false,
  resetsAt: null,
  ...over,
});

let outDir: string;
let stateDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "ingest-out-"));
  stateDir = await mkdtemp(join(tmpdir(), "ingest-state-"));
});

describe("ingestStageOutput", () => {
  it("lands an e2e manifest where the evidence stage reads it", async () => {
    await mkdir(join(outDir, "files", "qa"), { recursive: true });
    await writeFile(join(outDir, "files", "qa", "qa-manifest.json"), JSON.stringify({ verdict: "pass" }));
    await writeFile(
      join(outDir, "result.json"),
      JSON.stringify(output({ artifacts: [{ kind: "qa-manifest", path: "files/qa/qa-manifest.json", label: "manifest", sha256: "" }] })),
    );
    await writeFile(join(outDir, "events.jsonl"), "");

    await ingestStageOutput({ outDir, runId: "e2e-run", stateDir });

    const { evidenceRunner } = await import("./evidence.ts");
    const runner = evidenceRunner({ stateDir, latestE2e: async () => ({ runId: "e2e-run" }) });
    const result = await runner({ task: { id: "t1" }, stage: "evidence", attempt: 1, runId: "ev", approvals: [] } as never);
    expect(result.outcome).toBe("pass");
    expect(result.detail).toMatchObject({ verdict: "pass" });
  });

  it("parses the result, events and copies artifacts with a computed sha256", async () => {
    const body = "hello report";
    await mkdir(join(outDir, "files"), { recursive: true });
    await writeFile(join(outDir, "files", "r.md"), body);
    await writeFile(
      join(outDir, "result.json"),
      JSON.stringify(output({ artifacts: [{ kind: "report", path: "files/r.md", label: "R", sha256: "" }] })),
    );
    await writeFile(
      join(outDir, "events.jsonl"),
      [
        JSON.stringify({ at: "2026-01-01T00:00:00Z", kind: "tool", payload: { name: "Read" } }),
        "",
        "not json",
        JSON.stringify({ at: "2026-01-01T00:00:01Z", kind: "note", payload: {} }),
      ].join("\n"),
    );

    const ingested = await ingestStageOutput({ outDir, runId: "run1", stateDir });

    expect(ingested.output.summary).toBe("done");
    expect(ingested.events.map((e) => e.kind)).toEqual(["tool", "stage.malformed", "note"]);
    expect(ingested.events[1]?.payload).toEqual({ line: "not json" });
    // Artifact paths are relative to /out and already start with files/; the copy
    // must not double it, or evidence (which reads runs/<id>/files/qa/) never finds a manifest.
    const dest = join(stateDir, "runs", "run1", "files", "r.md");
    expect(ingested.artifacts).toEqual([
      { kind: "report", path: dest, label: "R", sha256: createHash("sha256").update(body).digest("hex") },
    ]);
    expect(await readFile(dest, "utf8")).toBe(body);

    const result = toStageResult(ingested);
    expect(result).toMatchObject({
      outcome: "pass",
      detail: { summary: "done", commit: "abc123" },
      usage: { turns: 3, costUsd: 0.5 },
      run: { outputCommit: "abc123" },
    });
  });

  it("names the failing key when result.json is invalid", async () => {
    await writeFile(join(outDir, "result.json"), JSON.stringify(output({ outcome: "bogus" })));
    await expect(ingestStageOutput({ outDir, runId: "r", stateDir })).rejects.toThrow(/outcome/);
  });

  it("records a note event for a missing artifact instead of throwing", async () => {
    await writeFile(
      join(outDir, "result.json"),
      JSON.stringify(output({ artifacts: [{ kind: "report", path: "gone.md", label: "", sha256: "" }] })),
    );
    const ingested = await ingestStageOutput({ outDir, runId: "r", stateDir });
    expect(ingested.artifacts).toEqual([]);
    expect(ingested.events).toMatchObject([{ kind: "note", payload: { missing: true, path: "gone.md" } }]);
  });

  it("carries the pack answer into detail.answer", async () => {
    const answer = { kind: "done", criteria: ["a"] };
    await writeFile(join(outDir, "result.json"), JSON.stringify(output({ answer })));
    const result = toStageResult(await ingestStageOutput({ outDir, runId: "r", stateDir }));
    expect(result.detail?.answer).toEqual(answer);
  });
});
