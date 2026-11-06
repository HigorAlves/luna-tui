// A typed client of Cognee's REST API (RFC 0007), for the one machine user the machine registers at boot. It speaks only what the
// pinned image answers (RFC 0007, "Implementation notes (M0)"), with a timeout on every call (recall's is 2 s), a re-login on a 401,
// and errors that carry the status and a short, scrubbed body: never the token, never the password.
import { createHash } from "node:crypto";

export interface CogneeClientOptions {
  /** `http://127.0.0.1:8010`, no path. */
  baseUrl: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  /** The default per-call timeout; a call may pass its own. */
  timeoutMs?: number;
}

/** A failed call: the status (null when none came back) and a short body with every secret removed. */
export class CogneeError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "CogneeError";
  }
}

export interface CogneeDataset {
  id: string;
  name: string;
}

export interface CogneeDataItem {
  id: string;
  name: string;
  /** The `luna_id` the machine added the item with; null for an item added elsewhere (the UI). */
  lunaId: string | null;
  contentHash: string | null;
}

export interface CogneeAddItem {
  /** The id the machine gave the item (`external_metadata.luna_id`). */
  lunaId: string;
  /** Raw text, or a path the server may read (the code graph's). */
  text?: string;
  /** A file to upload. */
  file?: { name: string; content: Buffer; type?: string };
}

export interface CogneeAdded {
  datasetId: string;
  datasetName: string;
  /** One data id per item, in the order sent. */
  dataIds: string[];
}

export interface CogneeChunkHit {
  /** 0 to 1, higher is closer (Cognee reports a distance; it is turned around here). */
  score: number;
  text: string;
  /** The data item the chunk belongs to. */
  dataId: string | null;
  lunaId: string | null;
}

export interface CogneeSearchEntry {
  datasetId: string | null;
  datasetName: string | null;
  /** Set for a dataset Cognee could not search (no graph yet); the hits are then empty. */
  error: string | null;
  hits: CogneeChunkHit[];
}

export interface CogneeCodeResult {
  datasetName: string | null;
  error: string | null;
  results: unknown;
}

export interface CogneeClient {
  /** Registers the machine user (an existing one is fine) and logs in. Throws when Cognee cannot be reached or refuses. */
  connect(): Promise<void>;
  health(timeoutMs?: number): Promise<boolean>;
  add(input: { dataset: string; items: CogneeAddItem[] }): Promise<CogneeAdded>;
  cognify(datasets: string[], timeoutMs?: number): Promise<void>;
  /** `CHUNKS` search with no model call: the chunks of each named dataset that match, closest first. */
  chunks(input: { datasets: string[]; query: string; topK: number; timeoutMs?: number }): Promise<CogneeSearchEntry[]>;
  /** A code graph read (`SearchType.CODE`). */
  code(input: { dataset: string; operation: string; args: Record<string, unknown>; timeoutMs?: number }): Promise<CogneeCodeResult[]>;
  /** `GRAPH_COMPLETION`: an answer written by Cognee's model; needs its key. */
  complete(input: { datasets: string[]; query: string; timeoutMs?: number }): Promise<string | null>;
  datasets(timeoutMs?: number): Promise<CogneeDataset[]>;
  data(datasetId: string, timeoutMs?: number): Promise<CogneeDataItem[]>;
  deleteData(datasetId: string, dataId: string): Promise<void>;
  /** The raw `GET /sessions/cost-by-model` body, or null when Cognee has none to give. */
  cost(range?: "24h" | "7d" | "30d" | "all"): Promise<unknown | null>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Cognee builds a graph with a model call per chunk: a `cognify` may run for minutes. */
export const COGNIFY_TIMEOUT_MS = 15 * 60_000;
export const PAGE = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The `luna_id` in Cognee's `external_metadata`, which is an object on a data item and a JSON string on a search payload. */
function lunaIdOf(meta: unknown): string | null {
  let value = meta;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) ? str(value.luna_id) : null;
}

/** Cognee reports a distance (0 is identical); a score is 1 minus it, held to 0..1. */
const similarity = (distance: unknown): number => (typeof distance === "number" && Number.isFinite(distance) ? Math.max(0, Math.min(1, 1 - distance)) : 0);

