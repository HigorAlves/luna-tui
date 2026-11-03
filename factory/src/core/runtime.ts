// What main.ts hands a runtime and what it gets back. A runtime runs one prepared stage on its
// vendor's SDK; reading the input, rendering the prompt and writing the result stay in main.ts.
import type { Pack, ResolvedEngine, RuntimeId, StageInput } from "@hardness/contracts";

import type { DelegateTool } from "./delegate.ts";
import type { Emit } from "./events.ts";
import type { RunOutcome } from "./output.ts";

export interface RunContext {
  pack: Pack;
  /** The engine the stage runs on, resolved to its pinned model ID; its runtime is this one. */
  engine: ResolvedEngine;
  input: StageInput;
  prompt: string;
  paths: {
    /** The factory package: roles/, prompts/ and plugin/ are read from here. */
    factoryRoot: string;
    /** The task's worktree, the run's cwd. */
    work: string;
    /** Where the run's files go (/out). */
    out: string;
    /** The folder the stage input was read from (/in): the model may read it. */
    input: string;
    /** The run's scratch folder under /tmp, made fresh per run: the model's HOME and TMPDIR, the
     *  one place outside the worktree and the output its tools may write. */
    scratch: string;
  };
  /** The luna tools (core/luna-tools.ts): `call`, which each runtime serves its own way (Claude as
   *  an in-process MCP server, eve over a loopback bridge); their state stays in core. */
  luna: { call: (tool: string, args: unknown) => Promise<unknown> };
  /** LUNA_STAGE_DRY_RUN=1: build and print the run's options without a model call. */
  dry: boolean;
  /** Reports the run: core prints the transcript from these events and writes them to
   *  /out/events.jsonl. A runtime writes no transcript line of its own. */
  emit: Emit;
  /** The `delegate` tool, when the pack hands work to a helper this runtime does not run itself
   *  (core/delegate.ts): a runtime serves it beside the luna tools, its calls go to `luna.call`.
   *  Null in a child: delegation has depth 1. */
  delegate?: DelegateTool | null;
}

/** What a runtime gives the model besides the prompt, as its fingerprint reads it (core/fingerprint.ts). */
export interface Instructions {
  /** The role as this runtime sends it: the body, its helpers' bodies, the runtime's addendum. */
  role: string;
  /** The factory rules, in this runtime's tool names. */
  rules: string;
  /** The skills it loads, by name. */
  skills: string[];
}

export const NO_INSTRUCTIONS: Instructions = { role: "", rules: "", skills: [] };

export interface Runtime {
  id: RuntimeId;
  /** The SDK it runs on, by package name: the run record reads its installed version. */
  sdk: string;
  instructions(pack: Pack, factoryRoot: string): Instructions;
  run(ctx: RunContext): Promise<RunOutcome>;
}

/** When a runtime ends the stage itself: a little before the machine kills the container at the
 *  stage's time limit, so the run still writes a result that says why. */
export const deadlineMs = (timeoutMs: number): number => timeoutMs - Math.min(10_000, Math.round(timeoutMs / 10));
