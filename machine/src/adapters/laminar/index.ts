// machine/src/adapters/laminar/index.ts
// The Telemetry port over Laminar (laminar.sh, self-hosted here under compose's `observe`
// profile): one root span per run, named `stage:<stage>`, `pack:<pack>` or `eval:<pack>`, in a
// session per task, with the run's facts as input and output and anything that happened on the
// way as span events; and one Laminar evaluation per `pnpm eval` run per engine, a datapoint per
// case linked to its trace. This is the only file that names `@lmnr-ai/lmnr`. The SDK is loaded
// here with a dynamic import, so a machine without a key never loads it; tests pass a fake.
//
// What is sent: the facts a run row keeps (pack, engine, model, turns, cost, duration, outcome,
// the fingerprint); never a client's context nor a pack's answer. In `host` and `full` modes, a decision
// call the pipeline made itself also carries its context and answer (`RunEnd.input/output`), and the
// transcript is kept from the host (redacted). Only in `full` mode is the stage container handed the
// key and the span (`childEnv`) so its model calls nest under it: a project key reads every trace of
// the project, so `metadata` and `host` keep it on the host.
import { readFile } from "node:fs/promises";

import { redact } from "../../domain/evidence-markdown.ts";
import { maskPii } from "../../domain/secrets-check.ts";
import type { Datapoint, Evaluation, EvaluationCase, EvaluationStart, QueueItem, RunEnd, RunSpan, RunStart, Telemetry, TracesMode } from "../../application/telemetry.ts";

export interface LaminarOptions {
  projectApiKey: string;
  /** Scheme and host, no port: `http://localhost`, or `http://lmnr-app` under compose. */
  baseUrl: string;
  /** The same Laminar as a stage container reaches it: `http://host.docker.internal` by default. */
  stageBaseUrl: string;
  httpPort: number;
  grpcPort: number;
  mode: Exclude<TracesMode, "off">;
  /** The HTTP client for the labeling-queue calls, which the SDK has no resource for; tests pass a fake. */
  fetch?: typeof fetch;
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
    datasets: {
      push(args: { points: Array<{ data: unknown; target?: unknown; metadata?: Record<string, unknown>; taskId?: string }>; name: string; createDataset?: boolean }): Promise<unknown>;
      pull(args: { name: string; limit?: number; offset?: number }): Promise<{ items: Array<{ data: unknown; target?: unknown; metadata?: Record<string, unknown>; taskId?: string; id?: string }>; totalCount: number }>;
    };
  };
}

/** OpenTelemetry's SpanStatusCode.ERROR, by value so the API package is not imported here. */
const STATUS_ERROR = 2;
/** Laminar's cost and model attribute keys (`LaminarAttributes` in the SDK), by value for the same reason. */
const ATTR_RESPONSE_MODEL = "gen_ai.response.model";
const ATTR_TOTAL_COST = "gen_ai.usage.cost";
const ATTR_PROVIDER = "gen_ai.system";
/** The span's input attribute (`LaminarAttributes.SPAN_INPUT`): a decision call's context, in host and full modes. */
const ATTR_SPAN_INPUT = "lmnr.span.input";
/** A transcript longer than this is cut to its tail: the end of a run is what explains it. */
export const TRANSCRIPT_MAX_CHARS = 200_000;
const CUT_MARK = "[… earlier output cut]\n";
/** The span of a run the backend could not start: answers every call, keeps nothing. */
const NO_SPAN: RunSpan = { event: () => {}, traceId: () => null, childEnv: () => ({}), end: () => Promise.resolve() };

const loadSdk = async (): Promise<LaminarSdk> => (await import("@lmnr-ai/lmnr")) as unknown as LaminarSdk;

/** The transcript's text for the span: the tail of the file, or null when it cannot be read. */
async function transcriptText(path: string, scrub?: (text: string) => string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  // The same redaction a stored record gets: a token shape, an email address, a phone number never reach the trace tool.
  const clean = maskPii(redact(scrub ? scrub(text) : text));
  return clean.length > TRANSCRIPT_MAX_CHARS ? CUT_MARK + clean.slice(-TRANSCRIPT_MAX_CHARS) : clean;
}

