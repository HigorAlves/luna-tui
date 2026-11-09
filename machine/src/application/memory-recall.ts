// Memory's read paths for a stage run (RFC 0007, M2): the block pushed into `context.memory` before plan, build_tests,
// implementing, verifying, triage and pr_reply, and the answer to the `memory_recall` luna tool. Both ask the port with the
// same viewer, so what a pack is shown is what it could ask for. Neither throws: a failed recall is an empty block with a note.
import { MEMORY_CONTEXT_MAX_BYTES, MEMORY_CONTEXT_MAX_ITEMS, type MemoryContext, type RecalledMemory } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import { type MemoryViewer, publicPostFor } from "../domain/memory-datasets.ts";
import type { Memory } from "./memory.ts";

/** What each stage asks memory beside the card's goal and the code map's files. */
export const STAGE_QUERY: Record<string, string> = {
  triage: "size risk estimate outcome predicted actual",
  plan: "scope estimate files risk escalation",
  build_tests: "test scenario failing right reason",
  implementing: "implementation scope review fix finding",
  verifying: "verify finding severity files",
  pr_reply: "reviewer question reply",
};

/** The most items the luna tool returns. */
export const TOOL_ITEMS_MAX = 10;
const QUERY_MAX = 1000;
const TOOL_TEXT_MAX = 1500;
const CODE_ANSWER_MAX = 8000;

/** The viewer a run recalls as: the card's own (`base`, from `viewerOfCard`), with `publicPost` from the pack and the source (never a literal). */
export function viewerForRun(base: Extract<MemoryViewer, { kind: "card" }>, pack: string, sourceKind: string | null): Extract<MemoryViewer, { kind: "card" }> {
  return { ...base, publicPost: publicPostFor(pack, { kind: sourceKind ?? "tui" }) };
}

/** The items cut to the contract's caps: twelve at most, 4 KB of them. */
export function capItems(items: RecalledMemory[]): { items: RecalledMemory[]; cut: boolean } {
  const kept: RecalledMemory[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (kept.length >= MEMORY_CONTEXT_MAX_ITEMS || bytes + size > MEMORY_CONTEXT_MAX_BYTES) return { items: kept, cut: true };
    kept.push(item);
    bytes += size;
  }
  return { items: kept, cut: false };
}

/** `context.memory` for a run, or undefined when memory is off (the prompt then says `(none)`). A recall that fails is an empty block with the note. */
export async function recallBlock(
  memory: Memory,
  run: { pack: string; viewer: MemoryViewer; goal: string; files: string[] },
): Promise<MemoryContext | undefined> {
  if (!memory.enabled) return undefined;
  try {
    const query = `${run.goal}\n${run.files.slice(0, 30).join(" ")}\n${STAGE_QUERY[run.pack] ?? ""}`.slice(0, QUERY_MAX);
    const found = await memory.recall({ query, viewer: run.viewer, scope: "memory", limit: MEMORY_CONTEXT_MAX_ITEMS });
    const { items, cut } = capItems(found.items);
    const note = cut ? "cut to the cap" : found.note;
    return { items, note: note ? note.slice(0, 300) : null };
  } catch (error) {
    return { items: [], note: `memory recall failed: ${safe(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
}

export type ToolScope = "memory" | "docs" | "code";

/** What the luna tool answers: at most ten of { id, kind, text, stale } for `memory` and `docs`, the code graph's `search` for `code`. */
export async function toolAnswer(memory: Memory, request: { query: string; scope: ToolScope }, viewer: Extract<MemoryViewer, { kind: "card" }>): Promise<Record<string, unknown>> {
  if (!memory.enabled) return { verdict: "ok", items: [], note: "memory is off" };
  const query = request.query.slice(0, 300);
  try {
    if (request.scope === "code") {
      const result = await memory.code({ viewer, repo: viewer.repo, operation: "search", args: { query } });
      if (result === null) return { verdict: "ok", code: null, note: "no code graph for this repository" };
      const text = JSON.stringify(result);
      return { verdict: "ok", code: text.length > CODE_ANSWER_MAX ? `${text.slice(0, CODE_ANSWER_MAX)}…` : result, note: text.length > CODE_ANSWER_MAX ? "cut" : null };
    }
    const found = await memory.recall({ query, viewer, scope: request.scope, limit: TOOL_ITEMS_MAX });
    const items = found.items.slice(0, TOOL_ITEMS_MAX).map((i) => ({ id: i.id, kind: i.kind, text: i.text.slice(0, TOOL_TEXT_MAX), stale: i.stale }));
    return { verdict: "ok", items, note: found.note };
  } catch (error) {
    return { verdict: "ok", items: [], note: `memory recall failed: ${safe(error instanceof Error ? error.message : String(error)).slice(0, 200)}` };
  }
}

/** The machine's side of `memory_recall`: answers each request the container writes into the mailbox, bound to the card's own viewer. */
export function memoryAnswers(deps: { memory: Memory; viewer: Extract<MemoryViewer, { kind: "card" }>; write: (answer: Record<string, unknown>) => Promise<void> }) {
  return {
    async onMemoryRecall(request: { query: string; scope: ToolScope }): Promise<void> {
      await deps.write(await toolAnswer(deps.memory, request, deps.viewer));
    },
  };
}
