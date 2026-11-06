// The context a decision record keeps (RFC 0006 wave 18). The model is given the real context; the
// stored copy is not it: every string passes the run's secret redactor and the token shapes first, so
// a reader still sees that a credential was there (`[secret:NAME]`, `[redacted]`), and a private
// conversation's text is gone, because a year of retention would be a second copy of private
// messages. Ids, enum values, counts and dates survive. Pure.
import { redact } from "./evidence-markdown.ts";
import { redactDeep, secretRedactor } from "./redact-secrets.ts";

/** What replaces a private conversation's text in the stored copy. */
export const PRIVATE_TEXT = "[private]";
/** A string longer than this, or holding whitespace, is text rather than an id or an enum value. */
const TEXT_LENGTH = 40;

const isText = (value: string): boolean => /\s/.test(value) || value.length > TEXT_LENGTH;

function maskText(value: unknown): unknown {
  if (typeof value === "string") return isText(value) ? PRIVATE_TEXT : value;
  if (Array.isArray(value)) return value.map(maskText);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskText(item)]));
  return value;
}

/** How many strings (keys included) a redactor changed. */
function changed(before: unknown, after: unknown): number {
  if (typeof before === "string") return before === after ? 0 : 1;
  if (Array.isArray(before) && Array.isArray(after)) return before.reduce<number>((n, item, i) => n + changed(item, after[i]), 0);
  if (before !== null && typeof before === "object" && after !== null && typeof after === "object") {
    const a = Object.entries(before as Record<string, unknown>);
    const b = Object.entries(after as Record<string, unknown>);
    return a.reduce((n, [key, item], i) => n + (key === b[i]![0] ? 0 : 1) + changed(item, b[i]![1]), 0);
  }
  return 0;
}

export interface RecordedContext {
  context: Record<string, unknown>;
  /** Strings a redactor changed. */
  redacted: number;
}

/** The context to store and how many strings were redacted. `private` defaults to the conversation's own mark. */
export function recordContext(context: Record<string, unknown>, options: { secrets: Readonly<Record<string, string>>; private?: boolean }): RecordedContext {
  const secret = secretRedactor(options.secrets);
  const clean = redactDeep(context, (text) => redact(secret(text))) as Record<string, unknown>;
  const redacted = changed(context, clean);
  const conversation = clean.conversation;
  const isPrivate = options.private ?? (conversation !== null && typeof conversation === "object" && (conversation as { private?: unknown }).private === true);
  if (!isPrivate || conversation === null || typeof conversation !== "object") return { context: clean, redacted };
  return { context: { ...clean, conversation: maskText(conversation) }, redacted };
}
