// The context a decision record keeps (RFC 0006 wave 18). The model is given the real context; the
// stored copy is not it: every string passes the run's secret redactor and the token shapes first, so
// a reader still sees that a credential was there (`[secret:NAME]`, `[redacted]`), and a private
// conversation's text is gone, because a year of retention would be a second copy of private
// messages. Ids, enum values, counts and dates survive. Pure.
import { redact } from "./evidence-markdown.ts";
import { redactDeep, secretRedactor } from "./redact-secrets.ts";

/** What replaces a private conversation's text in the stored copy. */
export const PRIVATE_TEXT = "[private]";
/** Keys whose string is an id or an enum value, never free text. `channel` is kept only when it is a Slack id. */
const KEPT_KEYS = new Set(["id", "kind", "profile", "relation", "at"]);
const SLACK_ID = /^[CGD][A-Z0-9]{6,}$/;

/** In a private conversation every string is text, whatever its length, unless its key names an id or an enum. */
function maskText(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "channel") return SLACK_ID.test(value) ? value : PRIVATE_TEXT;
    return key !== undefined && KEPT_KEYS.has(key) ? value : PRIVATE_TEXT;
  }
  if (Array.isArray(value)) return value.map((item) => maskText(item));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, maskText(item, k)]));
  return value;
}

/** One call's stored context may not exceed this many bytes of JSON. */
export const CONTEXT_MAX_BYTES = 200_000;
const CUT_MARK = "[… cut]";

/** `value` with every string over `limit` characters cut to it and marked; `count.cut` says how many. */
function cutStrings(value: unknown, limit: number, count: { cut: number }): unknown {
  if (typeof value === "string") {
    if (value.length <= limit) return value;
    count.cut++;
    return `${value.slice(0, limit)}${CUT_MARK}`;
  }
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, limit, count));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, limit, count)]));
  return value;
}

/** The context bounded to `CONTEXT_MAX_BYTES`: first one string at most 20,000 characters, then (when the whole is still too big) 1,000; a context
 *  that is still too big is replaced by a marker. Each string cut counts as one redaction. */
function bounded(context: Record<string, unknown>): { context: Record<string, unknown>; cut: number } {
  const size = (value: unknown): number => JSON.stringify(value).length;
  const first = { cut: 0 };
  let out = cutStrings(context, 20_000, first) as Record<string, unknown>;
  if (size(out) <= CONTEXT_MAX_BYTES) return { context: out, cut: first.cut };
  const second = { cut: 0 };
  out = cutStrings(out, 1_000, second) as Record<string, unknown>;
  const cut = first.cut + second.cut;
  return size(out) <= CONTEXT_MAX_BYTES ? { context: out, cut } : { context: { cut: "the context was too large to keep" }, cut: cut + 1 };
}

export interface RecordedContext {
  context: Record<string, unknown>;
  /** Strings a redactor changed. */
  redacted: number;
}

/** The context to store and how many strings were redacted. `private` defaults to the conversation's own mark. */
export function recordContext(context: Record<string, unknown>, options: { secrets: Readonly<Record<string, string>>; private?: boolean }): RecordedContext {
  const secret = secretRedactor(options.secrets);
  // Counted inside the redactor, for every string and key it changes: nothing compares the two trees afterwards, so two keys that redact to the same string cannot throw.
  let count = 0;
  const clean = redactDeep(context, (text) => {
    const out = redact(secret(text));
    if (out !== text) count++;
    return out;
  }) as Record<string, unknown>;
  const limited = bounded(clean);
  const redacted = count + limited.cut;
  return finish(limited.context, redacted, options.private);
}

function finish(clean: Record<string, unknown>, redacted: number, privateOption: boolean | undefined): RecordedContext {
  const conversation = clean.conversation;
  const isPrivate = privateOption ?? (conversation !== null && typeof conversation === "object" && (conversation as { private?: unknown }).private === true);
  if (!isPrivate || conversation === null || typeof conversation !== "object") return { context: clean, redacted };
  return { context: { ...clean, conversation: maskText(conversation) }, redacted };
}
