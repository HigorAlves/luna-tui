// The telemetry port: what the machine says about each run to an observability backend, as typed
// calls. The Laminar adapter (adapters/laminar/) implements it; without a key the no-op below
// answers everything. Nothing here names a backend, and a stage container never sees one: the
// host knows every fact a span needs (the run row, the result, the transcript on disk).
import type { EngineId, PackId, RunInfo, TaskState } from "@hardness/contracts";

/** `MACHINE_TRACES`: nothing, the facts of each run, or the facts and the transcript. */
export type TracesMode = "off" | "metadata" | "full";

/** What is known about a run as it starts. */
export interface RunStart {
  /** A pipeline stage, a `POST /runs` call, or one replay-eval case. */
  kind: "stage" | "pack" | "eval";
  /** Null for a host-only stage (delivering, shipping). */
  pack: PackId | null;
  /** Null until the runner says which engine it started on (a stage's `started`). */
  engine: EngineId | null;
  /** Groups traces: the task id for its stage runs, the eval run's stamp for its cases. */
  sessionId?: string;
  taskId?: string;
  stage?: TaskState;
  attempt?: number;
  /** A pack run's caller (`X-Luna-Client`), or `eval`. */
  client?: string | null;
}

/** What a run came to. Never the answer nor a client's context: a summary at most (bar `input`/`output` below). */
export interface RunEnd {
  outcome: string;
  /** The run row's status (`passed`, `failed`, `paused`, `aborted`), when there is one. */
  status?: string;
  engine?: EngineId | null;
  error?: string | null;
  summary?: string | null;
  repo?: string | null;
  model?: string | null;
  turns?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  /** The result's `run`: runtime, pinned model, SDK version, fingerprint (RFC 0003 §7). */
  info?: RunInfo | null;
  /** A decision pack call's context, and its answer with the verdicts: set only for the pipeline's own
   *  calls (never an HTTP client's), and put on the span only in `full` mode. */
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** The transcript on the host. Read, and only in `full` mode, by the adapter; never by callers. */
  transcriptPath?: string | null;
}

export interface RunSpan {
  /** Something that happened mid-run: an engine fallback, the container starting, a usage limit, an escalation. */
  event(name: string, payload?: Record<string, unknown>): void;
  /** The backend's trace id for this run, once started; null when nothing is traced. */
  traceId(): string | null;
  /** What a child process (the stage container) needs in its environment to continue this run's
   *  trace: the backend's address and key and the serialized parent span. Empty when nothing is traced. */
  childEnv(): Record<string, string>;
  /** Ends the span. Resolves once the backend has what it needs from disk (the transcript), so a
   *  caller may remove the run folder after awaiting it. Never rejects. */
  end(result: RunEnd): Promise<void>;
}

export interface EvaluationStart {
  name: string;
  /** Evaluations in one group compare in the UI: the pack. */
  groupName: string;
  metadata?: Record<string, unknown>;
}

/** One graded case of a replay eval. */
export interface EvaluationCase {
  id: string;
  index: number;
  /** What the case gave the pack (scrubbed, committed in evals/). */
  data: Record<string, unknown>;
  /** What a good answer must satisfy: the outcome, the checks, the rubric. */
  target?: Record<string, unknown>;
  /** The answer and how it graded. */
  output?: unknown;
  /** Each a number or null; `pass` is 1 or 0. */
  scores: Record<string, number | null>;
  /** The trace the case's run left (`RunSpan.traceId()`), or null. */
  traceId: string | null;
}

export interface Evaluation {
  /** The backend's id for it, or null when nothing is recorded. */
  readonly id: string | null;
  record(evalCase: EvaluationCase): Promise<void>;
  /** Flushes what is buffered. Never rejects. */
  finish(): Promise<void>;
}

export interface Telemetry {
  readonly mode: TracesMode;
  run(start: RunStart): RunSpan;
  evaluation(start: EvaluationStart): Promise<Evaluation>;
  /** Sends what is buffered; on shutdown. Never rejects. */
  flush(): Promise<void>;
}

const NO_SPAN: RunSpan = { event: () => {}, traceId: () => null, childEnv: () => ({}), end: () => Promise.resolve() };
const NO_EVALUATION: Evaluation = { id: null, record: () => Promise.resolve(), finish: () => Promise.resolve() };

/** The telemetry of a machine with no backend configured: every call answers, nothing is kept. */
export function noTelemetry(): Telemetry {
  return { mode: "off", run: () => NO_SPAN, evaluation: () => Promise.resolve(NO_EVALUATION), flush: () => Promise.resolve() };
}
