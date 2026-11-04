// What a runtime that answers a decision pack plays the conformance table with: issue_classify,
// answered as the pack's own schema asks (a runtime with a wire of its own, like Jev, has its
// table beside its test).
import { PACKS } from "@hardness/contracts";

import type { RuntimeCapabilities, TablePack } from "./table.ts";

/** A decision runtime calls no tools, and it answers in structured output only. */
export const CAPS_NO_TOOLS = { tools: false, text: false, delegate: false } satisfies Partial<RuntimeCapabilities>;

const ANSWER = {
  kind: { choice: "bug", confidence: 0.91 },
  area: { choice: "board", confidence: 0.62 },
  ready: { value: true, p: 0.83 },
  size: { score: 1.4, confidence: 0.75 },
};

export const DECISION_TABLE: TablePack = {
  pack: PACKS.issue_classify,
  valid: ANSWER,
  expected: ANSWER,
  off: { ...ANSWER, kind: { choice: "epic", confidence: 0.9 } },
};
