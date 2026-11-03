// The Jev runtime against the conformance table, on a scripted client in place of TypeSafe's: the
// rows a decision runtime can play (no tools, no text answers), on issue_classify.
import { PACKS } from "@hardness/contracts";

import { scriptedClient } from "../jev/fake.ts";
import { fromJev } from "../jev/questions.ts";
import { jevRuntime } from "../jev/run.ts";
import { conformance } from "./table.ts";

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
