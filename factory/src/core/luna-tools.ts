// The luna tools in no runtime's words: a progress label, the slice ledger and the settled
// decisions, as a description and an input shape per tool plus one handler that keeps the state.
// The state lives in the factory process, because finish() reads it; each runtime serves the
// handlers its own way (Claude as an in-process MCP server, eve over a loopback call).
import type { Ledger, LedgerSlice, LunaTool, RunEvent, StageInput } from "@hardness/contracts";
import { writeFileSync } from "node:fs";
import { z } from "zod";

import type { Emit } from "./events.ts";

const STATUS = z.enum(["pending", "red", "green", "committed", "escalated"]);
const SLICE_EVENT: Record<LedgerSlice["status"], "slice.red" | "slice.green" | "slice.committed" | "escalation" | null> = {
  pending: null,
  red: "slice.red",
  green: "slice.green",
  committed: "slice.committed",
  escalated: "escalation",
};

/** What the model reads about each tool, and the input it must give. */
export const LUNA_TOOLS = {
  step: {
    description: "Report the current step of your work for the board's progress view, e.g. { label: 'writing failing test', n: 2, of: 5 }. A label, not a gate.",
    input: { label: z.string().max(80), n: z.number().int().min(0).optional(), of: z.number().int().min(0).optional() },
  },
  slice_init: {
    description: "Install the slice ledger from the plan: one row per slice, in order. Replaces an empty ledger; refuses to replace one that already has rows.",
    input: { slices: z.array(z.object({ id: z.number().int(), title: z.string(), estLoc: z.number().int().nullable().optional() })).min(1) },
  },
  slice_set: {
    description: "Set a slice's status (pending | red | green | committed | escalated), with the commit sha once committed, the actual LOC, or a note.",
    input: {
      id: z.number().int(),
      status: STATUS,
      commit: z.string().nullable().optional(),
      actualLoc: z.number().int().nullable().optional(),
      note: z.string().nullable().optional(),
    },
  },
  slice_list: { description: "The slice ledger as it stands.", input: {} },
  decision_get: {
    description: "A decision already settled for this task (by key, e.g. 'driver'), from the stage input's decisions; empty when nothing was settled.",
    input: { key: z.string() },
  },
} satisfies Record<LunaTool, { description: string; input: z.ZodRawShape }>;

type Args<T extends LunaTool> = z.infer<z.ZodObject<(typeof LUNA_TOOLS)[T]["input"]>>;

export interface LunaToolsOptions {
  /** Where the ledger is written after every change. */
  ledgerPath: string;
  /** The ledger a resumed run starts from, when the machine passed one. */
  ledger?: Ledger | null;
  decisions: StageInput["decisions"];
  /** Where every call's event goes: the run's event stream (a step is also a transcript line). */
  emit: Emit;
}

/** The handlers, by tool, and the state the runner reads at the end. `call` validates the input
 *  first, so a runtime that hands it raw JSON gets the same refusal a schema would give. */
export function lunaHandlers(options: LunaToolsOptions) {
  const state: { ledger: Ledger } = { ledger: options.ledger ?? { schema: 1, slices: [] } };
  const persist = () => writeFileSync(options.ledgerPath, JSON.stringify(state.ledger, null, 2) + "\n");
  const note = (event: RunEvent) => options.emit(event);

  const handlers: { [T in LunaTool]: (args: Args<T>) => unknown } = {
    step: ({ label, n = 0, of = 0 }) => {
      note({ kind: "step", payload: { label, n, of } });
      return "ok";
    },
    slice_init: ({ slices }) => {
      if (state.ledger.slices.length > 0) return { error: "the ledger already exists; use slice_list and slice_set" };
      state.ledger = {
        schema: 1,
        slices: slices.map((s) => ({ id: s.id, title: s.title, status: "pending", commit: null, estLoc: s.estLoc ?? null, actualLoc: null, note: null })),
      };
      persist();
      note({ kind: "ledger.init", payload: { total: state.ledger.slices.length } });
      return state.ledger;
    },
    slice_set: ({ id, status, commit, actualLoc, note: sliceNote }) => {
      const slice = state.ledger.slices.find((s) => s.id === id);
      if (!slice) return { error: `no slice ${id}; call slice_list` };
      slice.status = status;
      if (commit !== undefined) slice.commit = commit;
      if (actualLoc !== undefined) slice.actualLoc = actualLoc;
      if (sliceNote !== undefined) slice.note = sliceNote;
      persist();
      const kind = SLICE_EVENT[status];
      if (kind) note({ kind, payload: { id: slice.id, title: slice.title, commit: slice.commit } });
      return slice;
    },
    slice_list: () => state.ledger,
    decision_get: ({ key }) => {
      const hits = options.decisions.filter((d) => d.decision === key || key in (d.answers ?? {}));
      return hits.length > 0 ? hits : { decided: null };
    },
  };

  const call = async (tool: string, args: unknown): Promise<unknown> => {
    if (!(tool in LUNA_TOOLS)) return { error: `no luna tool ${tool}` };
    const name = tool as LunaTool;
    const parsed = z.object(LUNA_TOOLS[name].input).safeParse(args ?? {});
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ") };
    return (handlers[name] as (a: unknown) => unknown)(parsed.data);
  };

  return { state, handlers, call };
}
