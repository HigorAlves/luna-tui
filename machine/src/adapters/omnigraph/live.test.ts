// Runs against a real omnigraph-server booted from brain/: `BRAIN_LIVE_URL` says where, and
// `BRAIN_LIVE_FACTS_TOKEN` and `BRAIN_LIVE_READER_TOKEN` are its tokens. Skipped otherwise.
// It is the one test that proves the rows, the schema and the stored queries agree with a server.
import { BRAIN_QUERIES, type BrainRow, brainEdge, brainNode, brainTime } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { agentQuery, BrainError } from "../../application/brain.ts";
import { brainBatches } from "../../domain/brain/batches.ts";
import { actorRows, componentRows } from "../../domain/brain/rows-people.ts";
import { prRows, repoRows } from "../../domain/brain/rows.ts";
import { omnigraphBrain } from "./brain.ts";
import { omnigraphClient } from "./client.ts";

describe.skipIf(!process.env.BRAIN_LIVE_URL)("omnigraph, live", () => {
  // The body of a skipped suite still runs once to collect its tests, so no url is no error here.
  const client = omnigraphClient({ baseUrl: process.env.BRAIN_LIVE_URL ?? "", graph: process.env.BRAIN_LIVE_GRAPH ?? "brain" });
  const facts = process.env.BRAIN_LIVE_FACTS_TOKEN ?? "";
  const brain = omnigraphBrain({ client, tokens: { facts, memories: facts, reader: process.env.BRAIN_LIVE_READER_TOKEN ?? "" } });
  // A new id per run: the graph keeps what earlier runs wrote.
  const id = `live${Date.now()}`;
  const repo = { slug: id, name: id };
  const card = `card:${id}`;
  const at = brainTime("2026-11-16T12:00:00Z");

  const rows: BrainRow[] = [
    // listed out of order on purpose: the batches put a node after what its edges point at
    ...prRows({ repo: `acme/${id}`, number: 7, title: "Wire the egress proxy", state: "merged", url: "https://example.test/pr/7", mergedAt: at, author: "Octo-Cat" }, id),
    brainNode("Card", { slug: card, title: `Sandbox egress proxy ${id}`, state: "closed", route: "feature", size: "M", risk: "low", est_loc: 300, actual_loc: 412, retries: 2, escalations: 0, opened_at: at, closed_at: at }),
    brainEdge("CardInRepo", card, `repo:${id}`),
    brainEdge("CardForTicket", card, `ticket:jira/${id}-1`),
    brainNode("Ticket", { slug: `ticket:jira/${id}-1`, tracker: "jira", key: `${id}-1`, title: "Sandbox egress proxy", url: null }),
    ...componentRows(["Stage Runner"], repo, id),
    brainNode("Verdict", { slug: `verdict:risk_score/${id}/risk`, pack: `risk_score_${id}`, question: "risk", answer: "1", confidence: 0.8, truth: "2", truth_source: "outcome", decided_at: at }),
    brainEdge("VerdictOn", `verdict:risk_score/${id}/risk`, card),
    // the same owner every run: an agent answers to one person, and the graph keeps earlier runs
    ...actorRows({ actor: "owner", login: "live-owner" }),
    // evidence and facts: a source, two claims that disagree, and a lesson that rests on the verified one
    brainNode("Learning", { slug: `learning:${id}`, title: `Run the board lint before a commit ${id}`, kind: "pattern", scope: "repo", recorded_at: at }),
    brainEdge("BasedOn", `learning:${id}`, `claim:${id}-a`),
    brainEdge("LearningAboutRepo", `learning:${id}`, `repo:${id}`),
    brainNode("Claim", { slug: `claim:${id}-a`, statement: `The board lint must be clean before a commit ${id}`, quote: "cargo clippy must be clean before every commit", kind: "pattern", scope: "repo", status: "verified", risk: "low", decided_by: "jev", recorded_at: at, decided_at: at }),
    brainEdge("ClaimFrom", `claim:${id}-a`, `source:card/${id}`),
    brainEdge("ClaimAboutRepo", `claim:${id}-a`, `repo:${id}`),
    brainNode("Claim", { slug: `claim:${id}-b`, statement: `The board lint may be skipped for a docs change ${id}`, quote: "a docs change gets no board check", kind: "pattern", scope: "repo", status: "unverified", recorded_at: at }),
    brainEdge("ClaimFrom", `claim:${id}-b`, `source:card/${id}`),
    brainEdge("Contradicts", `claim:${id}-b`, `claim:${id}-a`),
    // a rule of the repository, and one that left its file
    brainNode("Principle", { slug: `principle:${id}/a1`, statement: `Run the board lint before every commit ${id}`, section: "Critical rules", status: "active", recorded_at: at }),
    brainEdge("PrincipleOfRepo", `principle:${id}/a1`, `repo:${id}`),
    brainNode("Principle", { slug: `principle:${id}/b2`, statement: `An old rule nobody follows ${id}`, section: "Critical rules", status: "retired", recorded_at: at }),
    brainEdge("PrincipleOfRepo", `principle:${id}/b2`, `repo:${id}`),
    brainNode("Source", { slug: `source:card/${id}`, kind: "card", title: `Sandbox egress proxy ${id}`, occurred_at: at }),
    brainEdge("SourceOfCard", `source:card/${id}`, card),
    ...repoRows(repo),
  ];

  it("loads every row type the machine builds, in loads the server accepts", async () => {
    const batches = brainBatches(rows);
    let entities = 0;
    for (const batch of batches) entities += (await brain.load(batch)).entities;
    expect(entities).toBe(rows.length);
  });

  it("answers every query an agent may run, with every column present", async () => {
    const params: Record<string, Record<string, string>> = {
      card_lookup: { card },
      search_cards: { q: `egress ${id}` },
      cards_in_repo: { repo: `repo:${id}` },
      cards_touching: { component: `component:${id}/Stage-Runner` },
      prs_for_card: { card },
      verdicts_for_card: { card },
      verdicts_of_pack: { pack: `risk_score_${id}` },
      cards_for_ticket: { ticket: `ticket:jira/${id}-1` },
      search_components: { q: "stage runner" },
      search_learnings: { q: `board lint ${id}` },
      learnings_of_repo: { repo: `repo:${id}` },
      claims_of_learning: { learning: `learning:${id}` },
      principles_of_repo: { repo: `repo:${id}` },
      search_principles: { q: `board lint ${id}` },
    };
    for (const query of BRAIN_QUERIES.filter((q) => q.agent)) {
      const answer = await agentQuery(brain, query.name, params[query.name]);
      expect(answer.note, query.name).toBeNull();
      expect(answer.rows.length, query.name).toBeGreaterThan(0);
    }
    const [looked] = (await agentQuery(brain, "card_lookup", { card })).rows;
    expect(looked).toMatchObject({ card, est_loc: 300, actual_loc: 412, retries: 2, escalations: 0, opened_at: at, closed_at: at });
    const [pull] = (await agentQuery(brain, "prs_for_card", { card })).rows;
    expect(pull).toMatchObject({ pr: `pr:acme/${id}#7`, number: 7, state: "merged", merged_at: at });
  });

  it("derives what is contested and what is at risk from the claims' status", async () => {
    const mine = (rows: Array<Record<string, unknown>>, key: string) => rows.filter((row) => String(row[key]).includes(id));
    expect(mine((await brain.query("contested_claims")).rows, "claim")).toEqual([expect.objectContaining({ claim: `claim:${id}-b`, contradicts: `claim:${id}-a` })]);
    expect(mine((await brain.query("learnings_at_risk")).rows, "learning")).toEqual([]);
    expect(mine((await brain.query("similar_claims", { q: `board lint ${id}` })).rows, "claim").length).toBe(2);
    // the verified claim is rejected later: its words stay, its status moves, and the lesson on it shows as at risk
    await brain.load([brainNode("Claim", { slug: `claim:${id}-a`, statement: `The board lint must be clean before a commit ${id}`, quote: "cargo clippy must be clean before every commit", kind: "pattern", scope: "repo", status: "rejected", risk: "low", decided_by: "person", recorded_at: at, decided_at: at })]);
    expect(mine((await brain.query("learnings_at_risk")).rows, "learning")).toEqual([expect.objectContaining({ learning: `learning:${id}`, claim: `claim:${id}-a` })]);
    // and no agent reads that lesson any more: it is still in the graph, but its claim no longer stands
    expect(mine((await agentQuery(brain, "search_learnings", { q: `board lint ${id}` })).rows, "learning")).toEqual([]);
    expect(mine((await agentQuery(brain, "learnings_of_repo", { repo: `repo:${id}` })).rows, "learning")).toEqual([]);
    expect(mine((await brain.query("contested_claims")).rows, "claim")).toEqual([]);
    // a retired rule is in the graph and no agent reads it
    expect((await agentQuery(brain, "principles_of_repo", { repo: `repo:${id}` })).rows.map((row) => row.principle)).toEqual([`principle:${id}/a1`]);
    // a pack's own past answers on cards like this one, with what really happened
    const precedents = (await brain.query("precedents", { pack: `risk_score_${id}`, q: `egress proxy ${id}` })).rows;
    expect(precedents[0]).toMatchObject({ card, question: "risk", answer: "1", truth: "2", truth_source: "outcome" });
    // an agent may not run the machine's own queries
    expect((await agentQuery(brain, "similar_claims", { q: "lint" })).note).toMatch(/not a query an agent may run/);
  });

  it("finds nothing wrong: every hygiene query returns no row", async () => {
    for (const query of BRAIN_QUERIES.filter((q) => q.hygiene)) expect((await brain.query(query.name)).rows, query.name).toEqual([]);
  });

  it("writes a whole row again without losing a field, and nulls one that is now null", async () => {
    await brain.load([brainNode("Card", { slug: card, title: `Sandbox egress proxy ${id}`, state: "closed", route: "feature", size: "M", risk: null, est_loc: 300, actual_loc: 412, retries: 2, escalations: 0, opened_at: at, closed_at: at }), brainEdge("CardInRepo", card, `repo:${id}`)]);
    const [looked] = (await agentQuery(brain, "card_lookup", { card })).rows;
    expect(looked).toMatchObject({ size: "M", risk: null, est_loc: 300 });
  });

  it("moves an edge that allows one target by removing the old one first", async () => {
    const second = [brainNode("Ticket", { slug: `ticket:jira/${id}-9`, tracker: "jira", key: `${id}-9`, title: "Moved", url: null }), brainEdge("CardForTicket", card, `ticket:jira/${id}-9`)];
    await expect(brain.unlink("CardForTicket", card)).resolves.toBe(1);
    await brain.load(second);
    await expect(brain.unlink("CardForTicket", card, `ticket:jira/${id}-9`)).resolves.toBe(1);
    await brain.load([brainEdge("CardForTicket", card, `ticket:jira/${id}-1`)]);
  });

  it("refuses a second ticket for a card, and writes nothing of that load", async () => {
    const second = [brainNode("Ticket", { slug: `ticket:jira/${id}-2`, tracker: "jira", key: `${id}-2`, title: "Another", url: null }), brainEdge("CardForTicket", card, `ticket:jira/${id}-2`)];
    await expect(brain.load(second)).rejects.toBeInstanceOf(BrainError);
  });

  // Wipes the graph it is pointed at, so it runs only when asked.
  it.skipIf(!process.env.BRAIN_LIVE_RESET)("empties the graph, and loads it again to the same answer", async () => {
    await brain.reset();
    expect((await agentQuery(brain, "card_lookup", { card })).rows).toEqual([]);
    for (const query of BRAIN_QUERIES.filter((q) => q.hygiene)) expect((await brain.query(query.name)).rows, query.name).toEqual([]);
    for (const batch of brainBatches(rows)) await brain.load(batch);
    const again = (await agentQuery(brain, "card_lookup", { card })).rows;
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ card, size: "M", risk: "low", est_loc: 300, actual_loc: 412 });
    expect((await agentQuery(brain, "prs_for_card", { card })).rows).toHaveLength(1);
  });
});
