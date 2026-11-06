// What a person's override of a conversation teaches: a file under `<stateDir>/ground-truth/conversation/` (the sub-scores, the machine's level,
// the person's, the record id) and, where a question's label follows, a truth on the `conversation_assess` record. A priority change labels no
// question (the model answered five sub-scores, not a level), except a knock-out P0 lowered by hand, which labels that flag false.

import type { ConversationClassification, ConversationKind, SlackPriority } from "@hardness/contracts";

import type { TruthSink } from "./decision-truth.ts";
import { truthName, writeTruthFile } from "./ground-truth.ts";

export class ConversationTruth {
  constructor(
    private readonly stateDir: string,
    private readonly truth: TruthSink | null,
    private readonly now: () => Date = () => new Date(),
    /** False when the repository that claims the thread's channel keeps no truth (`learning.truth: false`); absent, or no repository known, every thread keeps it. A question that fails keeps it. */
    private readonly keeps: (thread: string) => Promise<boolean> = async () => true,
  ) {}

  private async kept(thread: string): Promise<boolean> {
    return this.keeps(thread).catch(() => true);
  }

  /** What a person did with a draft: a file per draft (`<thread>-<draft>.json`, mode 0600) with the record ids; sent or edited also labels `needs_reply` true on the assess record. Ignored and expired label nothing: either can mean "no reply was needed" or "the draft was bad". */
  async outcome(input: { thread: string; draft: string; outcome: "sent_as_drafted" | "edited" | "ignored" | "expired"; machine: string; person?: string; records: Record<string, string> }): Promise<void> {
    if (!(await this.kept(input.thread))) return;
    try {
      const safeName = truthName;
      const lines = (t: string): number => t.split("\n").length;
      const body = { thread: input.thread, draft: input.draft, outcome: input.outcome, records: input.records, machine: input.machine, ...(input.person !== undefined ? { person: input.person, lineDifference: lines(input.person) - lines(input.machine) } : {}), at: this.now().toISOString() };
      await writeTruthFile(this.stateDir, "conversation", `${safeName(input.thread)}-${safeName(input.draft)}.json`, `${JSON.stringify(body, null, 2)}\n`);
    } catch (error) {
      console.warn(`conversation truth: could not write the outcome: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record = input.records.assess;
    if ((input.outcome === "sent_as_drafted" || input.outcome === "edited") && record && this.truth) await this.truth.learned({ pack: "conversation_assess", recordId: record, label: { needs_reply: { value: true } }, kind: "person", source: "person" });
  }

  /** A hand-set relation: labels `related` (the slot, or none) and, for a new candidate or none, `new_work`, on the `conversation_relation` record. */
  async relation(input: { thread: string; record: string | null; relation: string; slot: number | null }): Promise<void> {
    if (!input.record || !this.truth || !(await this.kept(input.thread))) return;
    const label: Record<string, { choice: string } | { value: boolean }> = { related: { choice: input.slot ? `slot${input.slot}` : "none" } };
    if (input.slot === null) label.new_work = { value: input.relation === "new_candidate" };
    await this.truth.learned({ pack: "conversation_relation", recordId: input.record, label, kind: "person", source: "person" });
  }

  /** A hand-set kind or priority on a thread the machine classified. Never throws: ground truth must not block a tap. */
  async override(input: { thread: string; classification: ConversationClassification | null; kind?: ConversationKind; priority?: SlackPriority }): Promise<void> {
    const c = input.classification;
    if (!c || !(await this.kept(input.thread))) return;
    const recordId = c.records.assess ?? null;
    try {
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      const name = `${truthName(input.thread)}-${stamp}.json`;
      const body = { thread: input.thread, record: recordId, scores: c.scores ?? null, total: c.total ?? null, machine: { kind: c.kind, priority: c.priority ?? null, knockOut: c.knockOut ?? null }, person: { kind: input.kind ?? null, priority: input.priority ?? null }, at: this.now().toISOString() };
      await writeTruthFile(this.stateDir, "conversation", name, `${JSON.stringify(body, null, 2)}\n`);
    } catch (error) {
      console.warn(`conversation truth: could not write the file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!recordId || !this.truth) return;
    if (input.kind) await this.truth.learned({ pack: "conversation_assess", recordId, label: { kind: { choice: input.kind } }, kind: "person", source: "person" });
    else if (input.priority && c.knockOut && c.priority === "P0" && input.priority !== "P0") await this.truth.learned({ pack: "conversation_assess", recordId, label: { [c.knockOut]: { value: false } }, kind: "person", source: "person" });
  }
}
