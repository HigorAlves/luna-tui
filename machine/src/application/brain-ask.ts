// The evidence for a question to the company brain (RFC 0010, "Ask"): the rows that the named queries return for it, written as
// the one line of text each that the brain_ask pack reads. The graph is read through `agentQuery` only, so no query is composed here.
import type { BrainAskRow } from "@hardness/contracts";

import { type Brain, type BrainValue, agentQuery, answered } from "./brain.ts";

type Row = Record<string, BrainValue>;

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const MAX_TICKETS = 3;
const MAX_COMPONENTS = 3;
const MAX_CARDS = 12;
const MAX_DEEP_CARDS = 5;
const MAX_VERDICTS = 6;
const MAX_LESSONS = 5;
const MAX_DEEP_LESSONS = 3;
const MAX_PRINCIPLES = 5;
const MAX_COMPLIANCE = 3;
const MAX_QUOTE = 200;
const MAX_TOUCHED_BY = 8;
const MAX_ROWS = 60;
const MAX_TEXT = 600;

/** A query's rows; a failure is no rows. `answered` is whether the brain answered it, even with none. */
async function search(brain: Brain, name: string, params: Record<string, string>): Promise<{ rows: Row[]; answered: boolean }> {
  try {
    const answer = await agentQuery(brain, name, params);
    return { rows: answer.rows, answered: answered(name, answer) };
  } catch {
    return { rows: [], answered: false };
  }
}

async function rowsOf(brain: Brain, name: string, params: Record<string, string>): Promise<Row[]> {
  return (await search(brain, name, params)).rows;
}

const day = (value: BrainValue | undefined) => (typeof value === "string" ? value.slice(0, 10) : null);
const has = (value: BrainValue | undefined): value is string | number | boolean => value !== null && value !== undefined && value !== "";
/** `label value`, or nothing when the column is null. */
const part = (label: string, value: BrainValue | undefined, suffix = "") => (has(value) ? `${label} ${value}${suffix}` : null);
const line = (parts: Array<string | null>) => parts.filter((p): p is string => p !== null).join(" · ").slice(0, MAX_TEXT);
const slugOf = (row: Row, column: string) => (typeof row[column] === "string" && row[column].length > 0 && row[column].length <= 300 ? row[column] : null);

function cardText(row: Row): string {
  return line([
    has(row.title) ? String(row.title) : null,
    part("state", row.state),
    part("size", row.size),
    part("risk", row.risk),
    part("estimated", row.est_loc, " lines"),
    part("actual", row.actual_loc, " lines"),
    part("retries", row.retries),
    part("escalations", row.escalations),
    part("opened", day(row.opened_at)),
    part("closed", day(row.closed_at)),
  ]);
}

function prText(row: Row, card: string): string {
  return line([`pull request #${row.number}`, has(row.state) ? String(row.state) : null, part("merged", day(row.merged_at)), has(row.url) ? String(row.url) : null, `for ${card}`]);
}

function verdictText(row: Row, card: string): string {
  return line([
    `${row.pack} asked ${row.question}`,
    part("answered", row.answer),
    part("confidence", row.confidence),
    has(row.truth) ? `truth ${row.truth}${has(row.truth_source) ? ` (${row.truth_source})` : ""}` : null,
    `on ${card}`,
    day(row.decided_at),
  ]);
}

/** A lesson with the exact words of the first verified claim it rests on, and where they were said; those two parts are left out when no claim is verified. */
function learningText(row: Row, claims: Row[]): string {
  const proof = claims.find((claim) => claim.status === "verified" && has(claim.quote));
  const quote = proof ? String(proof.quote).replace(/\s+/g, " ").trim().slice(0, MAX_QUOTE) : null;
  return line([
    has(row.title) ? String(row.title) : null,
    has(row.kind) ? String(row.kind) : null,
    part("scope", row.scope),
    part("learned", day(row.recorded_at)),
    quote ? `rests on "${quote}"${has(proof!.source_title) ? ` from ${proof!.source_title}` : ""}` : null,
  ]);
}

