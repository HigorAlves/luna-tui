import { describe, expect, it } from "vitest";

import { BrainError } from "../../application/brain.ts";
import { omnigraphClient } from "./client.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}
type Answer = { status?: number; json?: unknown; text?: string; throws?: Error; hang?: true };

/** A fetch that answers from one answer and records every call; `hang` waits for the abort signal. */
function wire(answer: Answer, options: { timeoutMs?: { read?: number; load?: number } } = {}) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
    if (answer.throws) throw answer.throws;
    if (answer.hang) {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    const status = answer.status ?? 200;
    const text = answer.text ?? JSON.stringify(answer.json ?? {});
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  }) as unknown as typeof fetch;
  const client = omnigraphClient({ baseUrl: "http://127.0.0.1:8080/", graph: "luna", fetch: fetchFake, ...options });
  return { client, calls };
}

const TOKEN = "s3cret-token-value";
const rows = [
  { type: "Repo" as const, data: { slug: "repo:a", name: "a" } },
  { edge: "CardInRepo" as const, from: "card:1", to: "repo:a" },
];

describe("omnigraphClient", () => {
  it("loads NDJSON with the token, the contract header and the mode in the url", async () => {
    const { client, calls } = wire({ json: { total_entities: 2, commit: { graph_commit_id: "hb1x" } } });
    await expect(client.load(TOKEN, rows, "merge")).resolves.toEqual({ entities: 2, commit: "hb1x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/graphs/luna/load/ndjson?mode=merge");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "omnigraph-http-api": "0.14", "content-type": "application/x-ndjson" });
    expect(calls[0]!.body).toBe(`${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1])}\n`);
  });

  it("answers a load without a commit as null", async () => {
    const { client } = wire({ json: { total_entities: 0, commit: null } });
    await expect(client.load(TOKEN, [], "append")).resolves.toEqual({ entities: 0, commit: null });
  });

  it("invokes a stored query with params as json, or null without", async () => {
    const answer = { query_name: "card_lookup", row_count: 1, columns: ["card", "title"], rows: [{ card: "card:1" }] };
    const { client, calls } = wire({ json: answer });
    await expect(client.invoke(TOKEN, "card_lookup", { card: "card:1" })).resolves.toEqual({ columns: ["card", "title"], rows: [{ card: "card:1" }] });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/graphs/luna/queries/card_lookup");
    expect(calls[0]!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "omnigraph-http-api": "0.14", "content-type": "application/json" });
    expect(calls[0]!.body).toBe('{"params":{"card":"card:1"}}');
    await client.invoke(TOKEN, "agents_without_owner", undefined);
    expect(calls[1]!.body).toBe("null");
  });

  it("reads health without a token", async () => {
    const { client, calls } = wire({ json: { status: "ok", version: "0.15.0" } });
    await expect(client.health()).resolves.toEqual({ ok: true, version: "0.15.0" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/healthz");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    [409, "conflict", "none"],
    [403, "forbidden", "none"],
    [400, "api_contract_mismatch", "none"],
    [400, "bad_request", "unknown"],
  ] as const)("turns a %i %s into a BrainError with the server's code, status and effects", async (status, code, effects) => {
    const { client } = wire({ status, json: { error: `refused ${TOKEN}`, code, disposition: { effects, action: "refresh" } } });
    const error = await client.load(TOKEN, rows, "append").catch((caught) => caught);
    expect(error).toBeInstanceOf(BrainError);
    expect(error).toMatchObject({ code, status, effects });
    expect(error.message).not.toContain(TOKEN);
  });

  it("turns a non-JSON error body into http_<status>", async () => {
    const { client } = wire({ status: 502, text: "<html>bad gateway</html>" });
    const error = await client.invoke(TOKEN, "card_lookup", { card: "x" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(BrainError);
    expect(error).toMatchObject({ code: "http_502", status: 502 });
  });

  it("makes a timed-out load an unknown outcome and never retries it", async () => {
    const { client, calls } = wire({ hang: true }, { timeoutMs: { load: 20 } });
    const error = await client.load(TOKEN, rows, "merge").catch((caught) => caught);
    expect(error).toBeInstanceOf(BrainError);
    expect(error).toMatchObject({ code: "unknown_outcome", effects: "unknown" });
    expect(error.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it("makes a dropped connection during a load an unknown outcome", async () => {
    const { client, calls } = wire({ throws: new TypeError(`fetch failed for ${TOKEN}`) });
    const error = await client.load(TOKEN, rows, "merge").catch((caught) => caught);
    expect(error).toMatchObject({ code: "unknown_outcome", effects: "unknown" });
    expect(error.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it("makes a failed read a BrainError with no effects", async () => {
    const { client } = wire({ throws: new TypeError("fetch failed") });
    const error = await client.invoke(TOKEN, "card_lookup", { card: "x" }).catch((caught) => caught);
    expect(error).toMatchObject({ code: "unreachable", effects: "none" });
  });
  it("sends a write of the adapter's own to /mutate, and never retries it", async () => {
    const { client, calls } = wire({ json: { affected_nodes: 1, affected_edges: 3 } });
    await expect(client.mutate("tok", "query unlink($from: String) { delete CardInRepo where from = $from }", { from: "card:1" })).resolves.toEqual({ nodes: 1, edges: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8080/graphs/luna/mutate");
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer tok", "omnigraph-http-api": "0.14", "content-type": "application/json" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ query: "query unlink($from: String) { delete CardInRepo where from = $from }", params: { from: "card:1" } });
    const hung = wire({ hang: true }, { timeoutMs: { load: 20 } });
    await expect(hung.client.mutate("tok", "query wipe() { delete Card where slug != \"\" }", {})).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(hung.calls).toHaveLength(1);
  });
});
