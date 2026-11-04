// machine/src/adapters/laminar/index.ts
// The Telemetry port over Laminar (laminar.sh, self-hosted here under compose's `observe`
// profile): one root span per run, named `stage:<stage>`, `pack:<pack>` or `eval:<pack>`, in a
// session per task, with the run's facts as input and output and anything that happened on the
// way as span events; and one Laminar evaluation per `pnpm eval` run per engine, a datapoint per
// case linked to its trace. This is the only file that names `@lmnr-ai/lmnr`. The SDK is loaded
// here with a dynamic import, so a machine without a key never loads it; tests pass a fake.
//
// What is sent: the facts a run row keeps (pack, engine, model, turns, cost, duration, outcome,
// the fingerprint) and, in `full` mode only, the transcript on the host. Never a client's context
// nor a pack's answer. The stage container is never told Laminar exists.
import { readFile } from "node:fs/promises";

import type { Evaluation, EvaluationCase, EvaluationStart, RunEnd, RunSpan, RunStart, Telemetry, TracesMode } from "../../application/telemetry.ts";

export interface LaminarOptions {
  projectApiKey: string;
  /** Scheme and host, no port: `http://localhost`, or `http://lmnr-app` under compose. */
  baseUrl: string;
  /** The same Laminar as a stage container reaches it: `http://host.docker.internal` by default. */
  stageBaseUrl: string;
  httpPort: number;
  grpcPort: number;
  mode: Exclude<TracesMode, "off">;
}

/** The OpenTelemetry span surface the adapter uses. */
export interface LaminarSpanLike {
  setAttributes(attributes: Record<string, string | number | boolean>): unknown;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

/** The slice of `@lmnr-ai/lmnr` the adapter uses; the real module is cast to it, tests pass a fake. */
export interface LaminarSdk {
  Laminar: {
    initialize(props: { projectApiKey: string; baseUrl: string; httpPort: number; grpcPort: number; instrumentModules: Record<string, never> }): void;
    startSpan(options: { name: string; input?: unknown; spanType?: string; sessionId?: string; metadata?: Record<string, unknown>; tags?: string[] }): LaminarSpanLike;
    withSpan<T>(span: LaminarSpanLike, fn: () => T): T;
    setSpanOutput(output: unknown): void;
    getLaminarSpanContext(span: LaminarSpanLike): { traceId: string; spanId: string } | null;
    serializeLaminarSpanContext(span: LaminarSpanLike): string | null;
    flush(): Promise<void>;
  };
  LaminarClient: new (options: { baseUrl: string; port: number; projectApiKey: string }) => {
    evals: {
      create(args: { name?: string; groupName?: string; metadata?: Record<string, unknown> }): Promise<string>;
      createDatapoint(args: { evalId: string; data: unknown; target?: unknown; metadata?: Record<string, unknown>; index?: number; taskId?: string; traceId?: string }): Promise<string>;
      updateDatapoint(args: { evalId: string; datapointId: string; scores: Record<string, number | null>; executorOutput?: unknown }): Promise<void>;
    };
  };
}

/** OpenTelemetry's SpanStatusCode.ERROR, by value so the API package is not imported here. */
const STATUS_ERROR = 2;
/** Laminar's cost and model attribute keys (`LaminarAttributes` in the SDK), by value for the same reason. */
const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
const ATTR_TOTAL_COST = "gen_ai.usage.cost";
const ATTR_PROVIDER = "gen_ai.system";
/** A transcript longer than this is cut to its tail: the end of a run is what explains it. */
export const TRANSCRIPT_MAX_CHARS = 200_000;
const CUT_MARK = "[… earlier output cut]\n";

const loadSdk = async (): Promise<LaminarSdk> => (await import("@lmnr-ai/lmnr")) as unknown as LaminarSdk;

/** The transcript's text for the span: the tail of the file, or null when it cannot be read. */
async function transcriptText(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  return text.length > TRANSCRIPT_MAX_CHARS ? CUT_MARK + text.slice(-TRANSCRIPT_MAX_CHARS) : text;
}

/** The run's facts as the span's output: every defined field of `end`, the result's `run` flattened. */
function outputOf(end: RunEnd): Record<string, unknown> {
  const { info, transcriptPath: _path, ...rest } = end;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) output[key] = value;
  if (info) Object.assign(output, { runtime: info.runtime, modelId: info.modelId, sdkVersion: info.sdk.version, fingerprint: info.fingerprint });
  return output;
}

