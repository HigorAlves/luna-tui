// The luna tools in no runtime's words: a progress label, the slice ledger and the settled
// decisions, as a description and an input shape per tool plus one handler that keeps the state.
// The state lives in the factory process, because finish() reads it; each runtime serves the
// handlers its own way (Claude as an in-process MCP server, eve over a loopback call).
import type { Ledger, LedgerSlice, LunaTool, RunEvent, StageInput } from "@hardness/contracts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    description:
      "Set a slice's status (pending | red | green | committed | escalated), with the commit sha once committed, the actual LOC, or a note. A red needs a note: the failing output's last lines. The machine judges that red and the answer comes back as `check` ({ verdict, problems }); on flag or ask, rewrite the test before going green.",
    input: {
      id: z.number().int(),
      status: STATUS,
      commit: z.string().nullable().optional(),
      actualLoc: z.number().int().nullable().optional(),
      note: z.string().nullable().optional(),
    },
  },
  scope_check: {
    description:
      "Ask the machine to judge the scope of your change before you answer done: a summary of the diff and every file you changed outside the plan's touchpoints, each with its reason. Waits for the verdict; fix what it flags (one pass). A verdict of skipped means no one answered; go on.",
    input: { diffSummary: z.string(), outOfMap: z.array(z.object({ path: z.string(), reason: z.string() })) },
  },
  card_search: {
    description:
      "Search the cards of this repository (open ones and those closed in the last 90 days) for a topic, so you can say \"related to card X\". Read-only: returns at most 10 of { id, title, state, summary } and nothing from another repository. An empty list or a verdict of skipped means nothing matched or no one answered; go on.",
    input: { query: z.string().min(1).max(300) },
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
  /** The mailbox the machine answers the build checks in (`/out/checks`); absent, a check is skipped at once. */
  checksDir?: string;
  /** How long a check waits for its answer, in ms; 0 asks and does not wait. */
  checkWaitMs?: number;
}

const POLL_MS = 25;
const MIN_RED_NOTE = 20;
type CheckAnswer = { verdict: string; problems: string[]; [key: string]: unknown };
const SKIPPED: CheckAnswer = { verdict: "skipped", problems: [] };

/** Polls for a JSON answer file until `waitMs` has passed; a half-written file is retried. */
async function awaitAnswer(path: string, waitMs: number): Promise<CheckAnswer> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as CheckAnswer;
        if (parsed && typeof parsed === "object" && typeof parsed.verdict === "string") return { ...parsed, problems: Array.isArray(parsed.problems) ? parsed.problems : [] };
      } catch {
        // half-written: look again
      }
    }
    if (Date.now() >= until) return SKIPPED;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** The handlers, by tool, and the state the runner reads at the end. `call` validates the input
 *  first, so a runtime that hands it raw JSON gets the same refusal a schema would give. */
export function lunaHandlers(options: LunaToolsOptions) {
  const state: { ledger: Ledger } = { ledger: options.ledger ?? { schema: 1, slices: [] } };
  const persist = () => writeFileSync(options.ledgerPath, JSON.stringify(state.ledger, null, 2) + "\n");
  const note = (event: RunEvent) => options.emit(event);

  /** Waits for the machine's answer file in the mailbox. */
  const answerOf = async (file: string): Promise<CheckAnswer> => {
    if (!options.checksDir) return SKIPPED;
    const path = join(options.checksDir, file);
    return awaitAnswer(path, options.checkWaitMs ?? 0);
  };
  const clear = (file: string) => {
    if (options.checksDir) rmSync(join(options.checksDir, file), { force: true });
  };

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
    slice_set: async ({ id, status, commit, actualLoc, note: sliceNote }) => {
      const slice = state.ledger.slices.find((s) => s.id === id);
      if (!slice) return { error: `no slice ${id}; call slice_list` };
      if (status === "red" && (sliceNote ?? "").trim().length < MIN_RED_NOTE) {
        return { error: `a red slice needs a note of at least ${MIN_RED_NOTE} characters: the failing output's last lines` };
      }
      slice.status = status;
      if (commit !== undefined) slice.commit = commit;
      if (actualLoc !== undefined) slice.actualLoc = actualLoc;
      if (sliceNote !== undefined) slice.note = sliceNote;
      // An answer left by an earlier red of this slice is cleared before the machine can see the new one.
      if (status === "red") clear(`red-${id}.json`);
      persist();
      const kind = SLICE_EVENT[status];
      if (kind) note({ kind, payload: { id: slice.id, title: slice.title, commit: slice.commit } });
      if (status !== "red") return slice;
      // The machine judges the red from the ledger it just read; the answer is a file in the mailbox.
      return { ...slice, check: await answerOf(`red-${id}.json`) };
    },
    scope_check: async ({ diffSummary, outOfMap }) => {
      if (options.checksDir) {
        mkdirSync(options.checksDir, { recursive: true });
        clear("scope.json");
        writeFileSync(join(options.checksDir, "scope-request.json"), JSON.stringify({ diffSummary, outOfMap }, null, 2) + "\n");
      }
      return answerOf("scope.json");
    },
    card_search: async ({ query }) => {
      if (!options.checksDir) return SKIPPED;
      mkdirSync(options.checksDir, { recursive: true });
      clear("card-search.json");
      writeFileSync(join(options.checksDir, "card-search-request.json"), JSON.stringify({ query }) + "\n");
      return answerOf("card-search.json");
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
