// machine/src/adapters/laminar/index.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { type LaminarSdk, type LaminarSpanLike, createLaminarTelemetry } from "./index.ts";

interface FakeSpan extends LaminarSpanLike {
  name: string;
  started: Record<string, unknown>;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes: Record<string, unknown> }>;
  status: { code: number; message?: string } | null;
  output: unknown;
  ended: boolean;
}

let spans: FakeSpan[];
let initialized: Record<string, unknown>[];
let flushed: number;
let evals: Array<Record<string, unknown>>;
let datapoints: Array<Record<string, unknown>>;
let updates: Array<Record<string, unknown>>;
let active: FakeSpan | null;

function fakeSdk(): LaminarSdk {
  return {
    Laminar: {
      initialize: (props) => void initialized.push(props as Record<string, unknown>),
      startSpan: (opts) => {
        const span: FakeSpan = {
          name: opts.name,
          started: opts as Record<string, unknown>,
          attributes: {},
          events: [],
          status: null,
          output: undefined,
          ended: false,
          setAttributes(attrs) {
            Object.assign(this.attributes, attrs);
            return this;
          },
          addEvent(name, attrs) {
            this.events.push({ name, attributes: (attrs ?? {}) as Record<string, unknown> });
            return this;
          },
          setStatus(status) {
            this.status = status;
            return this;
          },
          end() {
            this.ended = true;
          },
        };
        spans.push(span);
        return span;
      },
      withSpan: (span, fn) => {
        active = span as FakeSpan;
        try {
          return fn();
        } finally {
          active = null;
        }
      },
      setSpanOutput: (output) => {
        if (active) active.output = output;
      },
      getLaminarSpanContext: (span) => ({ traceId: `trace-${(span as FakeSpan).name}`, spanId: "s" }),
      serializeLaminarSpanContext: (span) => `ctx:${(span as FakeSpan).name}`,
      flush: async () => void flushed++,
    },
    LaminarClient: class {
      evals = {
        create: async (args: Record<string, unknown>) => {
          evals.push(args);
          return "eval-1";
        },
        createDatapoint: async (args: Record<string, unknown>) => {
          datapoints.push(args);
          return `dp-${datapoints.length}`;
        },
        updateDatapoint: async (args: Record<string, unknown>) => void updates.push(args),
      };
      constructor(readonly options: Record<string, unknown>) {}
    } as unknown as LaminarSdk["LaminarClient"],
  };
}

const options = { projectApiKey: "k", baseUrl: "http://localhost", stageBaseUrl: "http://host.docker.internal", httpPort: 8000, grpcPort: 8001 };

beforeEach(() => {
  spans = [];
  initialized = [];
  flushed = 0;
  evals = [];
  datapoints = [];
  updates = [];
  active = null;
});

