// A mask on a pack (RFC 0007 §4): the units a person approved removing, applied to the pack before a runtime builds its tool lists, subagents and skills.
// The token economy's `narrow` does the removing; this carries the result back into a pack, and names a mask for the run's fingerprint.
import { type Pack, PROTECTED_LUNA, type ToolMask, narrow, resolveEngine } from "@hardness/contracts";

/** `pack` with the mask's units removed. The same pack when there is no mask, when it removes nothing, and for a pack that has no agent. */
export function maskedPack<P extends Pack>(pack: P, mask: ToolMask | undefined): P {
  if (pack.kind !== "agent" || maskKey(mask) === null) return pack;
  const narrowed = narrow(pack.access, mask, pack.skills);
  // A masked agent tool means no subagents: the helpers a Claude run dispatches. The ones through `delegate` (another runtime) stay.
  const helpers = mask?.agent && pack.access.agent ? pack.helpers.filter((h) => resolveEngine(h.engine).runtime !== "claude") : pack.helpers;
  return { ...pack, access: narrowed.access, skills: narrowed.skills, helpers };
}

/** The mask as a canonical string, for the fingerprint: sorted, deduplicated, protected luna tools dropped. Null when it removes nothing. */
export function maskKey(mask: ToolMask | undefined): string | null {
  if (!mask) return null;
  const skills = [...new Set(mask.skills ?? [])].sort();
  const luna = [...new Set(mask.luna ?? [])].filter((tool) => !PROTECTED_LUNA.has(tool)).sort();
  if (!mask.web && !mask.agent && skills.length === 0 && luna.length === 0) return null;
  return JSON.stringify({ ...(mask.agent ? { agent: true } : {}), ...(luna.length > 0 ? { luna } : {}), ...(skills.length > 0 ? { skills } : {}), ...(mask.web ? { web: true } : {}) });
}
