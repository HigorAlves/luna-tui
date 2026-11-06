// A person's note at the ship gate, as a fix card. The note is free text with a convention: `t=12.5`,
// `@1:05` or `@42`, `scene=<id>` and `el=<id>` anywhere in it are read out and removed from the
// text. A note with no tokens is a whole-film card. Pure.

export type FixCard = { t: number | null; scene: string | null; element: string | null; text: string };

const WORD = String.raw`[A-Za-z0-9_.-]+`;
const TOKENS: { name: "t" | "scene" | "element"; re: RegExp; value: (m: RegExpExecArray) => string | number }[] = [
  { name: "t", re: /(?<=^|\s)t=(\d+(?:\.\d+)?)(?=\s|$)/, value: (m) => Number(m[1]) },
  { name: "t", re: /(?<=^|\s)@(\d+):([0-5]?\d)(?=\s|$)/, value: (m) => Number(m[1]) * 60 + Number(m[2]) },
  { name: "t", re: /(?<=^|\s)@(\d+(?:\.\d+)?)(?=\s|$)/, value: (m) => Number(m[1]) },
  { name: "scene", re: new RegExp(String.raw`(?<=^|\s)scene=(${WORD})(?=\s|$)`), value: (m) => m[1]! },
  { name: "element", re: new RegExp(String.raw`(?<=^|\s)el=(${WORD})(?=\s|$)`), value: (m) => m[1]! },
];

/** The fix card a note carries; null for an empty note. */
export function parseNote(reason: string | null): FixCard | null {
  if (reason === null || reason.trim() === "") return null;
  const card: FixCard = { t: null, scene: null, element: null, text: reason };
  for (const { name, re, value } of TOKENS) {
    const m = re.exec(card.text);
    if (!m || card[name] !== null) continue;
    (card as Record<string, unknown>)[name] = value(m);
    card.text = card.text.slice(0, m.index) + card.text.slice(m.index + m[0].length);
  }
  return { ...card, text: card.text.replace(/\s+/g, " ").trim() };
}
