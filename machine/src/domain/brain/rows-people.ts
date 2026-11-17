// Rows of the company brain for people, the actors that write the graph, and a repository's
// components (RFC 0010). A person is a GitHub login and a Slack member id and nothing else: the
// type has no email, and the row is built from named fields, so an extra key a caller passes is lost.
import { brainEdge, brainNode, brainSlug, type BrainRow } from "@hardness/contracts";

import { safeTitle, type BrainRepo } from "./rows.ts";

const login = (value: string): string => value.trim().toLowerCase();

export function personRows(person: { login: string; slack?: string | null; active?: boolean }): BrainRow[] {
  return [brainNode("Person", { slug: brainSlug("person", login(person.login)), login: login(person.login), slack: person.slack ? login(person.slack) : null, active: person.active ?? true })];
}

/** The machine's own jobs, which write the graph on the owner's behalf. */
const AGENTS = [
  { actor: "luna-facts", name: "Luna: facts" },
  { actor: "luna-memories", name: "Luna: memories" },
  { actor: "luna-reader", name: "Luna: reader" },
] as const;

/** The owner and the three agents, each followed by its ActsFor edge: the owner answers for the agents. */
export function actorRows(owner: { actor: string; login: string }): BrainRow[] {
  const person = brainSlug("person", login(owner.login));
  const actors = [{ actor: owner.actor, kind: "human", name: login(owner.login) }, ...AGENTS.map((agent) => ({ ...agent, kind: "agent" }))];
  return [
    ...personRows({ login: owner.login }),
    ...actors.flatMap(({ actor, kind, name }): BrainRow[] => {
      const slug = brainSlug("actor", actor);
      return [brainNode("Actor", { slug, kind, name }), brainEdge("ActsFor", slug, person)];
    }),
  ];
}

const COMPONENTS_MAX = 40;
const NAME_MAX = 120;

/** A component's slug part: its name with every run of characters outside the safe set as one dash. */
const slugPart = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, "-");

/** Each distinct name once, in first-seen order. Two names that flatten to the same slug are one component, since one slug is one node. */
export function componentRows(names: readonly string[], repo: BrainRepo, cardId: string | null): BrainRow[] {
  const repoSlug = brainSlug("repo", repo.slug);
  const seen = new Set<string>();
  const rows: BrainRow[] = [];
  for (const raw of names) {
    if (raw.trim() === "") continue;
    // A model wrote the name: screened first, so a newline or an address never reaches a row. The slug is built from the screened name,
    // which is a fixed function of the raw one, so it stays stable and valid (`slugPart` flattens whatever the screen leaves, such as `[redacted]`).
    const name = safeTitle(raw).slice(0, NAME_MAX).trim();
    const slug = brainSlug("component", `${repo.slug}/${slugPart(name)}`);
    if (seen.has(slug)) continue;
    if (seen.size === COMPONENTS_MAX) break;
    seen.add(slug);
    rows.push(brainNode("Component", { slug, name, path: null }), brainEdge("ComponentInRepo", slug, repoSlug));
    if (cardId) rows.push(brainEdge("CardTouches", brainSlug("card", cardId), slug));
  }
  return rows;
}
