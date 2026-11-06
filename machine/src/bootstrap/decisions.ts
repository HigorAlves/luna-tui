// What the evals' harvest and datasets read from the machine, exported as `@hardness/machine/decisions`:
// the decision log, the context schema of each context pack, the input a pack reads for a context,
// and where the machine keeps its state.
import { homedir } from "node:os";

import { stateDirFrom } from "../config.ts";

export { DecisionLog } from "../application/decision-log.ts";
export { type ContextPackId, type PackContext, contextSchema, isContextPack } from "../domain/context-packs.ts";
export { redact, safe } from "../domain/evidence-markdown.ts";
export { maskPhones, maskPii } from "../domain/secrets-check.ts";
export { buildContextPackInput } from "../domain/stage-input.ts";

/** The machine's state dir as the machine resolves it (`MACHINE_STATE_DIR`, else the XDG-style default). */
export const machineStateDir = (env: NodeJS.ProcessEnv = process.env): string => stateDirFrom(env, env.HOME ?? homedir());
