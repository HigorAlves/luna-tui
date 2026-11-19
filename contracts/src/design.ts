// A card's design reference (RFC 0013, phase 2): the Figma file and frames the machine found for it, and where it found them.
// The machine composes it; a model never writes one. The file key and node ids are checked by pattern, so a prompt may carry them as the machine's text.
import { z } from "zod";

export const FIGMA_FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
export const FIGMA_NODE_ID = /^\d{1,10}:\d{1,10}$/;

/** The states a spec names for a frame. */
export const DESIGN_STATES = ["default", "hover", "focus", "disabled", "loading", "empty", "error"] as const;

export const DesignRef = z.object({
  fileKey: z.string().regex(FIGMA_FILE_KEY),
  nodeIds: z.array(z.string().regex(FIGMA_NODE_ID)).max(20),
  /** `luna.yaml` `design.figma.page`, when that is where the reference came from. */
  page: z.string().max(200).nullable(),
  /** Where the machine found it: the card's text, an attachment's URL, the repo's fallback, or the link of an on-demand run. */
  from: z.enum(["issue", "attachment", "luna.yaml", "link"]),
});
export type DesignRef = z.infer<typeof DesignRef>;

export const DesignContext = z.object({ refs: z.array(DesignRef).min(1).max(5) });
export type DesignContext = z.infer<typeof DesignContext>;

/** A node id as Figma's API takes it (`12:34`) from the form a URL carries (`12-34`, `12%3A34`); null for anything else. */
export function figmaNodeId(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const id = decoded.replace(/^(\d+)-(\d+)$/, "$1:$2");
  return FIGMA_NODE_ID.test(id) ? id : null;
}
