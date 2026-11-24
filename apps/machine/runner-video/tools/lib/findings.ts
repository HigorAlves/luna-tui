// What must not be published, found in a text: the one list the frames tool (in the video image) and the host share, so they cannot drift.
// Pure, no imports. A finding is a kind, never the matched text.

export type FindingKind = "token" | "private_key" | "email" | "phone" | "card" | "credential";
export const FINDING_KINDS = ["token", "private_key", "email", "phone", "card", "credential"] as const satisfies readonly FindingKind[];

/** Token shapes (global, so `redact` replaces every match). */
export const TOKEN_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /A[KS]IA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // payment and cloud keys
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /glpat-[A-Za-z0-9_-]{20}/g,
  /npm_[A-Za-z0-9]{36}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
];

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
// A URL whose userinfo has a password, a password or secret assigned a value, an Authorization header with a bearer or basic value.
const CREDENTIALS = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]*:[^\s/@]{3,}@/i,
  /(?:pass(?:word|wd)?|secret|api[_-]?key|token)["']?\s*[:=]\s*["']?[^\s"',;&]{4,}/i,
  /\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
];
const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
const SYNTHETIC = /(?:^|\.)example\.(?:com|org|net)$|\.test$|\.invalid$|^localhost$/i;
const DIGIT_RUN = /\+?\d(?:[\s().-]{0,2}\d){9,18}/g;

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
};

/** The kinds of what must not be shown that `text` holds, each once. Reads the whole text. */
export function findingKinds(text: string): FindingKind[] {
  const kinds = new Set<FindingKind>();
  if (TOKEN_SHAPES.some((shape) => new RegExp(shape.source).test(text))) kinds.add("token");
  if (PRIVATE_KEY.test(text)) kinds.add("private_key");
  if (CREDENTIALS.some((shape) => shape.test(text))) kinds.add("credential");
  for (const m of text.matchAll(EMAIL)) if (!SYNTHETIC.test(m[1]!)) kinds.add("email");
  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) kinds.add("card");
    else if (digits.length >= 10) kinds.add("phone");
  }
  return [...kinds];
}
