// What failed, in a few words, from the output of a check run: the failing tests ahead of the noise that ran first. Pure.
import { postable } from "./postable.ts";

const COLOUR = /\u001b\[[0-9;]*m/g;
/** A failing test line (`FAIL file.test.ts > name`) or the error that follows it. */
const FAILING = /\bFAIL\s+\S+\.(?:test|spec)\.\w+|^(?:Assertion|Type|Reference|Range|Syntax)?Error:/;

export function failureGist(text: string, cap = 300): string {
  const lines = text.replace(COLOUR, "").split("\n").map((l) => l.trim().replace(/\s+/g, " "));
  const hits = [...new Set(lines.filter((l) => FAILING.test(l)))].slice(0, 3);
  return postable(hits.length > 0 ? hits.join(" | ") : lines.filter(Boolean).join(" "), cap);
}
