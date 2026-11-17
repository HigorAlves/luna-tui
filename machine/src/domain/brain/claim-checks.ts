// The code checks a claim passes before any model sees it (RFC 0010, "Remember"). A claim is one statement
// and the exact words it rests on. The machine holds the source's text, so it can check the quote itself:
// a statement with no quote behind it never reaches the graph. Pure.
import { screen } from "../secrets-check.ts";

/** `ticketOnly`: the quote is in the card's own words and in no evidence. */
export type ClaimCheck = { ok: true; ticketOnly?: true } | { ok: false; why: string };

// The blocks that hold the card's own words (data-block.ts names a block after its template variable).
const TICKET_BLOCKS = new Set(["task.title", "task.description", "task.criteria"]);

/**
 * A prompt as two texts. `evidence` is what the data blocks hold, line marks removed: what happened, as a tool or a model wrote it.
 * `ticket` is the card's own words: the lines under the template's `## Task` heading (where the title is a flat line, outside any
 * block) and any block named for the card's title, description or criteria. The template's own instructions are in neither, so a quote
 * from them is found nowhere. Pure.
 */
export function splitPrompt(prompt: string): { evidence: string; ticket: string } {
  const evidence: string[] = [];
  const ticket: string[] = [];
  let block: string | null = null;
  let inTask = false;
  for (const line of prompt.split(/\r?\n/)) {
    if (block === null) {
      const open = /^<<<data:(.+)>>>$/.exec(line);
      if (open) {
        block = open[1]!;
        continue;
      }
      if (/^#{1,6}\s/.test(line)) inTask = /^#{1,6}\s+Task\s*$/i.test(line);
      else if (inTask && line.trim() !== "") ticket.push(line.trim());
      continue;
    }
    if (line === `<<<end-data:${block}>>>`) {
      block = null;
      continue;
    }
    // Every line a block holds is quoted with `| `: a line without the mark (a `[cut: ...]` note) is the machine's.
    const quoted = /^\|(?: (.*))?$/.exec(line);
    if (quoted) (TICKET_BLOCKS.has(block) ? ticket : evidence).push(quoted[1] ?? "");
  }
  return { evidence: evidence.join("\n"), ticket: ticket.join("\n") };
}

/** A text as a quote is compared with: a data block's `| ` line marks gone and every run of white space one space. A prompt quotes foreign text line by line, and a quote may cross a line. */
export const flatText = (text: string): string =>
  text
    .replace(/^[ \t]*\|(?: |$)/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** Whether the source holds the quote word for word, white space aside. */
export function quoteInSource(quote: string, sourceText: string): boolean {
  const wanted = flatText(quote);
  return wanted.length > 0 && flatText(sourceText).includes(wanted);
}

/** The part of the source around the quote, at most `max` characters: what the admission pack reads beside the claim. Empty when the quote is not there. */
export function excerptAround(quote: string, sourceText: string, max = 4000): string {
  const source = flatText(sourceText);
  const wanted = flatText(quote);
  const at = wanted.length > 0 ? source.indexOf(wanted) : -1;
  if (at < 0) return "";
  if (source.length <= max) return source;
  const room = Math.max(max - wanted.length, 0);
  const start = Math.max(Math.min(at - Math.floor(room / 2), source.length - max), 0);
  return source.slice(start, start + max);
}

// A statement says what is true. These shapes address a reader instead: an order to drop what came before, a "you must",
// or a sentence that opens as a command. Whether a milder sentence is still an instruction is the pack's question, not this lint's.
const ORDER =
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,60}\b(?:above|previous|prior|earlier|instructions?|rules?|rows?|prompt|context)\b|\byou (?:must|should|shall|will|are to|need to|have to)\b|\b(?:system prompt|as an ai|new instructions?)\b|^\s*(?:always|never|do not|don't|make sure|ensure|remember to|please)\b/i;

/** What the code refuses, in the order a person would want to hear it. `sourceText` is null when the machine does not hold the source; `ticketText` is the card's own words, where a quote passes but is marked `ticketOnly`. */
export function checkClaim(claim: { statement: string; quote: string }, sourceText: string | null, ticketText?: string): ClaimCheck {
  const refuse = (why: string): ClaimCheck => ({ ok: false, why });
  // A statement is one line: it is shown in lists and rendered in prompts as one.
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(claim.statement)) return refuse("the statement is not one line");
  const screened = screen(`${claim.statement}\n${claim.quote}`);
  if (screened.secrets > 0) return refuse("it holds what looks like a secret");
  if (screened.pii.length > 0) return refuse(`it holds personal data (${screened.pii.join(", ")})`);
  if (ORDER.test(claim.statement)) return refuse("the statement reads as an instruction; a rule for agents belongs in docs/agents/project-context.md");
  if (sourceText === null) return refuse("the machine does not hold its source");
  if (quoteInSource(claim.quote, sourceText)) return { ok: true };
  if (ticketText !== undefined && quoteInSource(claim.quote, ticketText)) return { ok: true, ticketOnly: true };
  return refuse("the quote is not in its source, word for word");
}
