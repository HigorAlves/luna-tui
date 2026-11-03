// What main.ts hands a runtime and what it gets back. A runtime runs one prepared stage on its
// vendor's SDK; reading the input, rendering the prompt and writing the result stay in main.ts.
import type { Pack, ResolvedEngine, RuntimeId, StageInput } from "@hardness/contracts";

import type { LunaState, RunOutcome } from "./output.ts";

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
  };
  /** The luna tools: the state the result reads, the server the Claude runtime serves them from,
   *  and `call` for a runtime that serves the same handlers its own way. */
  luna: { state: LunaState; server: unknown; call: (tool: string, args: unknown) => Promise<unknown> };
  /** LUNA_STAGE_DRY_RUN=1: build and print the run's options without a model call. */
  dry: boolean;
  /** A line on the readable transcript (stdout). */
  out: (line: string) => void;
}

export interface Runtime {
  id: RuntimeId;
  run(ctx: RunContext): Promise<RunOutcome>;
}
