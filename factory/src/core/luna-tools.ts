// The luna tools in no runtime's words: a progress label, the slice ledger and the settled
// decisions, as a description and an input shape per tool plus one handler that keeps the state.
// The state lives in the factory process, because finish() reads it; each runtime serves the
// handlers its own way (Claude as an in-process MCP server, eve over a loopback call).
import type { BridgedTool, Ledger, LedgerSlice, LunaTool, RunEvent, StageInput } from "@hardness/contracts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { Emit } from "./events.ts";
import { helperTools, releaseOrphans } from "./helper-tools.ts";

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
      "Search the titles of this repository's cards (open ones and those closed in the last 90 days) for a topic, so you can say \"related to card X\". Read-only: returns at most 10 of { id, title, state }, only cards that came from the same source as this one (a GitHub card sees GitHub cards), and nothing from another repository; never a summary or a description. An empty list or a verdict of skipped means nothing matched or no one answered; go on.",
    input: { query: z.string().min(1).max(300) },
  },
  scenario_red: {
    description:
      "Report that the test you wrote for one scenario fails, with the failing output's last lines: { scenario: 'S1', output: '...' }. Call it once per scenario after running its test. The machine judges each report; a scenario with no report, or whose test fails for the wrong reason, comes back to you.",
    input: { scenario: z.string().min(1).max(40), output: z.string() },
  },
  slice_list: { description: "The slice ledger as it stands.", input: {} },
  slice_delegate: {
    description: "Hand one pending UI slice to the ui-designer, which builds it in its own container while you go on: { slice: 3, message: '...' }. Returns at once with the helper's handle and the files you must not touch, or the machine's refusal (then build the slice yourself).",
    input: { slice: z.number().int(), message: z.string().max(2000).optional() },
  },
  slice_wait: {
    description: "Wait for the ui-designer's slice: { slice: 3, waitSeconds: 120 }. Returns the helper's state after at most waitSeconds (240 at most); picks its commits onto your branch when it has returned.",
    input: { slice: z.number().int(), waitSeconds: z.number().int().min(1).max(240).optional() },
  },
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
  /** Called once a slice is recorded as committed: the run hands its commits to the machine here (core/bundles.ts). */
  onSliceCommitted?: () => void;
  /** The MCP tools the machine bridged for this run (RFC 0013); a call to one goes through the checks mailbox. Absent: none. */
  bridge?: BridgedTool[];
  /** The implementer's repository (`/work`): with `checksDir` it switches the ui-designer tools on (RFC 0013, phase 5). */
  work?: string;
  /** What the machine says about delegation for this run (`input.context.delegation`): when it is unavailable the helper tools answer at once with its reason. */
  delegation?: { available: boolean; reason?: string | undefined } | undefined;
  /** Writes the run's commits as a bundle for the machine now; the pick handshake sends it before it asks for the helper's. */
  bundleNow?: () => void;
}

const POLL_MS = 25;
const MIN_RED_NOTE = 20;
type CheckAnswer = { verdict: string; problems: string[]; [key: string]: unknown };
const SKIPPED: CheckAnswer = { verdict: "skipped", problems: [] };

/** Polls for a JSON answer file until `waitMs` has passed; a half-written file, or one `accept` refuses, is retried. */
async function awaitFile<T>(path: string, waitMs: number, accept: (parsed: unknown) => T | null, none: T): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        const answer = accept(JSON.parse(readFileSync(path, "utf8")));
        if (answer !== null) return answer;
      } catch {
        // half-written: look again
      }
    }
    if (Date.now() >= until) return none;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const awaitAnswer = (path: string, waitMs: number): Promise<CheckAnswer> =>
  awaitFile<CheckAnswer>(
    path,
    waitMs,
    (p) => {
      const parsed = p as CheckAnswer;
      return parsed && typeof parsed === "object" && typeof parsed.verdict === "string" ? { ...parsed, problems: Array.isArray(parsed.problems) ? parsed.problems : [] } : null;
    },
    SKIPPED,
  );

/** The luna names of the bridged tools a run was given. */
export const bridgeNames = (bridge: readonly BridgedTool[]): string[] => bridge.map((b) => b.name);

/** The handlers, by tool, and the state the runner reads at the end. `call` validates the input
 *  first, so a runtime that hands it raw JSON gets the same refusal a schema would give. */
