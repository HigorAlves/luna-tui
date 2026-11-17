// Rows of the company brain for work and code (RFC 0010, "Projection"): a repository, a card, the
// tracker item it came from and a pull request. Pure: the caller loads the records and writes the
// rows. Every row comes from the contracts' helpers, so it carries every key of its type, and no
// free text beyond a flattened title ever goes in: not a description, a criterion, a reason or a note.
import { brainEdge, brainNode, brainSlug, brainTime, type BrainRow, type ShipContext } from "@hardness/contracts";

import { maskPii, screen } from "../secrets-check.ts";
import type { TaskRow } from "../task.ts";

export interface BrainRepo {
  /** The machine's `repoSlug()` of the path. */
  slug: string;
  name: string;
}

export type RetroFacts = NonNullable<ShipContext["retro"]>;

/** The longest title a row keeps. */
export const TITLE_MAX = 200;

/** One line: line breaks and control characters become a space, then trimmed and capped. A title the tracker left empty still needs a value. */
export function flatTitle(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, TITLE_MAX).trim() || "(untitled)";
}

/** A title as a row keeps it when a person or a tool wrote it: a secret cut out, an address or phone number masked, one line, at most 200 characters. */
export const safeTitle = (text: string): string => flatTitle(maskPii(screen(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")).text));

export function repoRows(repo: BrainRepo): BrainRow[] {
  return [brainNode("Repo", { slug: brainSlug("repo", repo.slug), name: repo.name })];
}

const cardSlug = (taskId: string): string => brainSlug("card", taskId);

/** The task's own `total`, for a card with no retro: the same count the retro reports, and not the sum of the loops' counters. Null when the task keeps none. */
function counted(retries: TaskRow["retries"]): number | null {
  const total: unknown = retries?.total;
  return typeof total === "number" && Number.isInteger(total) ? total : null;
}

export function cardRows(task: TaskRow, context: { repo: BrainRepo | null; retro: RetroFacts | null }): BrainRow[] {
  const { retro } = context;
  const ended = task.state === "closed" || task.state === "archived";
  const slug = cardSlug(task.id);
  const rows: BrainRow[] = [
    brainNode("Card", {
      slug,
      title: safeTitle(task.title),
      state: task.state === "closed" ? "closed" : task.state === "archived" ? "archived" : "open",
      route: task.route,
      size: retro?.predicted.size ?? null,
      risk: retro?.predicted.risk ?? null,
      est_loc: retro?.predicted.estLoc ?? null,
      actual_loc: task.diffAdded !== null ? task.diffAdded + (task.diffRemoved ?? 0) : retro ? retro.actual.added + retro.actual.removed : null,
      retries: retro?.actual.retries.total ?? counted(task.retries),
      escalations: retro?.actual.escalations ?? null,
      opened_at: brainTime(task.createdAt),
      closed_at: ended ? brainTime(task.stateSince ?? task.updatedAt) : null,
    }),
  ];
  if (context.repo) rows.push(brainEdge("CardInRepo", slug, brainSlug("repo", context.repo.slug)));
  return rows;
}

/** At most one Ticket per card: a Jira link wins over a GitHub issue source; a pull request or any other source gives none. */
export function ticketRows(task: TaskRow): BrainRow[] {
  const title = safeTitle(task.title);
  const ticket = (slug: string, tracker: "jira" | "github", key: string, url: string): BrainRow[] => [
    brainNode("Ticket", { slug, tracker, key, title, url }),
    brainEdge("CardForTicket", cardSlug(task.id), slug),
  ];
  if (task.jira) return ticket(brainSlug("ticket", `jira/${task.jira.key}`), "jira", task.jira.key, task.jira.url);
  const source = task.source;
  if (source?.kind === "jira") return ticket(brainSlug("ticket", `jira/${source.key}`), "jira", source.key, source.url);
  if (source?.kind === "github") {
    const key = `${source.repo}#${source.number}`;
    return ticket(brainSlug("ticket", `github/${key}`), "github", key, source.url);
  }
  return [];
}

export interface BrainPull {
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  url: string;
  mergedAt: Date | string | null;
  author: string | null;
  /** A `pr.opened` event of the card named it. False when the card only came from it (an address card's source): the card that opened a PR owns it. */
  opened: boolean;
}

/** The author's Person row comes first, so a load finds the node an edge points at. */
export function prRows(pull: BrainPull, cardId: string | null): BrainRow[] {
  const slug = brainSlug("pr", `${pull.repo}#${pull.number}`);
  const login = pull.author?.trim().toLowerCase() || null;
  const person = login ? brainSlug("person", login) : null;
  const rows: BrainRow[] = [];
  if (login && person) rows.push(brainNode("Person", { slug: person, login }));
  rows.push(
    brainNode("PR", {
      slug,
      number: pull.number,
      title: safeTitle(pull.title),
      state: pull.state,
      url: pull.url,
      merged_at: pull.mergedAt ? brainTime(pull.mergedAt) : null,
    }),
  );
  if (person) rows.push(brainEdge("PrAuthoredBy", slug, person));
  if (cardId) rows.push(brainEdge("PrForCard", slug, cardSlug(cardId)));
  return rows;
}
