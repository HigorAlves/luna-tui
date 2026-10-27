// The `luna` MCP server the stage agent talks to: a progress label, the slice ledger and
// the settled decisions. Served in-process by the runner, so the ledger is a file the
// runner owns (/out/ledger.json) and every call is also an event the machine ingests.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Ledger, LedgerSlice, StageInput } from "@hardness/contracts";
import { writeFileSync } from "node:fs";
import { z } from "zod";

export interface LunaEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export interface LunaState {
  ledger: Ledger;
  events: LunaEvent[];
}

const STATUS = z.enum(["pending", "red", "green", "committed", "escalated"]);
const SLICE_EVENT: Record<LedgerSlice["status"], string | null> = {
  pending: null,
  red: "slice.red",
  green: "slice.green",
  committed: "slice.committed",
  escalated: "escalation",
};

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

export interface LunaToolsOptions {
  /** Where the ledger is written after every change. */
  ledgerPath: string;
  /** The ledger a resumed run starts from, when the machine passed one. */
  ledger?: Ledger | null;
  decisions: StageInput["decisions"];
  /** Called with each progress label, so the transcript shows it. */
  onStep?: (label: string, n: number, of: number) => void;
}

/** The server config for `mcpServers.luna`, plus the state the runner reads at the end. */
export function lunaTools(options: LunaToolsOptions) {
  const state: LunaState = { ledger: options.ledger ?? { schema: 1, slices: [] }, events: [] };
  const persist = () => writeFileSync(options.ledgerPath, JSON.stringify(state.ledger, null, 2) + "\n");
  const note = (kind: string, payload: Record<string, unknown>) => state.events.push({ kind, payload });

  const server = createSdkMcpServer({
    name: "luna",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "step",
        "Report the current step of your work for the board's progress view, e.g. { label: 'writing failing test', n: 2, of: 5 }. A label, not a gate.",
        { label: z.string().max(80), n: z.number().int().min(0).optional(), of: z.number().int().min(0).optional() },
        async ({ label, n = 0, of = 0 }) => {
          note("step", { label, n, of });
          options.onStep?.(label, n, of);
          return text("ok");
        },
      ),
      tool(
        "slice_init",
        "Install the slice ledger from the plan: one row per slice, in order. Replaces an empty ledger; refuses to replace one that already has rows.",
        { slices: z.array(z.object({ id: z.number().int(), title: z.string(), estLoc: z.number().int().nullable().optional() })).min(1) },
        async ({ slices }) => {
          if (state.ledger.slices.length > 0) return text({ error: "the ledger already exists; use slice_list and slice_set" });
          state.ledger = {
            schema: 1,
            slices: slices.map((s) => ({ id: s.id, title: s.title, status: "pending", commit: null, estLoc: s.estLoc ?? null, actualLoc: null, note: null })),
          };
          persist();
          note("ledger.init", { total: state.ledger.slices.length });
          return text(state.ledger);
        },
      ),
      tool(
        "slice_set",
        "Set a slice's status (pending | red | green | committed | escalated), with the commit sha once committed, the actual LOC, or a note.",
        {
          id: z.number().int(),
          status: STATUS,
          commit: z.string().nullable().optional(),
          actualLoc: z.number().int().nullable().optional(),
          note: z.string().nullable().optional(),
        },
        async ({ id, status, commit, actualLoc, note: sliceNote }) => {
          const slice = state.ledger.slices.find((s) => s.id === id);
          if (!slice) return text({ error: `no slice ${id}; call slice_list` });
          slice.status = status;
          if (commit !== undefined) slice.commit = commit;
          if (actualLoc !== undefined) slice.actualLoc = actualLoc;
          if (sliceNote !== undefined) slice.note = sliceNote;
          persist();
          const kind = SLICE_EVENT[status];
          if (kind) note(kind, { id: slice.id, title: slice.title, commit: slice.commit });
          return text(slice);
        },
      ),
      tool("slice_list", "The slice ledger as it stands.", {}, async () => text(state.ledger)),
      tool(
        "decision_get",
        "A decision already settled for this task (by key, e.g. 'driver'), from the stage input's decisions; empty when nothing was settled.",
        { key: z.string() },
        async ({ key }) => {
          const hits = options.decisions.filter((d) => d.decision === key || key in (d.answers ?? {}));
          return text(hits.length > 0 ? hits : { decided: null });
        },
      ),
    ],
  });
  return { server, state };
}
