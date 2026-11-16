// A filled questionnaire as the person reads it, and its answers as bank pages. The draft's text is markdown the
// person may edit before approving, so `parseFilled` reads the approved text back, not the model's answer.
// Pure: no I/O, so every rule is unit tested.
import type { QuestionnaireAnswer } from "@hardness/contracts";
import { createHash } from "node:crypto";

import type { WikiPage } from "../application/wiki.ts";

export const BANK_DIR = "Compliance/Answers/";

const BANK_NOTE = " · from the answer bank";
const SOURCES = /^_Sources: (.*?)(?: · from the answer bank)?_$/;
const SECTION = /^## (\d+)\. (.*)$/;
const UNANSWERED = "## Unanswered";

/** One answered question as the approved text holds it. */
export interface FilledAnswer {
  n: number;
  question: string;
  answer: string;
  /** Wiki page paths the answer cites, a bank page among them when it came from the bank. */
  sources: string[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** A line that starts with `#` would open a section when read back: it is escaped with a backslash. */
const escapeAnswer = (text: string): string => text.replace(/^(#)/gm, "\\$1");
const unescapeAnswer = (text: string): string => text.replace(/^\\(#)/gm, "$1");

export function filledMarkdown(name: string, answers: QuestionnaireAnswer["answers"], unanswered: QuestionnaireAnswer["unanswered"]): string {
  const lines = [`# ${oneLine(name)}: answers`, ""];
  for (const a of answers) {
    const sources = [...new Set([...a.citations, ...(a.fromBank ? [a.fromBank] : [])])];
    lines.push(`## ${a.n}. ${oneLine(a.question)}`, "", escapeAnswer(a.answer.trim()), "", `_Sources: ${sources.join(", ")}${a.fromBank ? BANK_NOTE : ""}_`, "");
  }
  if (unanswered.length > 0) {
    lines.push(UNANSWERED, "");
    for (const u of unanswered) lines.push(`- ${u.n}. ${oneLine(u.question)} ${oneLine(u.why)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function parseFilled(text: string): FilledAnswer[] {
  const found: FilledAnswer[] = [];
  let current: { n: number; question: string; body: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = [...current.body];
    while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
    let sources: string[] = [];
    const last = body.at(-1);
    const match = last === undefined ? null : SOURCES.exec(last.trim());
    if (match) {
      sources = match[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "");
      body.pop();
    }
    found.push({ n: current.n, question: current.question, answer: unescapeAnswer(body.join("\n").trim()), sources });
    current = null;
  };
  for (const line of text.split("\n")) {
    const section = SECTION.exec(line);
    if (section) {
      close();
      current = { n: Number(section[1]), question: section[2]!.trim(), body: [] };
    } else if (line.trim() === UNANSWERED) {
      close();
    } else current?.body.push(line);
  }
  close();
  return found;
}

/** The text in order as pieces of `limit` characters at most, cut between paragraphs, else between lines, else anywhere. */
export function chunkText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  for (const paragraph of text.trim().split(/\n{2,}/)) {
    if (paragraph.trim() === "") continue;
    if (paragraph.length <= limit) {
      pieces.push(paragraph);
      continue;
    }
    let lines = "";
    const flush = () => {
      if (lines !== "") pieces.push(lines);
      lines = "";
    };
    for (const line of paragraph.split("\n")) {
      if (line.length > limit) {
        flush();
        for (let at = 0; at < line.length; at += limit) pieces.push(line.slice(at, at + limit));
      } else if (lines === "") lines = line;
      else if (lines.length + 1 + line.length <= limit) lines += `\n${line}`;
      else {
        flush();
        lines = line;
      }
    }
    flush();
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 2 + piece.length <= limit) chunks[chunks.length - 1] = `${last}\n\n${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

/** `Compliance/Answers/<kebab slug, 60 at most>-<first six hex of the question's sha256>.md`. */
export function bankPath(question: string): string {
  const flat = oneLine(question);
  const slug = flat
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  const hash = createHash("sha256").update(flat).digest("hex").slice(0, 6);
  return `${BANK_DIR}${slug === "" ? "question" : slug}-${hash}.md`;
}

/** The bank page of one approved answer. A bank page among `sources` is the page itself: it keeps its path, and is not a source. */
export function bankPage(question: string, answer: string, sources: string[], approvedAt: string, name: string): WikiPage {
  const existing = sources.find((s) => s.startsWith(BANK_DIR));
  const cited = sources.filter((s) => !s.startsWith(BANK_DIR));
  const text = [`# ${oneLine(question)}`, "", answer.trim(), "", `- Sources: ${cited.length > 0 ? cited.join(", ") : "none"}`, `- Approved: ${approvedAt.slice(0, 10)}`, `- From: ${oneLine(name)}`, ""].join("\n");
  return { path: existing ?? bankPath(question), text };
}
