// The text read off a film's frames and a PR's screenshots, checked for what must not be published: a token, a private key, an e-mail address,
// a phone number, a card number. Pure. A hit is a place and a kind, never the matched text: it ends up in a fix card, a note and an event.
import { SECRET_SHAPES } from "./evidence-markdown.ts";

export interface ScreenFrame {
  /** Seconds into the film. */
  t?: number;
  /** A screenshot's file name, or `transcript`. */
  file?: string;
  text: string;
}
export interface ScreenHit {
  place: string;
  kind: "token" | "private_key" | "email" | "phone" | "card";
}

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
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

/** The kinds of what must not be shown that `text` holds, each once. */
function kindsIn(text: string): ScreenHit["kind"][] {
  const kinds = new Set<ScreenHit["kind"]>();
  if (SECRET_SHAPES.some((shape) => new RegExp(shape.source).test(text))) kinds.add("token");
  if (PRIVATE_KEY.test(text)) kinds.add("private_key");
  for (const m of text.matchAll(EMAIL)) if (!SYNTHETIC.test(m[1]!)) kinds.add("email");
  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) kinds.add("card");
    else if (digits.length >= 10) kinds.add("phone");
  }
  return [...kinds];
}

export function screenFindings(frames: readonly ScreenFrame[]): ScreenHit[] {
  return frames.flatMap((f) => {
    const place = f.file !== undefined ? f.file : `${f.t ?? 0} s`;
    return kindsIn(f.text).map((kind) => ({ place, kind }));
  });
}