/** A rule that binds agents in one repository, with the repository and the section of its project context. */
function principleText(row: Row): string {
  return line([has(row.statement) ? String(row.statement) : null, has(row.repo) ? `rule of ${String(row.repo).replace(/^repo:/, "")}` : null, part("section", row.section)]);
}

/** An incident by its name, how bad, where and when, and whether it exposed personal data: never its timeline. */
function incidentText(row: Row): string {
  return line([
    has(row.title) ? String(row.title) : null,
    has(row.severity) ? String(row.severity) : null,
    has(row.status) ? String(row.status) : null,
    part("service", row.service),
    typeof row.breach === "boolean" ? `exposed personal data: ${row.breach ? "yes" : "no"}` : null,
    part("started", day(row.started_at)),
    part("resolved", day(row.resolved_at)),
  ]);
}

/** A page of a repository's wiki: its title (or question), its path and whose wiki, never its text. */
function pageText(title: BrainValue | undefined, label: string, row: Row): string {
  return line([has(title) ? String(title) : null, label, has(row.path) ? String(row.path) : null, has(row.repo) ? `wiki of ${String(row.repo).replace(/^repo:/, "")}` : null]);
}

/**
 * The rows that answer a question, in the order the pack should weigh them: lessons, then principles, then incidents, control pages and answers, then cards, then their pull requests, then their verdicts,
 * then the components that matched. Never throws: a query that fails, or a brain that is off, adds nothing.
 * With `options.repo` (a `repo:<slug>`) it reads that one repository: for a question that does not come from the owner, whose words may steer the search.
 * Cards, components, lessons and principles come from the repository's own searches, so no other repository's row can crowd out its own, and incidents,
 * control pages, answers and ticket lookups, which cannot be held to a repository, are not asked.
 */
export async function brainEvidence(brain: Brain, question: string, options: { repo?: string } = {}): Promise<BrainAskRow[]> {
  return (await brainSearch(brain, question, options)).rows;
}

