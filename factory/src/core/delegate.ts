// The `delegate` tool (RFC 0002, phase 7): how a stage's agent asks a helper its own runtime cannot
// run. A call runs the helper as a child of the stage, in the same container: its own pack
// (helperPack: the helper's role on its engine, the parent's access narrowed to reading, a reply
// and findings as its answer), through the same runtimes, into /out/children/<n>/ (prompt.md,
// result.json, events.jsonl). Its validated answer is the tool's result; a child that could not
// answer is a tool error the agent goes on without. Delegation has depth 1 (a child has no
// helpers, so no tool), children run one at a time, and each gets only what is left of the
// parent's turns and time. The parent's stream gets a `child` event as each starts and as it ends,
// and the parent's usage the children's cost (`withChildren`).
import { type AgentPack, type AgentRole, type EngineId, HELPER_LIMITS, type Helper, type Pack, type ResolvedEngine, type RunEvent, type RuntimeId, type StageInput, credentialOwner, helperPack, helpersOn, resolveEngine } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { Emit } from "./events.ts";
import { runInfo } from "./fingerprint.ts";
import { lunaHandlers } from "./luna-tools.ts";
import { EMPTY_RUN, type RunOutcome, finish, settle } from "./output.ts";
import { readRole } from "./roles.ts";
import { type RunContext, type Runtime, deadlineMs } from "./runtime.ts";
import { transcript } from "./transcript.ts";

/** The tool's name, as a luna tool beside the others. */
export const DELEGATE = "delegate";

/** A child needs at least this much of the parent's time and turns to be worth starting. */
const MIN_CHILD_MS = 30_000;
const MIN_CHILD_TURNS = 2;

/** The helpers a run on `runtime` reaches through the runner's `delegate`: the ones on another
 *  runtime. The rest are that runtime's own subagents (the SDK's on Claude, eve's native ones on
 *  eve). Elsewhere all of them: no other runtime maps a subagent. */
export function delegatedHelpers(pack: Pack, runtime: RuntimeId): Helper[] {
  const helpers = helpersOn(pack, runtime);
  return runtime === "claude" || runtime === "eve" ? helpers.filter((h) => resolveEngine(h.engine).runtime !== runtime) : helpers;
}

/** What the model reads about the tool and the input it gives. */
export interface DelegateTool {
  description: string;
  input: { helper: z.ZodType<AgentRole>; message: z.ZodString };
}

export function delegateTool(helpers: Helper[], rolesDir: string): DelegateTool {
  const roles = helpers.map((h) => h.role) as [AgentRole, ...AgentRole[]];
  const list = helpers.map((h) => `- ${h.role} (${h.engine}): ${readRole(rolesDir, h.role).description}`);
  return {
    description: [
      "Ask a helper for an independent answer. It runs on its own engine, reads /work but changes nothing, and never sees this conversation: put everything it needs in `message`.",
      "Helpers:",
      ...list,
      "Returns { answer, findings? }, or an error when the helper could not answer: go on without it then.",
    ].join("\n"),
    input: { helper: z.enum(roles).describe("The helper's role"), message: z.string().min(1).describe("Everything the helper needs: what to look at and what to answer") },
  };
}

/** Why `engine`'s credential is not in this container, or null when it is. The machine passes a
 *  helper's credential beside the stage's own when it has one. */
