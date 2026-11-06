// What a retro's model text becomes in a draft PR's body: inert. Shared by `retro-outputs.ts` and `close-task.ts`, so neither imports the other.
import { breakLinks, redact } from "../domain/evidence-markdown.ts";

/** A model's text for a draft PR's body: tokens redacted, HTML escaped (a `<!--` or `<details>` would hide the rest from the reviewer), mentions, issue references and addresses (a bare or `www.` address, a labelled link, an image) neutralized: a draft PR must not ping anyone or close anything. */
export const inert = (text: string): string => breakLinks(redact(text).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@(?=[A-Za-z0-9])/g, "@\u200b").replace(/#(?=\d)/g, "#\u200b"));

/** The retro's runbook and ADR proposals as a section of the draft PR's body. Model text: inert, capped. Nothing is written to the repository by itself. */
export function proposalsSection(proposals: ReadonlyArray<{ kind: string; title: string; body: string }>): string {
  if (proposals.length === 0) return "";
  return ["## Proposals", "", ...proposals.slice(0, 5).flatMap((p) => [`### ${p.kind === "adr" ? "ADR" : "Runbook"}: ${inert(p.title).replace(/\s+/g, " ").slice(0, 120)}`, "", inert(p.body).slice(0, 2000), ""])].join("\n");
}
