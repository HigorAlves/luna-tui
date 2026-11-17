// A thin HTTP client for omnigraph-server (RFC 0010) over an injected `fetch`. It speaks the
// server's contract version, turns every refusal into a BrainError and never retries a write: a
// load that timed out or lost its connection may have landed, so that is `unknown_outcome`.
// A token goes into a header only; no error message carries one.
import type { BrainRow } from "@hardness/contracts";

import { BrainError, type BrainLoadMode, type BrainValue } from "../../application/brain.ts";

/** The contract version the server must be asked in; any other value is a 400. */
const API_VERSION = "0.14";
const READ_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 60_000;

export interface OmnigraphClientOptions {
  baseUrl: string;
  graph: string;
  /** Tests pass a fake. */
  fetch?: typeof fetch;
  timeoutMs?: { read?: number; load?: number };
}

export interface OmnigraphClient {
  health(): Promise<{ ok: boolean; version: string | null }>;
  load(token: string, rows: BrainRow[], mode: BrainLoadMode): Promise<{ entities: number; commit: string | null }>;
  invoke(token: string, name: string, params: Record<string, string | number> | undefined): Promise<{ columns: string[]; rows: Array<Record<string, BrainValue>> }>;
  /** A write written here, not stored: the adapter's own deletes. Never text from a caller. */
  mutate(token: string, query: string, params: Record<string, string | number>): Promise<{ nodes: number; edges: number }>;
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  disposition?: { effects?: unknown };
}

/** The server's refusal as a BrainError; its own message is kept, cut short and with the token taken out in case it echoes one. */
async function refusal(response: { status: number; text(): Promise<string> }, token: string): Promise<BrainError> {
  let body: ErrorBody | null = null;
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (parsed && typeof parsed === "object") body = parsed as ErrorBody;
  } catch {
    body = null;
  }
  const code = typeof body?.code === "string" ? body.code : `http_${response.status}`;
  const said = typeof body?.error === "string" ? body.error.slice(0, 200) : `omnigraph answered ${response.status}`;
  const message = token ? said.split(token).join("[token]") : said;
  const effects = body?.disposition?.effects === "unknown" ? "unknown" : "none";
  return new BrainError(message, code, response.status, effects);
}

export function omnigraphClient(options: OmnigraphClientOptions): OmnigraphClient {
  const doFetch = options.fetch ?? fetch;
  const root = options.baseUrl.replace(/\/+$/, "");
  const base = `${root}/graphs/${encodeURIComponent(options.graph)}`;
  const readMs = options.timeoutMs?.read ?? READ_TIMEOUT_MS;
  const loadMs = options.timeoutMs?.load ?? LOAD_TIMEOUT_MS;

  async function send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, ms: number, write: boolean) {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (error) {
      // The cause is left out: it may name the url or a header.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (write) throw new BrainError(timedOut ? "the write timed out; it may have landed" : "the connection dropped during the write; it may have landed", "unknown_outcome", null, "unknown");
      throw new BrainError(timedOut ? "omnigraph did not answer in time" : "omnigraph is unreachable", timedOut ? "timeout" : "unreachable");
    }
  }

  const authed = (token: string, contentType: string) => ({ authorization: `Bearer ${token}`, "omnigraph-http-api": API_VERSION, "content-type": contentType });

  return {
    async health() {
      const response = await send(`${root}/healthz`, { method: "GET", headers: {} }, readMs, false);
      if (!response.ok) throw await refusal(response, "");
      const body = JSON.parse(await response.text()) as { status?: unknown; version?: unknown };
      return { ok: body.status === "ok", version: typeof body.version === "string" ? body.version : null };
    },

    async load(token, rows, mode) {
      const body = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
      const response = await send(`${base}/load/ndjson?mode=${mode}`, { method: "POST", headers: authed(token, "application/x-ndjson"), body }, loadMs, true);
      if (!response.ok) throw await refusal(response, token);
      const answer = JSON.parse(await response.text()) as { total_entities?: unknown; commit?: { graph_commit_id?: unknown } | null };
      return {
        entities: typeof answer.total_entities === "number" ? answer.total_entities : 0,
        commit: typeof answer.commit?.graph_commit_id === "string" ? answer.commit.graph_commit_id : null,
      };
    },

    async invoke(token, name, params) {
      const body = JSON.stringify(params && Object.keys(params).length > 0 ? { params } : null);
      const response = await send(`${base}/queries/${encodeURIComponent(name)}`, { method: "POST", headers: authed(token, "application/json"), body }, readMs, false);
      if (!response.ok) throw await refusal(response, token);
      const answer = JSON.parse(await response.text()) as { columns?: unknown; rows?: unknown };
      return {
        columns: Array.isArray(answer.columns) ? answer.columns.filter((column): column is string => typeof column === "string") : [],
        rows: Array.isArray(answer.rows) ? (answer.rows as Array<Record<string, BrainValue>>) : [],
      };
    },

    async mutate(token, query, params) {
      const response = await send(`${base}/mutate`, { method: "POST", headers: authed(token, "application/json"), body: JSON.stringify({ query, params }) }, loadMs, true);
      if (!response.ok) throw await refusal(response, token);
      const answer = JSON.parse(await response.text()) as { affected_nodes?: unknown; affected_edges?: unknown };
      return { nodes: typeof answer.affected_nodes === "number" ? answer.affected_nodes : 0, edges: typeof answer.affected_edges === "number" ? answer.affected_edges : 0 };
    },
  };
}