export function cogneeClient(options: CogneeClientOptions): CogneeClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let token: string | null = null;

  /** Text that may carry the token or the password, with both taken out. */
  const scrub = (text: string): string => {
    let out = text;
    for (const secret of [token, options.password]) if (secret && secret.length >= 4) out = out.split(secret).join("***");
    return out.replace(/\s+/g, " ").slice(0, 300);
  };

  async function send(method: string, path: string, init: { json?: unknown; form?: URLSearchParams; multipart?: FormData; bearer?: boolean; timeoutMs?: number }): Promise<Response> {
    const headers: Record<string, string> = {};
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    } else if (init.multipart) {
      body = init.multipart;
    }
    if (init.bearer !== false && token) headers.authorization = `Bearer ${token}`;
    try {
      return await doFetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(init.timeoutMs ?? defaultTimeout) });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new CogneeError(timedOut ? `cognee ${method} ${path} timed out` : `cognee ${method} ${path} failed: ${scrub(error instanceof Error ? error.message : String(error))}`, null, timedOut);
    }
  }

  async function login(): Promise<void> {
    const response = await send("POST", "/api/v1/auth/login", { form: new URLSearchParams({ username: options.email, password: options.password }), bearer: false });
    if (!response.ok) throw new CogneeError(`cognee login failed (${response.status}): ${scrub(await response.text())}`, response.status);
    const parsed = (await response.json().catch(() => null)) as unknown;
    const value = isRecord(parsed) ? str(parsed.access_token) : null;
    if (!value) throw new CogneeError("cognee login answered without an access token", response.status);
    token = value;
  }

  /** One authenticated call: logs in first when there is no token, and once more after a 401. */
  async function call(method: string, path: string, init: { json?: unknown; multipart?: () => FormData; timeoutMs?: number } = {}): Promise<Response> {
    if (!token) await login();
    const once = () => send(method, path, { ...(init.json !== undefined ? { json: init.json } : {}), ...(init.multipart ? { multipart: init.multipart() } : {}), ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}) });
    let response = await once();
    if (response.status === 401) {
      await response.text().catch(() => "");
      await login();
      response = await once();
    }
    return response;
  }

  async function json(method: string, path: string, init: { json?: unknown; multipart?: () => FormData; timeoutMs?: number } = {}): Promise<unknown> {
    const response = await call(method, path, init);
    if (!response.ok) throw new CogneeError(`cognee ${method} ${path} answered ${response.status}: ${scrub(await response.text())}`, response.status);
    const text = await response.text();
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CogneeError(`cognee ${method} ${path} answered something that is not JSON`, response.status);
    }
  }

  return {
    async connect() {
      const registered = await send("POST", "/api/v1/auth/register", { json: { email: options.email, password: options.password }, bearer: false });
      if (!registered.ok) {
        const body = await registered.text();
        // An existing user is the normal case after the first boot.
        if (!(registered.status === 400 && body.includes("REGISTER_USER_ALREADY_EXISTS"))) throw new CogneeError(`cognee register failed (${registered.status}): ${scrub(body)}`, registered.status);
      } else await registered.text().catch(() => "");
      await login();
    },

    async health(timeoutMs = 3000) {
      try {
        const response = await send("GET", "/health", { bearer: false, timeoutMs });
        await response.text().catch(() => "");
        return response.ok;
      } catch {
        return false;
      }
    },

    async add({ dataset, items }) {
      const form = (): FormData => {
        const data = new FormData();
        data.set("datasetName", dataset);
        for (const item of items) {
          if (item.file) data.append("data", new Blob([new Uint8Array(item.file.content)], { type: item.file.type ?? "application/octet-stream" }), item.file.name);
          else data.append("raw_data", item.text ?? "");
        }
        data.set("external_metadata", JSON.stringify(items.map((item) => ({ luna_id: item.lunaId }))));
        return data;
      };
      const body = await json("POST", "/api/v1/add", { multipart: form });
      const record = isRecord(body) ? body : {};
      const dataIds = Array.isArray(record.data_ids) ? record.data_ids.filter((id): id is string => typeof id === "string") : [];
      const datasetId = str(record.dataset_id);
      if (!datasetId || dataIds.length !== items.length) throw new CogneeError(`cognee /add answered ${dataIds.length} data ids for ${items.length} items`, 200);
      return { datasetId, datasetName: str(record.dataset_name) ?? dataset, dataIds };
    },

    async cognify(datasets, timeoutMs = COGNIFY_TIMEOUT_MS) {
      const body = await json("POST", "/api/v1/cognify", { json: { datasets, runInBackground: false }, timeoutMs });
      // A failed pipeline answers 200 with a status per dataset.
      if (isRecord(body)) {
        for (const run of Object.values(body)) {
          const status = isRecord(run) ? str(run.status) : null;
          if (status !== null && /error|fail/i.test(status)) throw new CogneeError(`cognee cognify ended ${scrub(status)}`, 200);
        }
      }
    },

    async chunks({ datasets, query, topK, timeoutMs }) {
      const body = await json("POST", "/api/v1/search", {
        json: { searchType: "CHUNKS", datasets, query, topK, onlyContext: true, verbose: true },
        timeoutMs: timeoutMs ?? defaultTimeout,
      });
      const entries = Array.isArray(body) ? body : [];
      return entries.filter(isRecord).map((entry): CogneeSearchEntry => {
        const error = str(entry.error) ?? (isRecord(entry.error) ? str(entry.error.message) ?? "search failed" : null);
        const objects = Array.isArray(entry.objects_result) ? entry.objects_result : [];
        const hits = objects.filter(isRecord).flatMap((object): CogneeChunkHit[] => {
          const payload = isRecord(object.payload) ? object.payload : null;
          const text = payload ? str(payload.text) : null;
          if (!payload || text === null) return [];
          return [{ score: similarity(object.score), text, dataId: str(payload.document_id), lunaId: lunaIdOf(payload.external_metadata) }];
        });
        return { datasetId: str(entry.dataset_id), datasetName: str(entry.dataset_name), error, hits: error ? [] : hits };
      });
    },

    async code({ dataset, operation, args, timeoutMs }) {
      const body = await json("POST", "/api/v1/search", {
        json: { searchType: "CODE", datasets: [dataset], query: typeof args.query === "string" ? args.query : operation, topK: 15, codeQuery: { operation, ...args } },
        timeoutMs: timeoutMs ?? defaultTimeout,
      });
      const entries = Array.isArray(body) ? body : [];
      return entries.filter(isRecord).map((entry) => ({ datasetName: str(entry.dataset_name), error: str(entry.error), results: entry.search_result ?? null }));
    },

    async complete({ datasets, query, timeoutMs }) {
      const body = await json("POST", "/api/v1/search", { json: { searchType: "GRAPH_COMPLETION", datasets, query, topK: 15 }, timeoutMs: timeoutMs ?? 120_000 });
      const texts = (Array.isArray(body) ? body : []).filter(isRecord).flatMap((entry) => {
        const result = entry.search_result;
        if (typeof result === "string") return [result];
        if (Array.isArray(result)) return result.filter((r): r is string => typeof r === "string");
        return [];
      });
      return texts.length === 0 ? null : texts.join("\n\n");
    },

    async datasets(timeoutMs) {
      const body = await json("GET", "/api/v1/datasets", timeoutMs === undefined ? {} : { timeoutMs });
      return (Array.isArray(body) ? body : []).filter(isRecord).flatMap((d) => {
        const id = str(d.id);
        const name = str(d.name);
        return id && name ? [{ id, name }] : [];
      });
    },

    async data(datasetId, timeoutMs) {
      const out: CogneeDataItem[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const body = await json("GET", `/api/v1/datasets/${encodeURIComponent(datasetId)}/data?limit=${PAGE}&offset=${offset}`, timeoutMs === undefined ? {} : { timeoutMs });
        const page = (Array.isArray(body) ? body : []).filter(isRecord);
        for (const item of page) {
          const id = str(item.id);
          if (id) out.push({ id, name: str(item.name) ?? id, lunaId: lunaIdOf(item.externalMetadata), contentHash: str(item.contentHash) });
        }
        if (page.length < PAGE) return out;
      }
    },

    async deleteData(datasetId, dataId) {
      const response = await call("DELETE", `/api/v1/datasets/${encodeURIComponent(datasetId)}/data/${encodeURIComponent(dataId)}`);
      // Deleting is idempotent: an item that is already gone is a success.
      if (!response.ok && response.status !== 404) throw new CogneeError(`cognee DELETE data answered ${response.status}: ${scrub(await response.text())}`, response.status);
      await response.text().catch(() => "");
    },

    async cost(range = "24h") {
      try {
        return await json("GET", `/api/v1/sessions/cost-by-model?range=${range}`);
      } catch {
        return null;
      }
    },
  };
}

/** The MD5 of text, as Cognee records a data item's `content_hash`. */
export const md5 = (content: string | Buffer): string => createHash("md5").update(content).digest("hex");
