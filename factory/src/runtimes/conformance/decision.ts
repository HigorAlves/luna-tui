// What a runtime that answers a decision pack plays the conformance table with: triage_signals,
// answered as the pack's own schema asks (a runtime with a wire of its own, like Jev, has its
// table beside its test).
import { PACKS } from "@hardness/contracts";

import type { RuntimeCapabilities, TablePack } from "./table.ts";

/** A decision runtime calls no tools, and it answers in structured output only. */
export const CAPS_NO_TOOLS = { tools: false, text: false, delegate: false } satisfies Partial<RuntimeCapabilities>;

const ANSWER = {
  kind: { choice: "bug", confidence: 0.91 },
  type_of_work: { choice: "backend", confidence: 0.55 },
  ready: { value: true, p: 0.83 },
  size: { choice: "S", confidence: 0.75 },
  who: { score: 1, confidence: 0.7 },
  what: { score: 1, confidence: 0.7 },
  impact: { score: 1, confidence: 0.7 },
  time: { score: 0, confidence: 0.8 },
  demand: { score: 0, confidence: 0.8 },
  risk_prelim: { choice: "low", confidence: 0.8 },
  archive: { value: false, p: 0.05 },
  archive_reason: { choice: "none", confidence: 0.9 },
};

export const DECISION_TABLE: TablePack = {
  pack: PACKS.triage_signals,
  valid: ANSWER,
  expected: ANSWER,
  off: { ...ANSWER, kind: { choice: "epic", confidence: 0.9 } },
};
