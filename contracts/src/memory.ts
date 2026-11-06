// Memory (RFC 0007): what the machine remembers across cards, kept in Cognee and indexed by the
// machine's own `memory_items` table. A row is the machine's record of one thing it sent to Cognee:
// where it came from, what it is anchored to, and whether it is still trusted. Cognee holds the
// content; the visibility rule, the trust and the lifecycle live here, on our side of the HTTP line.
import { z } from "zod";

/** What an item is. `doc` and `code` come from documents and the code graph; the rest from cards. */
export const MemoryKind = z.enum(["lesson", "outcome", "finding", "escalation", "review_ask", "decision", "doc", "code"]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Where an item came from: the card's source (its visibility), a document, or the code graph. */
export const MemorySourceKind = z.enum(["github", "slack", "jira", "tui", "doc", "code"]);
export type MemorySourceKind = z.infer<typeof MemorySourceKind>;

/** `fact`: written from the machine's own records; `lesson`: inferred and approved by a person; `outside`: found in Cognee with no row of ours (an upload in Cognee's UI), never pushed until a person adopts it. */
export const MemoryTrust = z.enum(["fact", "lesson", "outside"]);
export type MemoryTrust = z.infer<typeof MemoryTrust>;

/** `pending`: queued, not yet in Cognee; `active`: in Cognee and recalled; `stale`: its anchored files moved on; `retired`: forgotten, contradicted or reverted. */
export const MemoryStatus = z.enum(["pending", "active", "stale", "retired"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MEMORY_TEXT_MAX = 400;

export const MemoryAnchors = z.object({
  files: z.array(z.string()).max(50),
  /** The commit the item was true at; null when it is about no file. */
  commit: z.string().nullable(),
});
export type MemoryAnchors = z.infer<typeof MemoryAnchors>;

export const MemoryItem = z.object({
  id: z.string().min(1).max(64),
  kind: MemoryKind,
  /** The repository's slug, or null for a company document. */
  repo: z.string().nullable(),
  source: z.object({ kind: MemorySourceKind, ref: z.string().max(300).nullable() }),
  /** The Cognee dataset the item lives in; its id once Cognee has made it. */
  dataset: z.object({ name: z.string().min(1).max(200), id: z.string().nullable() }),
  /** Cognee's data id, once added. */
  cogneeDataId: z.string().nullable(),
  anchors: MemoryAnchors,
  provenance: z.object({
    by: z.enum(["machine", "pack", "person"]),
    card: z.string().nullable(),
    run: z.string().nullable(),
    pack: z.string().nullable(),
  }),
  trust: MemoryTrust,
  status: MemoryStatus,
  /** What Cognee is given: written by the machine's template or a pack, never copied raw from a source. */
  text: z.string().min(1).max(MEMORY_TEXT_MAX),
  contentHash: z.string(),
  createdAt: z.string(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MEMORY_CONTEXT_MAX_ITEMS = 12;
export const MEMORY_CONTEXT_MAX_BYTES = 4096;

/** One recalled item as a pack sees it: data from past work, never an instruction. */
export const RecalledMemory = z.object({
  id: z.string(),
  kind: MemoryKind,
  text: z.string().max(2000),
  /** The source kind, for the citation; never the source's own text. */
  source: MemorySourceKind,
  anchors: MemoryAnchors,
  /** Its anchored files changed a lot since it was written. */
  stale: z.boolean(),
  score: z.number().nullable(),
});
export type RecalledMemory = z.infer<typeof RecalledMemory>;

/** `context.memory` on a stage input. */
export const MemoryContext = z.object({
  items: z.array(RecalledMemory).max(MEMORY_CONTEXT_MAX_ITEMS),
  /** Why the block is empty or short (Cognee down, nothing matched, cut to the cap); null when nothing to say. */
  note: z.string().max(300).nullable(),
});
export type MemoryContext = z.infer<typeof MemoryContext>;

/** A lesson a pack proposes from a finished card (RFC 0007): short, anchored, with the reason it is worth remembering. */
export const LessonCandidate = z.object({
  text: z.string().min(1).max(MEMORY_TEXT_MAX),
  /** What the lesson is about: the kind its item gets once a person approves it. */
  kind: z.enum(["lesson", "outcome", "finding", "escalation", "review_ask", "decision"]),
  /** The files it is about; the machine adds the commit. */
  files: z.array(z.string().max(300)).max(10),
  reason: z.string().min(1).max(300),
});
export type LessonCandidate = z.infer<typeof LessonCandidate>;

/** What `memory_extract` answers: the candidate lessons (the worth and conflict decisions and a person still judge each). */
export const MemoryExtractAnswer = z.object({ lessons: z.array(LessonCandidate).max(8) });
export type MemoryExtractAnswer = z.infer<typeof MemoryExtractAnswer>;

/** `context.lessons`: what the three lesson packs read. `extract`: the card's facts and the retro's proposals; `worth`: one candidate; `conflict`: one candidate and the active items recalled for it, by slot. Every text is the machine's template or a pack's capped text, and still data. */
export const LessonsContext = z.object({
  kind: z.enum(["extract", "worth", "conflict"]),
  facts: z.array(z.string().max(MEMORY_TEXT_MAX)).max(60).optional(),
  proposals: z.array(z.string().max(600)).max(20).optional(),
  candidate: LessonCandidate.optional(),
  /** The recalled active items a candidate may contradict, `slot1`... in order (five at most). */
  recalled: z.array(z.object({ slot: z.number().int().min(1).max(5), id: z.string(), kind: MemoryKind, text: z.string().max(2000) })).max(5).optional(),
});
export type LessonsContext = z.infer<typeof LessonsContext>;

/** A lesson on the retro's gate: the candidate that survived `memory_worth`, with the machine's id for the person's answer. */
export const GateLesson = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(MEMORY_TEXT_MAX),
  kind: LessonCandidate.shape.kind,
  files: z.array(z.string()).max(10),
  reason: z.string().max(300),
});
export type GateLesson = z.infer<typeof GateLesson>;

/** A retirement the retro proposes: an active item a new lesson contradicts (`confident`) or may contradict (`unsure`: a person decides). */
export const GateRetirement = z.object({
  /** The item to retire. */
  itemId: z.string().min(1).max(64),
  text: z.string().max(2000),
  /** The lesson that contradicts it. */
  lesson: z.string().min(1).max(40),
  certainty: z.enum(["confident", "unsure"]),
});
export type GateRetirement = z.infer<typeof GateRetirement>;

/** A person's answer to one lesson or retirement of the gate. For a lesson id: `approve` writes it as written, `edit` writes `text`, `drop` writes nothing. For a retirement's item id: `approve` retires the item, `drop` keeps it. An id left unanswered is dropped. */
export const LessonAnswer = z.object({
  id: z.string().min(1).max(64),
  action: z.enum(["approve", "edit", "drop"]),
  text: z.string().min(1).max(MEMORY_TEXT_MAX).optional(),
});
export type LessonAnswer = z.infer<typeof LessonAnswer>;
