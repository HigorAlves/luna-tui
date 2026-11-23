// Design parity (RFC 0013, phase 3): what the browser run captures for each cited frame, what the `design_parity` reviewer answers, and the pairs the machine settles.
// This file imports nothing from stage.ts, so `StageInput.context.parity` can use its schemas; the design report, which holds review Findings, is in design-report.ts.
import { z } from "zod";

import type { DesignConfig } from "./config-v22.ts";
import { DESIGN_STATES } from "./design.ts";

export const MAX_CAPTURES = 24;
export const PARITY_BAR_DEFAULT = 0.75;

export const DesignState = z.enum(DESIGN_STATES);
export type DesignState = z.infer<typeof DesignState>;

/** A viewport with the name its capture files carry (`${width}x${height}` when the spec gives none). The name goes into a path, so it is checked by pattern. */
export const ParityViewport = z.object({ name: z.string().regex(/^[a-z0-9-]{1,20}$/), width: z.number().int().min(200).max(4000), height: z.number().int().min(200).max(4000) });
export type ParityViewport = z.infer<typeof ParityViewport>;

/** One capture the e2e agent is asked to take: a scenario's state, at a spec frame's viewport. */
export const CaptureTarget = z.object({ scenario: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), frame: z.string().min(1).max(80), viewport: ParityViewport, state: DesignState });
export type CaptureTarget = z.infer<typeof CaptureTarget>;

export const CapturePlan = z.object({ targets: z.array(CaptureTarget).max(MAX_CAPTURES), uncited: z.array(z.string()), notes: z.array(z.string()) });
export type CapturePlan = z.infer<typeof CapturePlan>;

/** One element's computed styles, as `qa-capture` writes them. */
export const StyleRow = z.object({
  selector: z.string().max(300),
  text: z.string().max(200),
  color: z.string(),
  background: z.string(),
  fontFamily: z.string(),
  fontSize: z.string(),
  fontWeight: z.string(),
  lineHeight: z.string(),
  letterSpacing: z.string(),
  padding: z.string(),
  margin: z.string(),
  gap: z.string(),
  borderRadius: z.string(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
});
export type StyleRow = z.infer<typeof StyleRow>;

/** One capture the machine validated, as the reviewer sees it under /evidence/parity. */
export const ParityCapture = z.object({ scenario: z.string(), frame: z.string(), viewport: z.string(), state: DesignState, image: z.string(), styles: z.string().nullable(), elements: z.number().int() });
export type ParityCapture = z.infer<typeof ParityCapture>;

export const ParityKind = z.enum(["token", "layout", "state", "content"]);
export type ParityKind = z.infer<typeof ParityKind>;

/**
 * The `design_parity` reviewer's answer. Its findings carry the frame, the Figma node and the build element, not a path and a line, so they are not review
 * Findings: the factory leaves them in `answer` (as for `a11y_audit`) and the machine maps them into Findings when it settles the run.
 */
export const DesignParityAnswer = z.object({
  frames: z
    .array(z.object({ frame: z.string(), scenario: z.string().nullable(), viewport: z.string(), state: DesignState, status: z.enum(["compared", "not_compared"]), reason: z.string().max(300).optional(), capture: z.string().nullable(), render: z.string().nullable() }))
    .max(48),
  findings: z
    .array(
      z.object({
        level: z.enum(["blocker", "should_fix", "nit"]),
        kind: ParityKind,
        frame: z.string(),
        node: z.string().max(80),
        element: z.string().max(300),
        viewport: z.string(),
        state: DesignState,
        expected: z.string().max(200),
        actual: z.string().max(200),
        title: z.string().max(200),
        why: z.string().max(600),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(40),
  designInput: z.enum(["complete", "partial", "missing"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(1000),
});
export type DesignParityAnswer = z.infer<typeof DesignParityAnswer>;

/** One frame as the machine settled it, with the files the board and the PR show (host paths, under the state dir). */
export const PairRow = z.object({
  frame: z.string(),
  name: z.string(),
  node: z.string(),
  scenario: z.string().nullable(),
  viewport: z.string(),
  state: DesignState,
  status: z.enum(["compared", "not_compared"]),
  reason: z.string().optional(),
  capture: z.string().nullable(),
  render: z.string().nullable(),
  diff: z.string().nullable(),
  pair: z.string().nullable(),
  diffRatio: z.number().nullable(),
});
export type PairRow = z.infer<typeof PairRow>;

/** The file a capture is stored under, relative to the parity folder, without its extension. */
export const captureKey = (t: { scenario: string; viewport: { name: string } | string; state: string }): string => `${t.scenario}/${typeof t.viewport === "string" ? t.viewport : t.viewport.name}-${t.state}`;

/** A short stable id (`D` and eight hex digits, FNV-1a) from where the difference is and what kind it is, never the title or the reviewer's own words for the viewport and state: `blockerSetKey` then sees the same set in every round, and a waiver holds. The node is the plan row's. */
export function parityFindingId(at: { frame: string; node: string; kind: string; element: string }): string {
  let h = 0x811c9dc5;
  for (const ch of [at.frame, at.node, at.kind, at.element].join("\n")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `D${h.toString(16).padStart(8, "0")}`;
}

/** The confidence under which the gate fires: `design.parity.bar`, else 0.75. */
export const parityBarOf = (design: DesignConfig | undefined): number => (design && design !== "off" ? design.parity?.bar : undefined) ?? PARITY_BAR_DEFAULT;
