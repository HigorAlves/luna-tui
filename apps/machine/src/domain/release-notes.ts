// A release's notes as markdown, from the release writer's answer. Pure. The model's lines are flattened to one line each and
// a PR number the machine did not give is dropped, so the page never names a change that is not in the window.
import type { ReleaseNotesAnswer } from "@hardness/contracts";

import { postable } from "./postable.ts";

const HEADINGS = ["Features", "Fixes", "Security", "Other"] as const;
const LINE = 200;

const line = (text: string, cap = LINE): string => postable(text, cap);

/** The body of a GitHub release: highlights, breaking changes, then each kind in a fixed order; empty parts are left out. `known` is the set of PR numbers the machine gave. */
export function releaseNotesText(answer: ReleaseNotesAnswer, known: ReadonlySet<number>): string {
  const parts: string[] = [];
  const highlights = answer.highlights.map((h) => line(h)).filter(Boolean);
  if (highlights.length > 0) parts.push(["## Highlights", ...highlights.map((h) => `- ${h}`)].join("\n"));
  const breaking = answer.breaking.map((b) => line(b, 300)).filter(Boolean);
  if (breaking.length > 0) parts.push(["## Breaking changes", ...breaking.map((b) => `- ${b}`)].join("\n"));
  for (const heading of HEADINGS) {
    const items = answer.sections
      .filter((s) => s.heading === heading)
      .flatMap((s) => s.items)
      .map((item) => {
        const text = line(item.text);
        const prs = [...new Set(item.prs)].filter((n) => known.has(n));
        return text ? `- ${text}${prs.length > 0 ? ` (${prs.map((n) => `#${n}`).join(", ")})` : ""}` : "";
      })
      .filter(Boolean);
    if (items.length > 0) parts.push([`## ${heading}`, ...items].join("\n"));
  }
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "No user-facing changes in this release.\n";
}
