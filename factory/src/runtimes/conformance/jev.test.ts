// The Jev runtime against the conformance table, on each transport with a scripted call in place of
// the API: the rows a decision runtime can play (no tools, no text answers), on triage_signals.
import { PACKS } from "@hardness/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { scriptedClient, scriptedDecide } from "../jev/fake.ts";
import { gatewayTransport } from "../jev/gateway.ts";
import { fromDecide, fromJev } from "../jev/questions.ts";
import { jevRuntime } from "../jev/run.ts";
import { typesafeTransport } from "../jev/typesafe.ts";
import { conformance, masked, runScenario } from "./table.ts";

const pack = PACKS.triage_signals;
const valid = {
  kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: {} },
  area: { type: "choice", choice: "board", confidence: 0.62, probabilities: {} },
  ready: { type: "noul", noul: 0.83 },
  size: { type: "score", score: 1.4, confidence: 0.75, legend: {}, probabilities: {} },
  urgency: { type: "score", score: 1, confidence: 0.7, legend: {}, probabilities: {} },
  risk: { type: "score", score: 0.5, confidence: 0.8, legend: {}, probabilities: {} },
  archive: { type: "noul", noul: 0.05 },
  archive_reason: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
};

conformance("jev", "jev", (script) => jevRuntime(() => typesafeTransport(() => scriptedClient(script))), { resetsAt: false, schemaIssue: true, tools: false, text: false, delegate: false }, {
  table: { pack, valid, expected: fromJev(pack.questions, valid), off: { ...valid, kind: { type: "choice", choice: "epic", confidence: 0.9, probabilities: {} } } },
});

const decided = {
  kind: { type: "choice", choice: "bug", probabilities: { bug: 0.91, feature: 0.09 } },
  area: { type: "choice", choice: "board", probabilities: { board: 0.62, machine: 0.38 } },
  ready: { type: "boolean", probability: 0.83 },
  size: { type: "score", score: 1.4, probabilities: { 1: 0.6, 2: 0.4 } },
  urgency: { type: "score", score: 1, probabilities: { 1: 1 } },
  risk: { type: "score", score: 0.5, probabilities: { 0: 0.5, 1: 0.5 } },
  archive: { type: "boolean", probability: 0.05 },
  archive_reason: { type: "choice", choice: "none", probabilities: { none: 0.9, stale: 0.1 } },
};

conformance("jev (gateway)", "jev", (script) => jevRuntime(() => gatewayTransport(scriptedDecide(script))), { resetsAt: false, schemaIssue: true, tools: false, text: false, delegate: false }, {
  table: { pack, valid: decided, expected: fromDecide(pack.questions, decided), off: { ...decided, kind: { type: "choice", choice: "epic", probabilities: { epic: 0.9 } } } },
});

it("the Jev runtime's transcript of the golden run", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const t = { pack, valid, expected: fromJev(pack.questions, valid), off: valid };
    const { transcript } = await runScenario(jevRuntime(() => typesafeTransport(() => scriptedClient([{ answer: valid }]))), "jev", root, t);
    expect(masked(transcript)).toEqual([
      "jev · model jev-scripted via typesafe · 10 in · 2 out · $0.00000042 · <n> ms",
      "kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · urgency 1 (0.70) · risk 0.5 (0.80) · archive no (p 0.05) · archive_reason none (0.90) · below 0.7: area",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
