// What a person's override of a conversation teaches: a file under `<stateDir>/ground-truth/conversation/` (the sub-scores, the machine's level,
// the person's, the record id) and, where a question's label follows, a truth on the `conversation_assess` record. A priority change labels no
// question (the model answered five sub-scores, not a level), except a knock-out P0 lowered by hand, which labels that flag false.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConversationClassification, ConversationKind, SlackPriority } from "@hardness/contracts";

import type { TruthSink } from "./decision-truth.ts";

export class ConversationTruth {
  constructor(
    private readonly stateDir: string,
    private readonly truth: TruthSink | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A hand-set kind or priority on a thread the machine classified. Never throws: ground truth must not block a tap. */
  async override(input: { thread: string; classification: ConversationClassification | null; kind?: ConversationKind; priority?: SlackPriority }): Promise<void> {
    const c = input.classification;
    if (!c) return;
    const recordId = c.records.assess ?? null;
    try {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      const dir = join(this.stateDir, "ground-truth", "conversation");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${input.thread.replace(/[^A-Za-z0-9._-]/g, "_")}-${stamp}.json`);
      const body = { thread: input.thread, record: recordId, scores: c.scores ?? null, total: c.total ?? null, machine: { kind: c.kind, priority: c.priority ?? null, knockOut: c.knockOut ?? null }, person: { kind: input.kind ?? null, priority: input.priority ?? null }, at: this.now().toISOString() };
      await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`conversation truth: could not write the file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!recordId || !this.truth) return;
    if (input.kind) await this.truth.learned({ pack: "conversation_assess", recordId, label: { kind: { choice: input.kind } }, source: "person" });
    else if (input.priority && c.knockOut && c.priority === "P0" && input.priority !== "P0") await this.truth.learned({ pack: "conversation_assess", recordId, label: { [c.knockOut]: { value: false } }, source: "person" });
  }
}
