// The machine's rules over the `design_parity` answer (RFC 0013, phase 3). The reviewer says what it compared and what differs; the machine decides what counts:
// a frame is compared only where it holds the capture, the findings become review Findings with a stable id, and the gate fires by rule, never by the reviewer's word. Pure.
import { type CapturePlan, type DesignParityAnswer, type DesignSpec, type Finding, type GateWhy, type PairRow, type ParityCapture, mergeDuplicateFindings, normaliseFinding, parityFindingId } from "@hardness/contracts";

/** Findings kept in a settled review. */
const FINDINGS_MAX = 40;
/** The confidence from which a blocker goes back to Build; under it, a person is asked. */
const BLOCKER_CONFIDENCE = 0.8;
/** The reviewer's frame renders are the sub-run's own files under /design; any other path is dropped. */
const RENDER = /^\/design\/\d+-\d+\.png$/;
const SEVERITY_RANK: Record<string, number> = { blocker: 0, should_fix: 1, nit: 2 };

export interface SettledParity {
  frames: PairRow[];
  findings: Finding[];
  confidence: number;
  designInput: DesignParityAnswer["designInput"];
  /** The confident blockers: they go back to Build in same-set rounds. */
  blockers: number;
  gate: { fires: boolean; why: GateWhy[] };
  notes: string[];
}

/**
 * A browser scenario that cites a frame the machine will not capture, but the frame still counts: the spec gives it no viewport (see `citedWithoutViewport`), or its target
 * is over the capture cap (see `overCap`, which names the viewport, the state and the reason).
 */
export interface Unplaced {
  scenario: string;
  frame: string;
  viewport?: string;
  state?: PairRow["state"];
  reason?: string;
}

/** A waiver as the `design.waived` rows keep it: the finding's id and a short hash of what it said, so a waiver covers that difference and no other. */
export interface Waiver {
  id: string;
  hash: string;
}

const normalised = (text: unknown): string => (typeof text === "string" ? text.trim().toLowerCase().replace(/\s+/g, " ") : "");

/**
 * A short hash (eight hex digits, FNV-1a) of what defines the difference, normalised (trimmed, lower-cased, whitespace collapsed): a parity finding's expected and built values;
 * an accessibility finding's body (its summary, state and rule), less the evidence file names, which differ from round to round.
 */
export function waiverHash(f: { design?: unknown; body?: unknown }): string {
  const at = f.design && typeof f.design === "object" ? (f.design as { expected?: unknown; actual?: unknown }) : null;
  const text = at && (typeof at.expected === "string" || typeof at.actual === "string") ? [normalised(at.expected), normalised(at.actual)] : [normalised(typeof f.body === "string" ? f.body.replace(/; evidence [^)]*\)$/, ")") : "")];
  let h = 0x811c9dc5;
  for (const ch of text.join("\n")) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A finding a person already waived on this card stays waived in the next round: it is marked, and the rules below never count it as open. It must match a waiver by id and by hash; a waiver with no hash covers nothing. */
export function markWaived(findings: readonly Finding[], waived: readonly Waiver[] | undefined): Finding[] {
  if (!waived || waived.length === 0) return [...findings];
  return findings.map((f) => (f.id !== undefined && waived.some((w) => w.id === f.id && w.hash !== "" && w.hash === waiverHash(f)) ? { ...f, resolution: { status: "waived" as const, by: "person" } } : f));
}

export const isWaived = (f: Finding): boolean => f.resolution?.status === "waived";

