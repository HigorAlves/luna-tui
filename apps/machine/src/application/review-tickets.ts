// The Jira tickets a PR under review names: found in its title, head branch and body, read through the
// Jira port and mapped into the reviewing pack's `ReviewContext.tickets`, so the reviewer checks the diff
// against the ticket as well as the PR description. A ticket that cannot be read is skipped with a log
// line; it never fails a review, and without a Jira port there are none.
import type { ReviewTicket } from "@hardness/contracts";

import { type Jira, messageOf } from "./jira.ts";

/** More tickets than this on one PR is noise, and each is a Jira call. */
export const MAX_REVIEW_TICKETS = 3;
/** The description's cap in the context; the renderer quotes it as data and caps the whole block again. */
export const TICKET_DESCRIPTION_CAP = 6000;

const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]+)-(\d+)(?![A-Za-z0-9_])/g;

/** Prefixes that look like a Jira key and are a standard, an encoding or a hash. */
const NOT_A_PROJECT = new Set([
  "UTF", "ISO", "SHA", "MD", "RFC", "CVE", "CWE", "HTTP", "TLS", "SSL", "AES", "RSA", "TCP", "UDP", "ASCII", "BASE", "WCAG", "PEP", "ECMA", "IEEE", "RS", "HS", "ES", "CRC", "GB", "UCS", "BLAKE", "SHA3", "CSS", "HTML", "ARIA", "GPT", "COVID", "ANSI", "ISBN", "IPV", "X",
]);

/** The Jira keys a PR names: title, then head branch, then body; deduped, at most three. With `projects` (the Jira projects the
 *  machine knows), only keys of those projects; without, every key that is not a known non-issue like `UTF-8` or `SHA-256`. */
export function findPrJiraKeys(pr: { title: string; headRef: string; body: string | null }, projects: readonly string[] = []): string[] {
  const known = new Set(projects.map((p) => p.toUpperCase()));
  const keys: string[] = [];
  for (const text of [pr.title, pr.headRef, pr.body ?? ""]) {
    for (const m of text.matchAll(KEY)) {
      const project = m[1]!;
      if (known.size > 0 ? !known.has(project) : NOT_A_PROJECT.has(project)) continue;
      const key = `${project}-${m[2]}`;
      if (!keys.includes(key)) keys.push(key);
      if (keys.length === MAX_REVIEW_TICKETS) return keys;
    }
  }
  return keys;
}

const LABEL = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:acceptance criteria|acceptance criterion|definition of done)\s*:?\s*(?:\*\*|__)?\s*:?\s*(.*)$/i;
const HEADING = /^\s*#{1,6}\s+\S/;
const BOLD_ONLY = /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$/;

/** The acceptance criteria in a description, when it has a section for them: a heading or a bold or plain label line, then the
 *  lines up to the next heading (or label); text after the label on its own line counts. Null when there are none. */
export function acceptanceCriteriaOf(description: string): string | null {
  const lines = description.split("\n");
  const at = lines.findIndex((l) => LABEL.test(l));
  if (at === -1) return null;
  const inline = LABEL.exec(lines[at]!)![1]!.trim();
  const section: string[] = inline ? [inline] : [];
  for (const line of lines.slice(at + 1)) {
    if (HEADING.test(line) || BOLD_ONLY.test(line)) break;
    section.push(line);
  }
  const text = section.join("\n").trim();
  return text === "" ? null : text;
}

const capped = (text: string): string => (text.length > TICKET_DESCRIPTION_CAP ? `${text.slice(0, TICKET_DESCRIPTION_CAP)}\n[cut: ${text.length - TICKET_DESCRIPTION_CAP} more characters]` : text);

export interface TicketDeps {
  /** The Jira port; absent when Jira is not configured, which gives no tickets. */
  jira?: Jira | null;
  /** The Jira projects the machine knows for this PR's repo; none known (or no function) accepts any project key. */
  projects?: () => Promise<readonly string[]>;
  log?: (line: string) => void;
}

/** The tickets under `keys`, read from Jira in that order. Never throws: one that fails is skipped with a log line. */
export async function readTickets(jira: Jira, keys: readonly string[], log: (line: string) => void = (line) => console.warn(line)): Promise<ReviewTicket[]> {
  const read = await Promise.all(
    keys.map(async (key): Promise<ReviewTicket | null> => {
      try {
        const issue = await jira.issue(key);
        return {
          key: issue.key,
          url: issue.url,
          type: issue.issueType ?? "Issue",
          status: issue.status ?? "Unknown",
          summary: issue.summary,
          description: capped(issue.description),
          acceptanceCriteria: acceptanceCriteriaOf(issue.description),
        };
      } catch (error) {
        log(`review: skipping ${key}, Jira did not give it (${messageOf(error)})`);
        return null;
      }
    }),
  );
  return read.filter((t): t is ReviewTicket => t !== null);
}

/** The tickets the PR names, read from Jira. Never throws: one that fails is skipped with a log line. */
export async function gatherTickets(deps: TicketDeps, pr: { title: string; headRef: string; body: string | null }): Promise<ReviewTicket[]> {
  const { jira } = deps;
  if (!jira) return [];
  const log = deps.log ?? ((line: string) => console.warn(line));
  let projects: readonly string[] = [];
  try {
    projects = (await deps.projects?.()) ?? [];
  } catch (error) {
    log(`review: the repo's Jira projects could not be read (${messageOf(error)}); accepting any project key`);
  }
  return readTickets(jira, findPrJiraKeys(pr, projects), log);
}
