// The thread or ticket history a card keeps: written by strangers, so each entry is one flat line, capped, and the list is bounded.
import { safe } from "./evidence-markdown.ts";

export const HISTORY_ENTRIES = 50;
const TEXT = 500;
const AUTHOR = 60;

export interface HistoryEntry {
  author: string | null;
  text: string;
  at: string | null;
}

export interface RawHistoryEntry {
  author?: string | null;
  text: string;
  at?: string | null;
}

export function historyOf(raw: RawHistoryEntry[]): HistoryEntry[] {
  return raw
    .slice(0, HISTORY_ENTRIES)
    .map((entry) => ({
      author: entry.author ? safe(entry.author).slice(0, AUTHOR) || null : null,
      text: safe(entry.text).slice(0, TEXT),
      at: entry.at ? safe(entry.at).slice(0, 40) : null,
    }))
    .filter((entry) => entry.text.length > 0);
}