export function settleParity(answer: DesignParityAnswer | null, { plan, spec, captures, bar, unplaced = [], waived }: { plan: CapturePlan; spec: DesignSpec | null; captures: ParityCapture[]; bar: number; unplaced?: Unplaced[]; waived?: readonly Waiver[] }): SettledParity {
  const notes: string[] = [];
  const frameOf = (id: string) => spec?.frames.find((f) => f.id === id);
  const frames: PairRow[] = plan.targets.map((t) => {
    const spot = frameOf(t.frame);
    const taken = captures.find((c) => c.scenario === t.scenario && c.frame === t.frame && c.viewport === t.viewport.name && c.state === t.state);
    const said = answer?.frames.find((f) => f.frame === t.frame && f.scenario === t.scenario && f.viewport === t.viewport.name && f.state === t.state);
    // A capture the machine does not hold is never a pass, whatever the reviewer says; a frame it left out, or marked not compared, is not compared.
    const reason = !taken ? "no capture" : !said ? "the reviewer did not compare it" : said.status === "not_compared" ? (said.reason ?? "the reviewer did not compare it") : null;
    return {
      frame: t.frame,
      name: spot?.name ?? t.frame,
      node: spot?.states.find((s) => s.state === t.state)?.nodeId ?? t.frame,
      scenario: t.scenario,
      viewport: t.viewport.name,
      state: t.state,
      status: reason === null ? "compared" : "not_compared",
      ...(reason === null ? {} : { reason }),
      capture: taken?.image ?? null,
      render: said?.render && RENDER.test(said.render) ? said.render : null,
      diff: null,
      pair: null,
      diffRatio: null,
    };
  });
  // A cited frame with no viewport cannot be captured, so it is never in the plan; it is not compared, and a cited frame that is not compared opens the gate.
  for (const { scenario, frame: id, viewport, state, reason } of unplaced) {
    const spot = frameOf(id);
    const first = spot?.states.find((s) => s.nodeId !== null) ?? spot?.states[0];
    frames.push({ frame: id, name: spot?.name ?? id, node: (state ? spot?.states.find((s) => s.state === state)?.nodeId : first?.nodeId) ?? id, scenario, viewport: viewport ?? "unknown", state: state ?? first?.state ?? "default", status: "not_compared", reason: reason ?? "the spec gives this frame no viewport", capture: null, render: null, diff: null, pair: null, diffRatio: null });
  }
  for (const id of plan.uncited) {
    const spot = frameOf(id);
    const first = spot?.states[0];
    frames.push({ frame: id, name: spot?.name ?? id, node: first?.nodeId ?? id, scenario: null, viewport: spot?.viewport ? `${spot.viewport.width}x${spot.viewport.height}` : "unknown", state: first?.state ?? "default", status: "not_compared", reason: "no scenario cites it", capture: null, render: null, diff: null, pair: null, diffRatio: null });
  }

  const planned = new Set(plan.targets.map((t) => t.frame));
  const mapped: Finding[] = [];
  for (const f of answer?.findings ?? []) {
    if (!planned.has(f.frame)) {
      notes.push(`dropped a finding on frame ${f.frame}, which the capture plan does not hold`);
      continue;
    }
    // A finding stands only where the machine holds the capture and the reviewer compared it: otherwise it is a claim about a build nobody looked at.
    // It is put on a compared row of its frame by the machine's own plan, not by the reviewer's words for the viewport and the state.
    const rows = frames.filter((r) => r.scenario !== null && r.status === "compared" && r.frame === f.frame);
    const exact = rows.find((r) => r.viewport === f.viewport && r.state === f.state);
    const row = exact ?? (rows.length === 1 ? rows[0] : (rows.find((r) => r.state === f.state) ?? rows[0]));
    if (!row) {
      notes.push(`dropped a finding on frame ${f.frame} (${f.viewport}, ${f.state}), which was not compared`);
      continue;
    }
    if (!exact) notes.push(`put a finding on frame ${f.frame} (${f.viewport}, ${f.state}) on its compared row ${row.viewport}, ${row.state}`);
    const base = {
      path: `figma:${f.frame}/${row.node}`,
      line: 0,
      severity: f.level,
      title: f.title,
      body: `${f.why} Expected ${f.expected}; built ${f.actual} (${f.element}).`,
      confidence: f.confidence,
      category: "design" as const,
      criterion_ref: null,
      suggested_fix: null,
      design: { source: "parity" as const, frame: f.frame, node: row.node, element: f.element, viewport: row.viewport, state: row.state, kind: f.kind, expected: f.expected, actual: f.actual },
    };
    mapped.push(normaliseFinding({ ...base, id: parityFindingId({ frame: f.frame, node: row.node, kind: f.kind, element: f.element }) }));
  }
  // The same difference twice is one finding, at the higher severity; the most severe come first, and the list is capped.
  const findings = markWaived(mergeDuplicateFindings(mapped), waived)
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (SEVERITY_RANK[a.f.severity] ?? 3) - (SEVERITY_RANK[b.f.severity] ?? 3) || a.i - b.i)
    .map(({ f }) => f)
    .slice(0, FINDINGS_MAX);

  const confidence = answer?.confidence ?? 0;
  const designInput = answer?.designInput ?? "missing";
  const open = findings.filter((f) => !isWaived(f));
  const blockers = open.filter((f) => f.severity === "blocker" && f.confidence >= BLOCKER_CONFIDENCE).length;
  const why: GateWhy[] = [];
  if (open.some((f) => f.severity === "should_fix" || (f.severity === "blocker" && f.confidence < BLOCKER_CONFIDENCE))) why.push("open_findings");
  if (confidence < bar || designInput !== "complete") why.push("low_confidence");
  if (frames.some((f) => f.scenario !== null && f.status === "not_compared")) why.push("not_compared");
  return { frames, findings, confidence, designInput, blockers, gate: { fires: why.length > 0, why }, notes };
}
