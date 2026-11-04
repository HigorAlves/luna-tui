import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

  it("skips an artifact that is a symlink: a container can point one at a host file, and the copy would follow it", async () => {
    const secret = join(outDir, "..", `ingest-secret-${process.pid}`);
    await writeFile(secret, "private key material");
    await mkdir(join(outDir, "files", "qa"), { recursive: true });
    await symlink(secret, join(outDir, "files", "qa", "leak.png"));
    await writeFile(join(outDir, "files", "qa", "ok.png"), "png");
    await writeFile(join(outDir, "result.json"), JSON.stringify(output({ artifacts: [{ kind: "screenshot", path: "files/qa/leak.png", label: "leak", sha256: "" }, { kind: "screenshot", path: "files/qa/ok.png", label: "ok", sha256: "" }] })));
    await writeFile(join(outDir, "events.jsonl"), "");
    const { artifacts, events } = await ingestStageOutput({ outDir, runId: "r-link", stateDir });
    expect(artifacts.map((a) => a.label)).toEqual(["ok"]);
    expect(existsSync(join(stateDir, "runs", "r-link", "files", "qa", "leak.png"))).toBe(false);
    expect(events.some((e) => e.kind === "note" && (e.payload as { skipped?: boolean }).skipped === true)).toBe(true);
    await rm(secret);
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

  it("keeps the run's stream in events.jsonl and off the task's log, and a kind it does not know on it", async () => {
    await writeFile(join(outDir, "result.json"), JSON.stringify(output()));
    const lines = [
      { kind: "session", payload: { id: "s1", text: "session s1" } },
      { kind: "text", payload: { text: "Looking around first." } },
      { kind: "tool_call", payload: { id: "1", tool: "Bash", target: "git push", allowed: false, reason: "no" } },
      { kind: "step", payload: { label: "reading", n: 1, of: 2 } },
      { kind: "tool_result", payload: { id: "1", tool: "Bash", ok: false } },
      { kind: "usage", payload: { model: "m", inputTokens: 1 } },
      { kind: "rate_limit", payload: { resetsAt: null } },
      { kind: "child", payload: { phase: "start", runId: "r2", pack: "triage", engine: "codex:sol" } },
      { kind: "ledger.init", payload: { total: 1 } },
      { kind: "something.new", payload: { x: 1 } },
      { kind: "note", payload: { phase: "stage_end", outcome: "pass", pack: "implementing" } },
    ];
    await writeFile(join(outDir, "events.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const ingested = await ingestStageOutput({ outDir, runId: "r", stateDir });

    expect(ingested.events.map((e) => e.kind)).toEqual(["step", "ledger.init", "something.new", "note"]);
    expect(ingested.events[2]?.payload).toEqual({ x: 1 });
  });

  it("carries the run record result.json names into the stage result", async () => {
    const run = { runtime: "claude", engine: "claude:opus", modelId: "claude-opus-5-5", sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.311" }, fingerprint: "a".repeat(64) };
    await writeFile(join(outDir, "result.json"), JSON.stringify(output({ schema: 3, run })));
    expect(toStageResult(await ingestStageOutput({ outDir, runId: "r", stateDir })).run).toEqual({ outputCommit: "abc123", info: run });
    await writeFile(join(outDir, "result.json"), JSON.stringify(output()));
    expect(toStageResult(await ingestStageOutput({ outDir, runId: "r", stateDir })).run).toEqual({ outputCommit: "abc123" });
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
