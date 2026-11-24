import type { Pack } from "@hardness/contracts";

/** The list a pack's `network` asks for: engine is the engines' hosts only (`pack`), github adds GitHub's, full is the agent list. A decision pack keeps the agent list. */
export function egressKindOf(pack: Pack): "pack" | "github" | "agent" {
  if (pack.kind === "decision") return "agent";
  return pack.network === "engine" ? "pack" : pack.network === "github" ? "github" : "agent";
}
