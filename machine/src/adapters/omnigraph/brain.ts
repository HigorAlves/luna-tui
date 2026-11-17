// The Brain port over omnigraph-server (RFC 0010): one token per role, rows cut to what the server
// accepts, and answers shaped so a reader can rely on their keys. A read never throws.
import { BRAIN_EDGES, type BrainRow, brainTime } from "@hardness/contracts";

import { type Brain, type BrainAnswer, BrainError, type BrainValue } from "../../application/brain.ts";
import { BRAIN_LOAD_ORDER, brainBatches } from "../../domain/brain/batches.ts";
import type { OmnigraphClient } from "./client.ts";

export interface OmnigraphBrainOptions {
  client: OmnigraphClient;
  /** The facts and memories tokens write; the reader token only reads. */
  tokens: { facts: string; memories: string; reader: string };
}

// omnigraph's DateTime comes back without a zone; it is UTC.
const ZONELESS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function omnigraphBrain(options: OmnigraphBrainOptions): Brain {
  const { client, tokens } = options;
  const secrets = [tokens.facts, tokens.memories, tokens.reader].filter((token) => token.length > 0);
  const clean = (text: string): string => secrets.reduce((said, secret) => said.split(secret).join("[token]"), text).slice(0, 200);
  const failure = (error: unknown): string => (error instanceof BrainError ? `${error.code}: ${clean(error.message)}` : "the brain could not be reached");

  return {
    enabled: true,

    async health() {
      try {
        const { ok, version } = await client.health();
        return { ok, version, note: ok ? null : "the server is not ready" };
      } catch (error) {
        return { ok: false, version: null, note: failure(error) };
      }
    },

    async load(rows: BrainRow[], loadOptions = {}) {
      let one: BrainRow[][];
      try {
        one = brainBatches(rows);
      } catch (error) {
        throw new BrainError(error instanceof Error ? error.message : "the rows are too large for one load", "too_large");
      }
      if (one.length > 1) throw new BrainError("the rows exceed what one load accepts", "too_large");
      const token = loadOptions.actor === "memories" ? tokens.memories : tokens.facts;
      return client.load(token, rows, loadOptions.mode ?? "merge");
    },

    // The two deletes below are the only queries written outside brain/queries: an edge or a type name comes
    // from the contracts' tables, and a slug travels as a parameter, so no caller's text is in the query.
    async unlink(edge, from, to) {
      if (!(edge in BRAIN_EDGES)) throw new BrainError(`no edge named ${String(edge)}`, "bad_request");
      const removed =
        to === undefined
          ? await client.mutate(tokens.facts, `query unlink($from: String) { delete ${edge} where from = $from }`, { from })
          : await client.mutate(tokens.facts, `query unlink($from: String, $to: String) { delete ${edge} where from = $from and to = $to }`, { from, to });
      return removed.edges;
    },

    async reset() {
      // Deleting a node takes its edges with it. The most dependent type goes first, so no edge is left pointing at nothing.
      for (const type of [...BRAIN_LOAD_ORDER].reverse()) await client.mutate(tokens.facts, `query wipe() { delete ${type} where slug != "" }`, {});
    },

    async query(name, params): Promise<BrainAnswer> {
      try {
        const { columns, rows } = await client.invoke(tokens.reader, name, params);
        const shaped = rows.map((row) => {
          const out: Record<string, BrainValue> = {};
          for (const column of columns) out[column] = row[column] ?? null;
          for (const [key, value] of Object.entries(row)) out[key] ??= value;
          for (const [key, value] of Object.entries(out)) if (typeof value === "string" && ZONELESS.test(value)) out[key] = brainTime(`${value}Z`);
          return out;
        });
        return { rows: shaped, note: shaped.length === 0 ? `${name} found nothing` : null };
      } catch (error) {
        return { rows: [], note: failure(error) };
      }
    },
  };
}
