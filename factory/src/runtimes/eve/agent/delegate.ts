// What the generated `delegate` workflow tool (compile.ts) calls. The tool body is a workflow, so
// it only decides and waits; each call out of the eve server is a step the tool file declares
// ("use step" is only found in modules under the app), which calls these over the runner's bridge
// (tools.ts). `delegate` itself (core/delegate.ts) runs a helper the stage cannot run natively;
// `helper_start` is the runner's side of a helper that is a native subagent.
import type { AgentRole } from "@hardness/contracts";
import { z } from "zod";

import { bridge } from "./tools.ts";

export interface DelegateInput {
  helper: string;
  message: string;
}

/** The tool's input: the helper's role among `roles`, and everything it needs in the message. */
export function delegateInput(roles: [AgentRole, ...AgentRole[]]) {
  return z.object({ helper: z.enum(roles).describe("The helper's role"), message: z.string().min(1).describe("Everything the helper needs: what to look at and what to answer") });
}

/** Asks the runner to start a native subagent's child: its prompt, or why it cannot run. */
export async function startHelper(input: DelegateInput): Promise<{ prompt: string } | { error: string }> {
  return (await bridge("helper_start", input)) as { prompt: string } | { error: string };
}

/** `delegate` over the bridge: a helper that gave no answer fails the call. */
export async function delegateOverBridge(input: DelegateInput): Promise<unknown> {
  const value = await bridge("delegate", input);
  if (typeof value === "object" && value !== null && "error" in value) throw new Error(String(value.error));
  return value;
}