export function missingCredential(engine: EngineId, env: NodeJS.ProcessEnv = process.env): string | null {
  switch (credentialOwner(engine)) {
    case "claude":
      return env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY ? null : "no Claude credential in this stage";
    case "codex": {
      const file = join(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"), "auth.json");
      return existsSync(file) ? null : "no Codex login in this stage";
    }
    case "openai":
      return env.OPENAI_API_KEY ? null : "no OpenAI key in this stage";
    case "typesafe":
      return "a decision engine cannot be a helper";
  }
}

export interface DelegationOptions {
  pack: AgentPack;
  helpers: Helper[];
  /** The parent's input: the child's starts from it. */
  input: StageInput;
  /** The parent's paths; a child writes under <out>/children/ and gets its own scratch. */
  paths: Omit<RunContext["paths"], "scratch">;
  runtimes: Partial<Record<RuntimeId, Runtime>>;
  /** The parent's stream: the `child` events go here, the child's own to its folder. */
  emit: Emit;
  /** Where the child's transcript lines go, indented under the parent's. */
  print?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** When the parent's run started: its deadline counts from here. */
  startedAt: number;
  /** The parent's turns so far. */
  turnsUsed: () => number;
}

export interface Delegation {
  tool: DelegateTool;
  call(args: unknown): Promise<unknown>;
  /** What the children have spent: the parent's usage adds the cost. */
  spent: { costUsd: number | null; turns: number };
}

/** The run's delegation when its pack hands work to a helper `runtime` does not run itself; null otherwise. */
export function delegationFor(runtime: RuntimeId, { pack, ...options }: Omit<DelegationOptions, "helpers" | "pack"> & { pack: Pack }): Delegation | null {
  const helpers = delegatedHelpers(pack, runtime);
  return pack.kind !== "decision" && helpers.length > 0 ? delegation({ ...options, pack, helpers }) : null;
}

export function delegation(o: DelegationOptions): Delegation {
  const tool = delegateTool(o.helpers, join(o.paths.factoryRoot, "roles"));
  const spent: Delegation["spent"] = { costUsd: null, turns: 0 };
  let children = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const one = async (args: unknown): Promise<unknown> => {
    const parsed = z.object(tool.input).safeParse(args ?? {});
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ") };
    const helper = o.helpers.find((h) => h.role === parsed.data.helper)!;
    const n = ++children;
    const ids = { runId: `child-${n}`, pack: o.pack.id, role: helper.role, engine: helper.engine };
    o.emit({ kind: "child", payload: { phase: "start", ...ids } });
    const run = await runChild(o, helper, parsed.data.message, n, spent.turns);
    spent.turns += run.turns;
    if (run.costUsd !== null) spent.costUsd = (spent.costUsd ?? 0) + run.costUsd;
    o.emit({ kind: "child", payload: { phase: "end", ...ids, ok: run.ok, ...(run.error !== null && { error: run.error }), costUsd: run.costUsd } });
    return run.ok ? run.structured : { error: `${helper.role} on ${helper.engine} gave no answer: ${run.error ?? "no answer"}. Go on without it.` };
  };

  return {
    tool,
    spent,
    // One child at a time: each takes what the last left of the budget, and a Codex login is used by one run at once.
    call: (args) => {
      const next = queue.then(() => one(args));
      queue = next.catch(() => {});
      return next;
    },
  };
}

/** What a child's limits and prompt are made from: the parent's pack, input, paths, clock and turns. */
export type ChildOptions = Pick<DelegationOptions, "pack" | "input" | "paths" | "env" | "startedAt" | "turnsUsed">;

/** The child's limits out of what the parent has left, or why there is not enough. */
export function childLimits(o: Pick<ChildOptions, "input" | "startedAt" | "turnsUsed">, childTurns: number): StageInput["limits"] | { error: string } {
  const { maxTurns, timeoutMs } = o.input.limits;
  const left = o.startedAt + deadlineMs(timeoutMs) - Date.now();
  // The parent keeps a margin to read the answer and give its own.
  const time = Math.min(HELPER_LIMITS.timeoutMs, left - Math.min(60_000, Math.round(timeoutMs / 10)));
  const turnsLeft = maxTurns - o.turnsUsed() - childTurns;
  const turns = Math.min(HELPER_LIMITS.maxTurns, turnsLeft - 1);
  if (time < MIN_CHILD_MS) return { error: `the stage has ${Math.max(0, Math.round(left / 1000))} s left, not enough for a helper` };
  if (turns < MIN_CHILD_TURNS) return { error: `the stage has ${Math.max(0, turnsLeft)} turns left, not enough for a helper` };
  return { maxTurns: turns, timeoutMs: time };
}

/** A child that can run: its pack and engine, its folder, its prompt (the `helper.md` template
 *  with the helper and the message in it) and the limits it gets. Nothing is written. */
export interface PreparedChild {
  pack: AgentPack;
  engine: ResolvedEngine;
  out: string;
  template: string;
  prompt: string;
  limits: StageInput["limits"];
}

/** Everything both ways of running a child (the bridge's `delegate` and eve's native subagent) check
 *  before one starts, in one place so they cannot drift: the helper's credential, the limits out
 *  of what the parent has left, then the child's prompt. Returns why it cannot run instead. */
export function prepareChild(o: ChildOptions, helper: Helper, message: string, n: number, childTurns: number): PreparedChild | { error: string } {
  const missing = missingCredential(helper.engine, o.env);
  if (missing) return { error: missing };
  const limits = childLimits(o, childTurns);
  if ("error" in limits) return limits;
  const pack = helperPack(o.pack, helper);
  const template = readFileSync(join(o.paths.factoryRoot, "prompts", pack.template), "utf8");
  const prompt = template.replaceAll("{{agent}}", helper.role).replaceAll("{{parent}}", o.pack.id).replaceAll("{{message}}", () => message);
  return { pack, engine: resolveEngine(helper.engine), out: join(o.paths.out, "children", String(n)), template, prompt, limits };
}

/** Runs one child to its settled outcome and writes its folder, however it ended. */
async function runChild(o: DelegationOptions, helper: Helper, message: string, n: number, childTurns: number): Promise<RunOutcome> {
  const pack = helperPack(o.pack, helper);
  const engine = resolveEngine(helper.engine);
  const out = join(o.paths.out, "children", String(n));
  mkdirSync(out, { recursive: true });
  const events: RunEvent[] = [];
  const print = o.print ? transcript((line) => o.print!(`  ↳ ${line}`)) : () => {};
  const emit: Emit = (event) => {
    events.push(event);
    print(event);
  };
  const luna = lunaHandlers({ ledgerPath: join(out, "ledger.json"), decisions: o.input.decisions, emit });
  const refused = (error: string): RunOutcome => ({ ...EMPTY_RUN, error });
  const runtime = o.runtimes[engine.runtime];
  let info = null;
  let run: RunOutcome;
  if (!runtime) run = refused(`${engine.id} runs on ${engine.runtime}, which this factory does not carry`);
  else {
    const scratch = mkdtempSync(join(tmpdir(), "luna-scratch-"));
    try {
      const prepared = prepareChild(o, helper, message, n, childTurns);
      if ("error" in prepared) run = refused(prepared.error);
      else {
        writeFileSync(join(out, "prompt.md"), prepared.prompt);
        info = runInfo(runtime, engine, pack, prepared.template, o.paths.factoryRoot);
        const input: StageInput = { ...o.input, engine: helper.engine, limits: prepared.limits };
        run = settle(await runtime.run({ pack, engine, input, prompt: prepared.prompt, paths: { ...o.paths, out, scratch }, luna, dry: false, emit, delegate: null }), pack);
      }
    } catch (e) {
      run = refused(`the helper's run failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (run.rateLimited) emit({ kind: "rate_limit", payload: { resetsAt: run.resetsAt } });
  finish(out, pack, run, { ledger: luna.state.ledger, events, run: info });
  return run;
}

/** The luna tools with `delegate` among them when the run delegates. */
export const withDelegate = (luna: RunContext["luna"], d: Delegation | null): RunContext["luna"] =>
  d ? { call: (tool, args) => (tool === DELEGATE ? d.call(args) : luna.call(tool, args)) } : luna;

/** The parent's outcome with its children's cost added. */
export function withChildren(run: RunOutcome, d: Delegation | null): RunOutcome {
  if (!d || d.spent.costUsd === null) return run;
  return { ...run, costUsd: (run.costUsd ?? 0) + d.spent.costUsd };
}
