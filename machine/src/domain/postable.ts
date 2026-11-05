// What the machine may post outward from text a model or a person wrote: one line, no HTML, no `@mention`, no `#N`
// auto-link, capped, and never a token-shaped string. One implementation for every outward post (the review loop's
// replies, a conversation's reply, triage's questions).
import { redact, safe } from "./evidence-markdown.ts";

/** The longest a reply the machine posts may be, after flattening. */
export const REPLY_CAP = 1500;

/** A model's text made safe to post: one line, no HTML, no `@mention`, no `#N` auto-link, capped. */
export const postable = (text: string, cap = REPLY_CAP): string => safe(text).slice(0, cap).trim();

/** Whether the text carried a token-shaped string: such a drafted text is never posted. */
export const carriesSecret = (text: string): boolean => redact(text) !== text;