describe("createLaminarTelemetry", () => {
  it("initializes the SDK against the self-hosted address with no auto-instrumentation", async () => {
    const telemetry = await createLaminarTelemetry({ ...options, mode: "metadata" }, fakeSdk());
    expect(telemetry.mode).toBe("metadata");
    expect(initialized).toEqual([{ projectApiKey: "k", baseUrl: "http://localhost", httpPort: 8000, grpcPort: 8001, instrumentModules: {} }]);
  });

  it("gives a stage run one span named after its stage, in the task's session, with its facts as input and output", async () => {
    const telemetry = await createLaminarTelemetry({ ...options, mode: "metadata" }, fakeSdk());
    const span = telemetry.run({ kind: "stage", pack: "implementing", engine: null, sessionId: "task-1", taskId: "task-1", stage: "implementing", attempt: 2 });
    span.event("started", { container: "hardness-abc-implementing-2", engine: "claude:opus" });
    span.event("rate_limited", { resetsAt: 1_800_000_000 });
    expect(span.traceId()).toBe("trace-stage:implementing");
    await span.end({
      outcome: "pass",
      status: "passed",
      engine: "claude:opus",
      repo: "/repos/app",
      model: "claude-opus-5-5",
      turns: 14,
      costUsd: 0.42,
      durationMs: 61_000,
      info: { runtime: "claude", engine: "claude:opus", modelId: "claude-opus-5-5", sdk: { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.311" }, fingerprint: "a".repeat(64) },
      transcriptPath: "/nowhere/transcript.log",
    });
    const [s] = spans;
    expect(s!.name).toBe("stage:implementing");
    expect(s!.started).toMatchObject({
      sessionId: "task-1",
      tags: ["stage", "implementing"],
      metadata: { kind: "stage", pack: "implementing", taskId: "task-1", stage: "implementing", attempt: 2 },
      input: { kind: "stage", pack: "implementing", taskId: "task-1", stage: "implementing", attempt: 2 },
    });
    expect(s!.events.map((e) => e.name)).toEqual(["started", "rate_limited"]);
    expect(JSON.parse(s!.events[0]!.attributes.payload as string)).toEqual({ container: "hardness-abc-implementing-2", engine: "claude:opus" });
    expect(s!.output).toEqual({
      outcome: "pass",
      status: "passed",
      engine: "claude:opus",
      repo: "/repos/app",
      model: "claude-opus-5-5",
      turns: 14,
      costUsd: 0.42,
      durationMs: 61_000,
      runtime: "claude",
      modelId: "claude-opus-5-5",
      sdkVersion: "0.3.311",
      fingerprint: "a".repeat(64),
    });
    expect(s!.attributes).toMatchObject({ "gen_ai.response.model": "claude-opus-5-5", "gen_ai.usage.cost": 0.42 });
    expect(s!.status).toBeNull();
    expect(s!.ended).toBe(true);
  });

  it("in full mode hands a child process the key, the containers' address and the serialized parent span; in metadata mode nothing", async () => {
    const metadata = await createLaminarTelemetry({ ...options, mode: "metadata" }, fakeSdk());
    expect(metadata.run({ kind: "stage", pack: "triage", engine: "claude:opus", sessionId: "t", taskId: "t", stage: "triage", attempt: 1 }).childEnv()).toEqual({});
    const telemetry = await createLaminarTelemetry({ ...options, mode: "full" }, fakeSdk());
    const span = telemetry.run({ kind: "stage", pack: "triage", engine: "claude:opus", sessionId: "t", taskId: "t", stage: "triage", attempt: 1 });
    expect(span.childEnv()).toEqual({
      LMNR_PROJECT_API_KEY: "k",
      LMNR_BASE_URL: "http://host.docker.internal",
      LMNR_HTTP_PORT: "8000",
      LMNR_GRPC_PORT: "8001",
      LMNR_SPAN_CONTEXT: "ctx:stage:triage",
    });
  });

  it("marks a failed run and attaches the transcript only in full mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laminar-"));
    const transcript = join(dir, "transcript.log");
    writeFileSync(transcript, "line 1\nline 2\n");
    const metadata = await createLaminarTelemetry({ ...options, mode: "metadata" }, fakeSdk());
    await metadata.run({ kind: "pack", pack: "chat_triage", engine: "claude:haiku", client: "board" }).end({ outcome: "fail", error: "timed out after 3 minutes", transcriptPath: transcript });
    const full = await createLaminarTelemetry({ ...options, mode: "full" }, fakeSdk());
    await full.run({ kind: "pack", pack: "chat_triage", engine: "claude:haiku", client: "board" }).end({ outcome: "fail", error: "timed out after 3 minutes", transcriptPath: transcript });
    await full.run({ kind: "pack", pack: "chat_triage", engine: "claude:haiku", client: "board" }).end({ outcome: "pass", transcriptPath: join(dir, "missing.log") });
    expect(spans.map((s) => s.name)).toEqual(["pack:chat_triage", "pack:chat_triage", "pack:chat_triage"]);
    expect(spans[0]!.output).not.toHaveProperty("transcript");
    expect(spans[0]!.status).toEqual({ code: 2, message: "timed out after 3 minutes" });
    expect(spans[1]!.output).toMatchObject({ transcript: "line 1\nline 2\n" });
    // A transcript that is not there is left out, and the span still ends.
    expect(spans[2]!.output).not.toHaveProperty("transcript");
    expect(spans[2]!.ended).toBe(true);
  });

  it("keeps a transcript to its last 200k characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laminar-"));
    const transcript = join(dir, "transcript.log");
    writeFileSync(transcript, "x".repeat(250_000) + "END");
    const full = await createLaminarTelemetry({ ...options, mode: "full" }, fakeSdk());
    await full.run({ kind: "eval", pack: "triage", engine: "codex:sol", client: "eval" }).end({ outcome: "pass", transcriptPath: transcript });
    const text = (spans[0]!.output as { transcript: string }).transcript;
    expect(text.length).toBe(200_000 + "[… earlier output cut]\n".length);
    expect(text.endsWith("END")).toBe(true);
  });

  it("records an evaluation: one per call, a datapoint per case linked to its trace, scores on update", async () => {
    const telemetry = await createLaminarTelemetry({ ...options, mode: "metadata" }, fakeSdk());
    const evaluation = await telemetry.evaluation({ name: "claude:haiku 2026-11-03", groupName: "slack_triage", metadata: { judge: "claude:opus" } });
    expect(evaluation.id).toBe("eval-1");
    expect(evals).toEqual([{ name: "claude:haiku 2026-11-03", groupName: "slack_triage", metadata: { judge: "claude:opus" } }]);
    await evaluation.record({ id: "incident-bot-social", index: 0, data: { pack: "slack_triage" }, target: { rubric: "r" }, output: { answer: {} }, scores: { pass: 1, judge: 0.9 }, traceId: "trace-eval:slack_triage" });
    expect(datapoints).toEqual([{ evalId: "eval-1", data: { pack: "slack_triage" }, target: { rubric: "r" }, index: 0, taskId: "incident-bot-social", traceId: "trace-eval:slack_triage" }]);
    expect(updates).toEqual([{ evalId: "eval-1", datapointId: "dp-1", scores: { pass: 1, judge: 0.9 }, executorOutput: { answer: {} } }]);
    await evaluation.finish();
    await telemetry.flush();
    expect(flushed).toBe(2);
  });

  it("never rejects when the backend fails: a flush is logged, a failed evaluation has no id", async () => {
    const sdk = fakeSdk();
    sdk.Laminar.flush = async () => {
      throw new Error("connection refused");
    };
    sdk.LaminarClient = class {
      evals = {
        create: async () => {
          throw new Error("boom");
        },
      };
    } as unknown as LaminarSdk["LaminarClient"];
    const warnings: string[] = [];
    const telemetry = await createLaminarTelemetry({ ...options, mode: "metadata" }, sdk, (line) => warnings.push(line));
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(warnings[0]).toMatch(/^laminar: flush failed: connection refused/);
    expect((await telemetry.evaluation({ name: "e", groupName: "g" })).id).toBeNull();
    expect(warnings).toContain("laminar: could not create the evaluation: boom");
  });
  it("never throws into a run: a span the SDK refuses to start is a no-op, and a span whose output cannot be set still ends", async () => {
    const sdk = fakeSdk();
    const warnings: string[] = [];
    let refuse = true;
    const startSpan = sdk.Laminar.startSpan;
    sdk.Laminar.startSpan = (opts) => {
      if (refuse) throw new Error("not initialized");
      return startSpan(opts);
    };
    sdk.Laminar.setSpanOutput = () => {
      throw new Error("circular");
    };
    const telemetry = await createLaminarTelemetry({ ...options, mode: "metadata" }, sdk, (line) => warnings.push(line));
    const refused = telemetry.run({ kind: "pack", pack: "chat_triage", engine: "claude:haiku", client: "board" });
    refused.event("started");
    expect(refused.traceId()).toBeNull();
    expect(refused.childEnv()).toEqual({});
    await expect(refused.end({ outcome: "pass" })).resolves.toBeUndefined();
    expect(warnings).toEqual(["laminar: span start failed: not initialized"]);
    refuse = false;
    await telemetry.run({ kind: "pack", pack: "chat_triage", engine: "claude:haiku", client: "board" }).end({ outcome: "pass" });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.ended).toBe(true);
    expect(warnings[1]).toBe("laminar: span end failed: circular");
  });
});