export function lunaHandlers(options: LunaToolsOptions) {
  const state: { ledger: Ledger } = { ledger: releaseOrphans(options.ledger ?? { schema: 1, slices: [] }) };
  const persist = () => writeFileSync(options.ledgerPath, JSON.stringify(state.ledger, null, 2) + "\n");
  const note = (event: RunEvent) => options.emit(event);
  const helper = options.checksDir && options.work
    ? helperTools({ checksDir: options.checksDir, work: options.work, ledger: () => state.ledger, persist, emit: options.emit, bundleNow: options.bundleNow ?? (() => {}), checkWaitMs: options.checkWaitMs ?? 0 })
    : null;
  const refusal = options.delegation && !options.delegation.available ? { ok: false, error: options.delegation.reason ?? "delegation is not available in this run" } : null;
  /** A returned helper slice is picked before the tool answers; an error of the pick rides on the answer. */
  const picked = async <T>(result: () => T | Promise<T>): Promise<T | (T & { pickError: string })> => {
    const problem = (await helper?.syncPicks()) ?? null;
    const got = await result();
    return problem && got && typeof got === "object" ? { ...got, pickError: problem } : got;
  };

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
    slice_set: ({ id, status, commit, actualLoc, note: sliceNote }) => picked(async () => {
      const slice = state.ledger.slices.find((s) => s.id === id);
      if (!slice) return { error: `no slice ${id}; call slice_list` };
      if (slice.owner === "ui-designer") return { error: `slice ${id} is the ui-designer's; call slice_wait` };
      if (status === "red" && (sliceNote ?? "").trim().length < MIN_RED_NOTE) {
        return { error: `a red slice needs a note of at least ${MIN_RED_NOTE} characters: the failing output's last lines` };
      }
      slice.status = status;
      if (commit !== undefined) slice.commit = commit;
      if (actualLoc !== undefined) slice.actualLoc = actualLoc;
      if (sliceNote !== undefined) slice.note = sliceNote;
      // An answer left by an earlier red of this slice is cleared before the machine can see the new one.
      if (status === "red") clear(`red-${id}.json`);
      // The commits leave before the ledger says so: the machine reads the bundle once it sees the slice committed.
      if (status === "committed") options.onSliceCommitted?.();
      persist();
      const kind = SLICE_EVENT[status];
      if (kind) note({ kind, payload: { id: slice.id, title: slice.title, commit: slice.commit } });
      if (status !== "red") return slice;
      // The machine judges the red from the ledger it just read; the answer is a file in the mailbox.
      return { ...slice, check: await answerOf(`red-${id}.json`) };
    }),
    scope_check: ({ diffSummary, outOfMap }) => picked(async () => {
      const out = helper?.outstanding() ?? [];
      if (out.length > 0) return { verdict: "wait", problems: out.map((id) => `slice ${id} is with ui-designer; call slice_wait`) };
      if (options.checksDir) {
        mkdirSync(options.checksDir, { recursive: true });
        clear("scope.json");
        writeFileSync(join(options.checksDir, "scope-request.json"), JSON.stringify({ diffSummary, outOfMap }, null, 2) + "\n");
      }
      return answerOf("scope.json");
    }),
    card_search: async ({ query }) => {
      if (!options.checksDir) return SKIPPED;
      mkdirSync(options.checksDir, { recursive: true });
      clear("card-search.json");
      writeFileSync(join(options.checksDir, "card-search-request.json"), JSON.stringify({ query }) + "\n");
      return answerOf("card-search.json");
    },
    scenario_red: ({ scenario, output }) => {
      if (!options.checksDir) return { recorded: false };
      mkdirSync(options.checksDir, { recursive: true });
      const file = join(options.checksDir, "scenario-reds.json");
      let reds: Record<string, string> = {};
      try {
        reds = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
      } catch {
        // the first report, or a half-written file: start again
      }
      // The machine reads this file bounded (64 KB): an output is kept by its tail, and a report that would pass the bound is refused.
      const next = { ...reds, [scenario]: output.slice(-2000) };
      const text = JSON.stringify(next, null, 2) + "\n";
      if (Buffer.byteLength(text) > 60_000) return { recorded: false, error: "too many reports: the file would be too big for the machine to read" };
      writeFileSync(file, text);
      return { recorded: true };
    },
    slice_list: () => picked(() => state.ledger),
    slice_delegate: (args) => (refusal ?? (helper ? helper.delegate(args) : { error: "not available in this run" })),
    slice_wait: (args) => (refusal ?? (helper ? helper.wait(args) : { error: "not available in this run" })),
    decision_get: ({ key }) => {
      const hits = options.decisions.filter((d) => d.decision === key || key in (d.answers ?? {}));
      return hits.length > 0 ? hits : { decided: null };
    },
  };

  // A bridged tool (RFC 0013): the request is a file in the mailbox, the machine's answer another. The nonce keeps
  // an earlier run's leftovers out; the machine reads only the names this run was given.
  const nonce = randomBytes(4).toString("hex");
  let sent = 0;
  const bridged = async (b: BridgedTool, args: unknown): Promise<unknown> => {
    if (!options.checksDir) return { skipped: true };
    const n = ++sent;
    mkdirSync(options.checksDir, { recursive: true });
    note({ kind: "note", payload: { phase: "design.mcp_call", server: b.server, tool: b.tool, n } });
    writeFileSync(join(options.checksDir, `mcp-request-${nonce}-${n}.json`), JSON.stringify({ n, server: b.server, tool: b.tool, args: args ?? {} }));
    return awaitFile<unknown>(join(options.checksDir, `mcp-answer-${nonce}-${n}.json`), options.checkWaitMs ?? 0, (p) => (p && typeof p === "object" ? p : null), { skipped: true });
  };

  const call = async (tool: string, args: unknown): Promise<unknown> => {
    const b = (options.bridge ?? []).find((x) => x.name === tool);
    if (b && !(tool in LUNA_TOOLS)) return bridged(b, args);
    if (!(tool in LUNA_TOOLS)) return { error: `no luna tool ${tool}` };
    const name = tool as LunaTool;
    const parsed = z.object(LUNA_TOOLS[name].input).safeParse(args ?? {});
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ") };
    return (handlers[name] as (a: unknown) => unknown)(parsed.data);
  };

  return { state, handlers, call };
}