/** The span's start: everything known, defined fields only. */
function startOf(start: RunStart): Record<string, unknown> {
  return Object.fromEntries(Object.entries(start).filter(([, value]) => value !== undefined && value !== null));
}

export async function createLaminarTelemetry(options: LaminarOptions, sdk?: LaminarSdk, warn: (line: string) => void = (line) => console.warn(line)): Promise<Telemetry> {
  const { Laminar, LaminarClient } = sdk ?? (await loadSdk());
  Laminar.initialize({ projectApiKey: options.projectApiKey, baseUrl: options.baseUrl, httpPort: options.httpPort, grpcPort: options.grpcPort, instrumentModules: {} });
  const client = new LaminarClient({ baseUrl: options.baseUrl, port: options.httpPort, projectApiKey: options.projectApiKey });
  const safe = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      warn(`laminar: ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const run = (start: RunStart): RunSpan => {
    const name = `${start.kind}:${start.kind === "stage" ? start.stage : start.pack}`;
    const facts = startOf(start);
    const tags = [start.kind, ...(start.pack ? [start.pack] : []), ...(start.engine ? [start.engine] : [])];
    const span = Laminar.startSpan({ name, input: facts, spanType: start.kind === "eval" ? "EXECUTOR" : "DEFAULT", sessionId: start.sessionId, metadata: facts, tags });
    return {
      event: (eventName, payload = {}) => void span.addEvent(eventName, { payload: JSON.stringify(payload) }),
      traceId: () => Laminar.getLaminarSpanContext(span)?.traceId ?? null,
      // What the stage container's factory reads (factory/src/core/telemetry.ts) to continue this trace.
      childEnv: () => {
        const parent = Laminar.serializeLaminarSpanContext(span);
        return {
          LMNR_PROJECT_API_KEY: options.projectApiKey,
          LMNR_BASE_URL: options.stageBaseUrl,
          LMNR_HTTP_PORT: String(options.httpPort),
          LMNR_GRPC_PORT: String(options.grpcPort),
          ...(parent ? { LMNR_SPAN_CONTEXT: parent } : {}),
        };
      },
      end: async (end) => {
        const output = outputOf(end);
        if (options.mode === "full" && end.transcriptPath) {
          const transcript = await transcriptText(end.transcriptPath);
          if (transcript !== null) output.transcript = transcript;
        }
        await safe("span end failed", async () => {
          const attributes: Record<string, string | number> = {};
          if (end.model) attributes[ATTR_RESPONSE_MODEL] = end.model;
          if (typeof end.costUsd === "number") attributes[ATTR_TOTAL_COST] = end.costUsd;
          if (end.info?.runtime) attributes[ATTR_PROVIDER] = end.info.runtime;
          if (Object.keys(attributes).length > 0) span.setAttributes(attributes);
          if (end.error || end.outcome === "fail") span.setStatus({ code: STATUS_ERROR, ...(end.error ? { message: end.error } : {}) });
          Laminar.withSpan(span, () => Laminar.setSpanOutput(output));
          span.end();
        });
      },
    };
  };

  const evaluation = async (start: EvaluationStart): Promise<Evaluation> => {
    let id: string | null = null;
    await safe("could not create the evaluation", async () => {
      id = await client.evals.create({ name: start.name, groupName: start.groupName, ...(start.metadata ? { metadata: start.metadata } : {}) });
    });
    const evalId = id;
    return {
      id: evalId,
      record: (evalCase: EvaluationCase) =>
        evalId === null
          ? Promise.resolve()
          : safe(`could not record case ${evalCase.id}`, async () => {
              const datapointId = await client.evals.createDatapoint({
                evalId,
                data: evalCase.data,
                ...(evalCase.target ? { target: evalCase.target } : {}),
                index: evalCase.index,
                taskId: evalCase.id,
                ...(evalCase.traceId ? { traceId: evalCase.traceId } : {}),
              });
              await client.evals.updateDatapoint({ evalId, datapointId, scores: evalCase.scores, ...(evalCase.output !== undefined ? { executorOutput: evalCase.output } : {}) });
            }),
      finish: () => safe("flush failed", () => Laminar.flush()),
    };
  };

  return { mode: options.mode, run, evaluation, flush: () => safe("flush failed", () => Laminar.flush()) };
}
