// design_spec's answer (RFC 0013, phase 2): the design of a card as the planner reads it. Every value comes from the Figma file,
// except a suggestion for a state the file lacks, which names its Mobbin source and is never presented as the design.
import { z } from "zod";

import { DESIGN_STATES, FIGMA_NODE_ID } from "./design.ts";

const NodeId = z.string().regex(FIGMA_NODE_ID);
const Token = z.object({
  name: z.string().max(120),
  value: z.string().max(200),
  /** The Figma variable it came from; null when the file has none for it. */
  variable: z.string().max(200).nullable(),
  /** The node it was read from when there is no variable. */
  nodeId: NodeId.nullable(),
});
const State = z
  .object({
    state: z.enum(DESIGN_STATES),
    /** The node that draws this state; null when the file has none. */
    nodeId: NodeId.nullable(),
    /** A pattern for a state the file lacks: a suggestion, never the design. */
    suggestion: z.object({ source: z.literal("mobbin"), ref: z.string().max(300), note: z.string().max(300) }).nullable(),
  })
  .refine((s) => !(s.nodeId !== null && s.suggestion !== null), { message: "a designed state carries no suggestion" });

export const DesignSpec = z.object({
  frames: z.array(z.object({ id: NodeId, name: z.string().max(200), viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable(), states: z.array(State).max(DESIGN_STATES.length) })).max(30),
  tokens: z.object({ color: z.array(Token).max(60), type: z.array(Token).max(30), spacing: z.array(Token).max(30), radius: z.array(Token).max(15) }),
  components: z.array(z.object({ name: z.string().max(120), nodeId: NodeId, codeConnect: z.object({ path: z.string().max(300), name: z.string().max(120) }).nullable() })).max(60),
  a11yNotes: z.array(z.object({ frame: NodeId, note: z.string().max(300) })).max(30),
  /** What design input the writer could not read (a server down, a frame not found), one line each. */
  missing: z.array(z.string().max(300)).max(10),
  confidence: z.number().min(0).max(1),
});
export type DesignSpec = z.infer<typeof DesignSpec>;