/** `brainEvidence` and whether the brain answered: false when none of the searches it asked was answered (a wrong token, a query the server lacks, a server that is down), so "holds nothing" is told apart from "did not answer". */
export async function brainSearch(brain: Brain, question: string, options: { repo?: string } = {}): Promise<{ rows: BrainAskRow[]; answered: boolean }> {
  if (!brain.enabled) return { rows: [], answered: false };
  const { repo } = options;
  const keys = repo ? [] : [...new Set(question.match(TICKET_KEY) ?? [])].slice(0, MAX_TICKETS);
  const asked: Array<{ rows: Row[]; answered: boolean }> = [];
  /** A first-level search: what it returns, and whether it counts towards the brain having answered. */
  const first = async (name: string, params: Record<string, string>): Promise<Row[]> => {
    const result = await search(brain, name, params);
    asked.push(result);
    return result.rows;
  };
  const none: Promise<Row[]> = Promise.resolve([]);
  const [ticketHits, searchHits, components, lessonHits, principleHits, incidentHits, controlHits, answerHits] = await Promise.all([
    Promise.all(keys.map((key) => rowsOf(brain, "cards_for_ticket", { ticket: `ticket:jira/${key}` }))),
    repo ? first("search_cards_in_repo", { repo, q: question }) : first("search_cards", { q: question }),
    repo ? first("search_components_in_repo", { repo, q: question }) : first("search_components", { q: question }),
    repo ? first("search_learnings_in_repo", { repo, q: question }) : first("search_learnings", { q: question }),
    repo ? first("search_principles_in_repo", { repo, q: question }) : first("search_principles", { q: question }),
    repo ? none : first("search_incidents", { q: question }),
    repo ? none : first("search_controls", { q: question }),
    repo ? none : first("search_answers", { q: question }),
  ]);
  const lessons = lessonHits.flatMap((row) => {
    const slug = slugOf(row, "learning");
    return slug ? [{ slug, row }] : [];
  }).slice(0, MAX_LESSONS);
  const lessonClaims = await Promise.all(lessons.slice(0, MAX_DEEP_LESSONS).map((lesson) => rowsOf(brain, "claims_of_learning", { learning: lesson.slug })));
  const matched = components.flatMap((row) => {
    const slug = slugOf(row, "component");
    return slug ? [{ slug, name: has(row.name) ? String(row.name) : slug }] : [];
  });
  const componentHits = await Promise.all(matched.slice(0, MAX_COMPONENTS).map((component) => rowsOf(brain, "cards_touching", { component: component.slug })));

  // One card per slug, the first sighting winning: ticket hits, then search hits, then component hits.
  const cards = new Map<string, Row>();
  for (const row of [...ticketHits.flat(), ...searchHits, ...componentHits.flat()]) {
    const slug = slugOf(row, "card");
    if (slug && !cards.has(slug)) cards.set(slug, row);
  }
  const shown = [...cards.entries()].slice(0, MAX_CARDS);

  const deep = shown.slice(0, MAX_DEEP_CARDS).map(([slug]) => slug);
  const [prs, verdicts] = await Promise.all([
    Promise.all(deep.map((card) => rowsOf(brain, "prs_for_card", { card }))),
    Promise.all(deep.map((card) => rowsOf(brain, "verdicts_for_card", { card }))),
  ]);

  const rows: BrainAskRow[] = [
    ...lessons.map(({ slug, row }, i): BrainAskRow => ({ slug, kind: "learning", text: learningText(row, lessonClaims[i] ?? []) })),
    ...principleHits.flatMap((row): BrainAskRow[] => {
      const slug = slugOf(row, "principle");
      return slug ? [{ slug, kind: "principle", text: principleText(row) }] : [];
    }).slice(0, MAX_PRINCIPLES),
    ...incidentHits.flatMap((row): BrainAskRow[] => {
      const slug = slugOf(row, "incident");
      return slug ? [{ slug, kind: "incident", text: incidentText(row) }] : [];
    }).slice(0, MAX_COMPLIANCE),
    ...controlHits.flatMap((row): BrainAskRow[] => {
      const slug = slugOf(row, "control");
      return slug ? [{ slug, kind: "control", text: pageText(row.title, `${has(row.kind) ? String(row.kind) : "control"} page`, row) }] : [];
    }).slice(0, MAX_COMPLIANCE),
    ...answerHits.flatMap((row): BrainAskRow[] => {
      const slug = slugOf(row, "answer");
      return slug ? [{ slug, kind: "answer", text: pageText(row.question, "approved answer", row) }] : [];
    }).slice(0, MAX_COMPLIANCE),
    ...shown.map(([slug, row]): BrainAskRow => ({ slug, kind: "card", text: cardText(row) })),
  ];
  const seen = new Set(rows.map((row) => row.slug));
  const add = (slug: string | null, kind: BrainAskRow["kind"], text: string) => {
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      rows.push({ slug, kind, text });
    }
  };
  deep.forEach((card, i) => prs[i]!.forEach((row) => add(slugOf(row, "pr"), "pr", prText(row, card))));
  deep.forEach((card, i) => verdicts[i]!.slice(0, MAX_VERDICTS).forEach((row) => add(slugOf(row, "verdict"), "verdict", verdictText(row, card))));
  matched.forEach((component, i) => {
    const touching = [...new Set((componentHits[i] ?? []).flatMap((row) => slugOf(row, "card") ?? []))].slice(0, MAX_TOUCHED_BY);
    add(component.slug, "component", line([component.name, touching.length > 0 ? `touched by ${touching.join(", ")}` : null]));
  });
  return { rows: rows.slice(0, MAX_ROWS), answered: asked.some((result) => result.answered) };
}