/** The run's facts as the span's output: every defined field of `end`, the result's `run` flattened. */
function outputOf(end: RunEnd): Record<string, unknown> {
  const { info, transcriptPath: _path, input: _input, output: _output, scrub: _scrub, ...rest } = end;
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
    // A span the SDK refuses to start (not initialized, a bad context) is a no-op span: a trace
    // backend never fails a run. Said once per span.
    let span: LaminarSpanLike;
    try {
      span = Laminar.startSpan({ name, input: facts, spanType: start.kind === "eval" ? "EXECUTOR" : "DEFAULT", sessionId: start.sessionId, metadata: facts, tags });
    } catch (error) {
      warn(`laminar: span start failed: ${error instanceof Error ? error.message : String(error)}`);
      return NO_SPAN;
    }
    return {
      event: (eventName, payload = {}) => void span.addEvent(eventName, { payload: JSON.stringify(payload) }),
      traceId: () => Laminar.getLaminarSpanContext(span)?.traceId ?? null,
      // What the stage container's factory reads (factory/src/core/telemetry.ts) to continue this trace.
      childEnv: () => {
        if (options.mode !== "full") return {};
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
        const keeps = options.mode === "host" || options.mode === "full";
        if (keeps && end.transcriptPath) {
          const transcript = await transcriptText(end.transcriptPath, end.scrub);
          if (transcript !== null) output.transcript = transcript;
        }
        // A decision call of the pipeline's own: its context as the span's input and its answer in the
        // output, `host` and `full` modes (the machine's own data; an HTTP client's call never carries them).
        const spanInput = keeps ? end.input : undefined;
        if (keeps && end.output) Object.assign(output, end.output);
        // Whatever fails on the way out, the span ends: an unended span leaks in the SDK's batch.
        await safe("span end failed", async () => {
          try {
            const attributes: Record<string, string | number> = {};
            if (end.model) attributes[ATTR_RESPONSE_MODEL] = end.model;
            if (typeof end.costUsd === "number") attributes[ATTR_TOTAL_COST] = end.costUsd;
            if (end.info?.runtime) attributes[ATTR_PROVIDER] = end.info.runtime;
            if (spanInput) attributes[ATTR_SPAN_INPUT] = JSON.stringify(spanInput);
            if (Object.keys(attributes).length > 0) span.setAttributes(attributes);
            if (end.error || end.outcome === "fail") span.setStatus({ code: STATUS_ERROR, ...(end.error ? { message: end.error } : {}) });
            Laminar.withSpan(span, () => Laminar.setSpanOutput(output));
          } finally {
            span.end();
          }
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

  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const PAGE = 100;
  /** A pull is bounded: a dataset larger than this is cut, with a warning. */
  const MAX_PULL = 10_000;
  const MAX_PAGES = 400;

  /** The datasets mirror the repo's cases; a failure is a warning and an empty answer, never a throw. */
  const datasets = {
    push: async (name: string, datapoints: Datapoint[]): Promise<{ pushed: number }> => {
      let pushed = 0;
      await safe(`could not push the dataset ${name}`, async () => {
        if (datapoints.length === 0) return;
        await client.datasets.push({ name, createDataset: true, points: datapoints.map((d) => ({ data: d.data, ...(d.target ? { target: d.target } : {}), ...(d.metadata ? { metadata: d.metadata } : {}), taskId: d.taskId })) });
        pushed = datapoints.length;
      });
      return { pushed };
    },
    pull: async (name: string, pullOptions: { limit?: number } = {}): Promise<Datapoint[]> => {
      const found: Datapoint[] = [];
      await safe(`could not pull the dataset ${name}`, async () => {
        const wanted = Math.min(pullOptions.limit ?? MAX_PULL, MAX_PULL);
        for (let offset = 0, pages = 0; found.length < wanted; offset += PAGE, pages++) {
          if (pages >= MAX_PAGES) {
            warn(`laminar: the dataset ${name} was cut at ${MAX_PAGES} pages`);
            break;
          }
          const page = await client.datasets.pull({ name, limit: Math.min(PAGE, wanted - found.length), offset });
          for (const item of page.items) {
            if (!isRecord(item.data) || typeof item.taskId !== "string") continue;
            found.push({ ...(item.id ? { id: item.id } : {}), taskId: item.taskId, data: item.data, ...(isRecord(item.target) ? { target: item.target } : {}), ...(item.metadata ? { metadata: item.metadata } : {}) });
          }
          if (page.items.length === 0 || offset + PAGE >= page.totalCount) break;
        }
        if (found.length >= MAX_PULL && pullOptions.limit === undefined) warn(`laminar: the dataset ${name} was cut at ${MAX_PULL} datapoints`);
      });
      return found;
    },
  };

  /** Labeling queues are reached over HTTP (`/v1/labeling_queues/<id>/items`), as the SDK has no resource for them; the project key never leaves this file.
   *  A queue is made in Laminar's UI; it is named here by its id, or by its name where the instance can list queues. */
  const http = options.fetch ?? fetch;
  const QUEUE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const queueUrl = `${options.baseUrl}:${options.httpPort}/v1/labeling_queues`;
  const headers = { Authorization: `Bearer ${options.projectApiKey}`, "Content-Type": "application/json", Accept: "application/json" };
  const queue = {
    push: async (name: string, items: QueueItem[]): Promise<{ pushed: number }> => {
      let pushed = 0;
      await safe(`could not queue items for ${name}`, async () => {
        if (items.length === 0) return;
        // A queue's id (the UUID in its page address) goes straight to its items route. A name needs the list route, which a
        // self-hosted Laminar does not have: it answers 404, and the id is what to pass.
        let id: string | null = QUEUE_ID.test(name) ? name : null;
        if (id === null) {
          const listed = await http(queueUrl, { headers });
          if (listed.status === 404) throw new Error(`this Laminar cannot list queues by name: pass the queue's id (the UUID in its page address) instead of ${name}`);
          if (!listed.ok) throw new Error(`listing queues answered ${listed.status}`);
          const body = (await listed.json()) as unknown;
          const rows: unknown[] = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.items) ? body.items : [];
          const found = rows.find((row) => isRecord(row) && row.name === name);
          id = isRecord(found) && typeof found.id === "string" ? found.id : null;
        }
        if (id === null) throw new Error(`no labeling queue named ${name}: create it in Laminar first`);
        const sent = await http(`${queueUrl}/${encodeURIComponent(id)}/items`, { method: "POST", headers, body: JSON.stringify({ items: items.map((i) => ({ data: i.data, target: i.target ?? {}, ...(i.metadata ? { metadata: i.metadata } : {}), idempotencyKey: i.idempotencyKey })) }) });
        if (!sent.ok) throw new Error(`queueing answered ${sent.status}`);
        pushed = items.length;
      });
      return { pushed };
    },
  };

  return { mode: options.mode, datasets, queue, run, evaluation, flush: () => safe("flush failed", () => Laminar.flush()) };
}
