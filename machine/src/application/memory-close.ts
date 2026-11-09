// What memory takes from a card as it closes (RFC 0007, M2): its facts, the lessons a person approved at the retro gate, and the old items
// a person agreed to retire. Facts are the machine's template; lessons carry the (possibly edited) text the person approved. One
// `cognify` over the datasets touched. Never throws: the card is closed either way.
import type { MemoryItemDraft, Memory } from "./memory.ts";
import { type CloseFactsInput, closeFacts } from "./memory-facts.ts";
import type { ResolvedLessons } from "./memory-approval.ts";

export interface CloseMemoryReport {
  facts: number;
  lessons: number;
  retired: number;
}

export async function recordClose(memory: Memory, input: CloseFactsInput | null, approved: ResolvedLessons): Promise<CloseMemoryReport> {
  const report: CloseMemoryReport = { facts: 0, lessons: 0, retired: 0 };
  if (!memory.enabled || !input) return report;
  try {
    // The old items go first: a lesson a person kept replaces what it contradicted.
    for (const r of approved.retire) {
      await memory.setStatus(r.itemId, "retired", `contradicted by a lesson approved at the retro of card ${input.card.id}`).catch(() => undefined);
      report.retired += 1;
    }
    const facts = closeFacts(input);
    const lessons: MemoryItemDraft[] = approved.write.map(({ lesson, text }) => ({
      kind: lesson.kind,
      repo: input.repo,
      source: input.source,
      anchors: { files: lesson.files.slice(0, 50), commit: lesson.files.length > 0 ? input.commit : null },
      provenance: { by: "person", card: input.card.id, run: null, pack: "memory_extract" },
      trust: "lesson",
      text,
    }));
    const rows = await memory.write([...facts, ...lessons]);
    report.facts = Math.min(facts.length, rows.length);
    report.lessons = Math.max(0, rows.length - report.facts);
    await memory.cognify([...new Set(rows.map((r) => r.dataset.name))]);
  } catch {
    // memory never blocks a close
  }
  return report;
}
