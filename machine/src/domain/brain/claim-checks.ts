// The code checks a claim passes before any model sees it (RFC 0010, "Remember"). A claim is one statement
// and the exact words it rests on. The machine holds the source's text, so it can check the quote itself:
// a statement with no quote behind it never reaches the graph. Pure.
import { screen } from "../secrets-check.ts";

export type ClaimCheck = { ok: true } | { ok: false; why: string };

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

/** What the code refuses, in the order a person would want to hear it. `sourceText` is null when the machine does not hold the source. */
export function checkClaim(claim: { statement: string; quote: string }, sourceText: string | null): ClaimCheck {
  const refuse = (why: string): ClaimCheck => ({ ok: false, why });
  // A statement is one line: it is shown in lists and rendered in prompts as one.
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(claim.statement)) return refuse("the statement is not one line");
  const screened = screen(`${claim.statement}\n${claim.quote}`);
  if (screened.secrets > 0) return refuse("it holds what looks like a secret");
  if (screened.pii.length > 0) return refuse(`it holds personal data (${screened.pii.join(", ")})`);
  if (ORDER.test(claim.statement)) return refuse("the statement reads as an instruction; a rule for agents belongs in docs/agents/project-context.md");
  if (sourceText === null) return refuse("the machine does not hold its source");
  if (!quoteInSource(claim.quote, sourceText)) return refuse("the quote is not in its source, word for word");
  return { ok: true };
}
