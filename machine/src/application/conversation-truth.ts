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

  /** What a person did with a draft: a file per draft (`<thread>-<draft>.json`, mode 0600) with the record ids; sent or edited also labels `needs_reply` true on the assess record. Ignored and expired label nothing: either can mean "no reply was needed" or "the draft was bad". */
  async outcome(input: { thread: string; draft: string; outcome: "sent_as_drafted" | "edited" | "ignored" | "expired"; machine: string; person?: string; records: Record<string, string> }): Promise<void> {
    try {
      const dir = join(this.stateDir, "ground-truth", "conversation");
      await mkdir(dir, { recursive: true });
      const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
      const lines = (t: string): number => t.split("\n").length;
      const body = { thread: input.thread, draft: input.draft, outcome: input.outcome, records: input.records, machine: input.machine, ...(input.person !== undefined ? { person: input.person, lineDifference: lines(input.person) - lines(input.machine) } : {}), at: this.now().toISOString() };
      await writeFile(join(dir, `${safeName(input.thread)}-${safeName(input.draft)}.json`), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`conversation truth: could not write the outcome: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = input.records.assess;
    if ((input.outcome === "sent_as_drafted" || input.outcome === "edited") && record && this.truth) await this.truth.learned({ pack: "conversation_assess", recordId: record, label: { needs_reply: { value: true } }, kind: "person", source: "person" });
  }

  /** A hand-set relation: labels `related` (the slot, or none) and, for a new candidate or none, `new_work`, on the `conversation_relation` record. */
  async relation(input: { thread: string; record: string | null; relation: string; slot: number | null }): Promise<void> {
    if (!input.record || !this.truth) return;
    const label: Record<string, { choice: string } | { value: boolean }> = { related: { choice: input.slot ? `slot${input.slot}` : "none" } };
    if (input.slot === null) label.new_work = { value: input.relation === "new_candidate" };
    await this.truth.learned({ pack: "conversation_relation", recordId: input.record, label, kind: "person", source: "person" });
  }

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
    if (input.kind) await this.truth.learned({ pack: "conversation_assess", recordId, label: { kind: { choice: input.kind } }, kind: "person", source: "person" });
    else if (input.priority && c.knockOut && c.priority === "P0" && input.priority !== "P0") await this.truth.learned({ pack: "conversation_assess", recordId, label: { [c.knockOut]: { value: false } }, kind: "person", source: "person" });
  }
}
