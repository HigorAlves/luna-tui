// What a stranger's text may carry into storage: every token-shaped string, private key, card number and social
// security number is cut out before a row is saved; e-mail addresses and phone numbers stay (the operator can read
// them in Slack already) and are masked in every copy that leaves the conversation object. Pure.
import { redact } from "./evidence-markdown.ts";

const CUT = "[redacted]";

/** Shapes beyond `redact()`'s: key blocks, Slack app tokens and webhook addresses, Stripe, Google and npm keys. Bounded runs. */
const MORE_SHAPES = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8000}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /xapp-\d-[A-Za-z0-9-]{10,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  // OpenAI keys (`sk-`, `sk-proj-`, `sk-svcacct-`), the Vercel AI Gateway key (`vck_`) and the decision engine's (`tsk_`): the keys `docs/configuration.md` names.
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{19,}/g,
  /\bvck_[A-Za-z0-9_-]{20,}/g,
  /\btsk_[A-Za-z0-9_-]{20,}/g,
];

/** `scheme://user:password@host`: the password only. */
const URL_CREDENTIAL = /\b([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:@/]{1,100}:)[^\s@/]{1,200}(?=@)/gi;
/** `password=x`, `DB_PASSWORD: x`, `token: x`, `client_secret = "x"`: the value only (four characters or more, so prose and empty assignments stay). */
const ASSIGNMENT = /\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;]{4,}/gi;

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;
/** A phone number needs a `+` or a separator: a bare run of digits is a timestamp or an id. */
const PHONE = /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?![\w.])|(?<![\w.])\+\d{1,3}[ .-]?\d{2,4}[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w.])/g;
const CARD = /(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d])/g;
const SSN = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g;

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

export interface Screened {
  text: string;
  /** How many strings were cut out. */
  secrets: number;
  /** The kinds of personal data left in `text`. */
  pii: Array<"email" | "phone">;
}

/** The text with every secret cut out, how many there were, and which personal data it still holds. */
export function screen(text: string): Screened {
  let secrets = 0;
  const cut = (out: string, shape: RegExp): string => out.replace(shape, () => (secrets++, CUT));
  let out = text;
  // `redact()` is the shared list; count what it cut by diffing the marker.
  const before = (out.match(/\[redacted\]/g) ?? []).length;
  out = redact(out);
  secrets += (out.match(/\[redacted\]/g) ?? []).length - before;
  for (const shape of MORE_SHAPES) out = cut(out, shape);
  out = out.replace(URL_CREDENTIAL, (_all, head: string) => (secrets++, `${head}${CUT}`));
  out = out.replace(ASSIGNMENT, (_all, head: string) => (secrets++, `${head}${CUT}`));
  out = out.replace(CARD, (run) => {
    const digits = run.replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return run;
    secrets++;
    return CUT;
  });
  out = out.replace(SSN, (all, area: string, group: string, serial: string) => {
    if (area === "000" || area === "666" || area.startsWith("9") || group === "00" || serial === "0000") return all;
    secrets++;
    return CUT;
  });
  const pii: Screened["pii"] = [];
  if (new RegExp(EMAIL.source).test(out)) pii.push("email");
  if (new RegExp(PHONE.source).test(out)) pii.push("phone");
  return { text: out, secrets, pii };
}

/** E-mail addresses and phone numbers replaced by `[email]` and `[phone]`: the form every copy that leaves the conversation takes. */
export const maskPii = (text: string): string => text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
