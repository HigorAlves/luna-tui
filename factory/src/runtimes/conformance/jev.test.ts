// The Jev runtime against the conformance table, on a scripted client in place of TypeSafe's: the
// rows a decision runtime can play (no tools, no text answers), on issue_classify.
import { PACKS } from "@hardness/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { scriptedClient } from "../jev/fake.ts";
import { fromJev } from "../jev/questions.ts";
import { jevRuntime } from "../jev/run.ts";
import { conformance, masked, runScenario } from "./table.ts";

const pack = PACKS.issue_classify;
const valid = {
  kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: {} },
  area: { type: "choice", choice: "board", confidence: 0.62, probabilities: {} },
  ready: { type: "noul", noul: 0.83 },
  size: { type: "score", score: 1.4, confidence: 0.75, legend: {}, probabilities: {} },
};

conformance("jev", "jev", (script) => jevRuntime(() => scriptedClient(script)), { resetsAt: false, schemaIssue: true, tools: false, text: false }, {
  table: { pack, valid, expected: fromJev(pack.questions, valid), off: { ...valid, kind: { type: "choice", choice: "epic", confidence: 0.9, probabilities: {} } } },
});

it("the Jev runtime's transcript of the golden run", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const t = { pack, valid, expected: fromJev(pack.questions, valid), off: valid };
    const { transcript } = await runScenario(jevRuntime(() => scriptedClient([{ answer: valid }])), "jev", root, t);
    expect(masked(transcript)).toEqual([
      "jev · model jev-scripted · 10 in · 2 out · <n> ms",
      "kind bug (0.91) · area board (0.62) · ready yes (p 0.83) · size 1.4 (0.75) · below 0.7: area",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
