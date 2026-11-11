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
  type_of_work: { type: "choice", choice: "backend", confidence: 0.55, probabilities: {} },
  ready: { type: "noul", noul: 0.83 },
  size: { type: "choice", choice: "S", confidence: 0.75, probabilities: {} },
  who: { type: "score", score: 1, confidence: 0.7, legend: {}, probabilities: {} },
  what: { type: "score", score: 1, confidence: 0.7, legend: {}, probabilities: {} },
  impact: { type: "score", score: 1, confidence: 0.7, legend: {}, probabilities: {} },
  time: { type: "score", score: 0, confidence: 0.8, legend: {}, probabilities: {} },
  demand: { type: "score", score: 0, confidence: 0.8, legend: {}, probabilities: {} },
  risk_prelim: { type: "choice", choice: "low", confidence: 0.8, probabilities: {} },
  archive: { type: "noul", noul: 0.05 },
  archive_reason: { type: "choice", choice: "none", confidence: 0.9, probabilities: {} },
};

conformance("jev", "jev", (script) => jevRuntime(() => typesafeTransport(() => scriptedClient(script))), { resetsAt: false, schemaIssue: true, tools: false, text: false, delegate: false, economy: false }, {
  table: { pack, valid, expected: fromJev(pack.questions, valid), off: { ...valid, kind: { type: "choice", choice: "epic", confidence: 0.9, probabilities: {} } } },
});

const decided = {
  kind: { type: "choice", choice: "bug", probabilities: { bug: 0.91, feature: 0.09 } },
  type_of_work: { type: "choice", choice: "backend", probabilities: { backend: 0.55, frontend: 0.45 } },
  ready: { type: "boolean", probability: 0.83 },
  size: { type: "choice", choice: "S", probabilities: { S: 0.75, M: 0.25 } },
  who: { type: "score", score: 1, probabilities: { 1: 1 } },
  what: { type: "score", score: 1, probabilities: { 0: 0.5, 1: 0.5 } },
  impact: { type: "score", score: 1, probabilities: { 1: 1 } },
  time: { type: "score", score: 0, probabilities: { 0: 1 } },
  demand: { type: "score", score: 0, probabilities: { 0: 1 } },
  risk_prelim: { type: "choice", choice: "low", probabilities: { low: 0.8, medium: 0.2 } },
  archive: { type: "boolean", probability: 0.05 },
  archive_reason: { type: "choice", choice: "none", probabilities: { none: 0.9, stale: 0.1 } },
};

conformance("jev (gateway)", "jev", (script) => jevRuntime(() => gatewayTransport(scriptedDecide(script))), { resetsAt: false, schemaIssue: true, tools: false, text: false, delegate: false, economy: false }, {
  table: { pack, valid: decided, expected: fromDecide(pack.questions, decided), off: { ...decided, kind: { type: "choice", choice: "epic", probabilities: { epic: 0.9 } } } },
});

it("the Jev runtime's transcript of the golden run", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const t = { pack, valid, expected: fromJev(pack.questions, valid), off: valid };
    const { transcript } = await runScenario(jevRuntime(() => typesafeTransport(() => scriptedClient([{ answer: valid }]))), "jev", root, t);
    expect(masked(transcript)).toEqual([
      "jev · model jev-scripted via typesafe · 10 in · 2 out · $0.00000042 · <n> ms",
      "kind bug (0.91) · type_of_work backend (0.55) · ready yes (p 0.83) · size S (0.75) · who 1 (0.70) · what 1 (0.70) · impact 1 (0.70) · time 0 (0.80) · demand 0 (0.80) · risk_prelim low (0.80) · archive no (p 0.05) · archive_reason none (0.90) · below 0.6: type_of_work",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
