// The Ticket Machine: a ticket in scope is read, checked for validity, assessed, recommended, and its replies drafted, and then it WAITS. The
// rule of this wave: nothing leaves the machine without a person's tap. `ingest` never calls a writing method of the `Tickets` port and never makes
// a card; only `approve`, `edit` and `card`, each started by a person's request, do. A clock or an event handler has no path to them.
import { createHash } from "node:crypto";

import type { BacklogAddInput, CanonicalTicket, FactoryConfig, TaskSource, TicketContext } from "@hardness/contracts";

import { IdempotencyConflictError } from "../domain/task.ts";
import { carriesSecret } from "../domain/postable.ts";
import type { Candidate } from "../domain/similarity.ts";
import { buildValidityContext } from "./ticket-validity.ts";
import type { AssessAnswer } from "../domain/ticket-score.ts";
import { type AssessDeps, type AssessmentRecord, assessTicket } from "./ticket-assess.ts";
import { type Draft, type RecommendDeps, type ReplyDeps, assessmentDraft, declineDraft, parkDraft, reminderDraft, editDraft, ignoreDraft, needsInfoDraft, notOursDraft, recommendWithDecision } from "./ticket-drafts.ts";
import { ticketClocks } from "../domain/ticket-sla.ts";
import { enrichTicket } from "./ticket-enrich.ts";
import { type ValidityDeps, checkValidity } from "./ticket-validity.ts";
import type { NewTask } from "./pipeline.ts";
import type { TicketRow, TicketStore, Tickets } from "./tickets.ts";

/** What the intakes hand a ticket to. */
export interface TicketIntake {
  ingest(ticket: CanonicalTicket, ctx: { repoPath: string | null; question: boolean; force?: boolean }): Promise<unknown>;
}

export class TicketNotFound extends Error {
  constructor(key: string) {
    super(`no ticket ${key.slice(0, 80)}`);
    this.name = "TicketNotFound";
  }
}

/** A tap the machine will not carry out, with the reason a person can read. */
export class TicketRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketRefusal";
  }
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,40}-\d{1,9}$/;
const GITHUB_KEY = /^([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})$/;

/** A key from a request, checked before it reaches a store or an adapter. */
export function parseTicketKey(raw: string): string {
  if (raw.length > 250 || !(JIRA_KEY.test(raw) || GITHUB_KEY.test(raw))) throw new TicketNotFound(raw);
  return raw;
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

export type DraftView = Draft & { hash: string };
export interface TicketView {
  key: string;
  canonical: CanonicalTicket;
  status: string | null;
  assessments: Record<string, unknown>[];
  drafts: DraftView[];
  cardId: string | null;
  clocks: Record<string, unknown>;
}

export interface TicketMachineDeps {
  store: TicketStore;
  /** The tracker port for a tool: used only by a tap. */
  port(tool: CanonicalTicket["tool"]): Tickets;
  /** The cards and backlog items this ticket's audience may see: filtered by `canSeeKept` against its reporter, failing closed. */
  candidates(ticket: CanonicalTicket, repoPath: string | null): Promise<Candidate[]>;
  config(repoPath: string | null): Promise<FactoryConfig>;
  locate?(repoPath: string | null, text: string): Promise<string[]>;
  /** Makes a card through `create_card`, once per `key`: a second call with the key answers the card the first made (`cardOnce`). */
  createCard(input: NewTask, key: string): Promise<{ id: string }>;
  validity: ValidityDeps;
  assess: Pick<AssessDeps, "decide">;
  recommend: RecommendDeps;
  reply: ReplyDeps;
  /** The shared backlog, for `schedule` and for keeping an item's rank in step with a re-assessment. */
  /** Ground truth: what a tap says about the decision `ticket_recommend` made (the decision log's `learned`), and what was done to a draft (a file beside a gate's). Absent: nothing is kept. */
  truth?: {
    learned(fact: { pack: "ticket_recommend"; recordId: string; label: Record<string, Record<string, unknown>>; source: string }): Promise<boolean>;
    draft(entry: { key: string; draft: string; kind: string; did: "sent" | "edited" | "ignored"; original: string; final: string | null; at: string }): Promise<void>;
  };
  backlog?: { upsertFromSource(input: BacklogAddInput, options: { createIfMissing: boolean }): Promise<{ id: string; created: boolean } | null> };
  now?: () => Date;
}

/** The card for `key`, made once: a retry after a crash (or a retaken claim) answers the card already made, even when the order's body changed since (a reassessment moved a hint). */
export async function cardOnce(pipeline: { createTaskOnce(order: NewTask & Record<string, unknown>, key: string): Promise<{ task: { id: string } }> }, input: NewTask, key: string): Promise<{ id: string }> {
  try {
    return { id: (await pipeline.createTaskOnce(input as NewTask & Record<string, unknown>, key)).task.id };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) return { id: error.taskId };
    throw error;
  }
}

/** How long a claim on a ticket's card creation holds before a retry may take it (a machine that died between the card and the link; the card's own key then returns the card already made). */
const CARD_CLAIM_MS = 10 * 60_000;

const sourceOf = (t: CanonicalTicket): TaskSource => {
  const gh = GITHUB_KEY.exec(t.key);
  if (t.tool === "github" && gh) return { kind: "github", repo: `${gh[1]}/${gh[2]}`, number: Number(gh[3]), url: t.permalink };
  return { kind: "jira", key: t.key, url: t.permalink, issueType: t.type };
};

export class TicketMachine implements TicketIntake {
  private readonly now: () => Date;
  constructor(private readonly deps: TicketMachineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Reads a ticket and holds its drafts. Writes nothing to the tracker and makes no card. */
  async ingest(ticket: CanonicalTicket, ctx: { repoPath: string | null; question: boolean; force?: boolean }): Promise<void> {
    const { store } = this.deps;
    const prev = await store.get(ticket.key);
    if (!ctx.force && prev?.machineStatus && prev.machineStatus !== "validity_failed" && prev.canonical.updatedAt === ticket.updatedAt) return;
    await store.read(ticket);
    const at = this.now();
    let refused: string | null = null;
    const done = async (status: string, assessment: Record<string, unknown>, drafts: Draft[]) => {
      await store.appendAssessment(ticket.key, { at: at.toISOString(), ...assessment, ...(refused ? { draftRefused: refused } : {}) });
      // Under the row lock: a draft being posted or already posted is never rewritten, and a new draft with the same id is dropped.
      await store.updateDrafts(ticket.key, (current) => {
        const keep = (current as unknown as Draft[]).filter((d) => d.status === "posting" || d.status === "posted");
        const added: Draft[] = [];
        for (const f of drafts) {
          if (!keep.some((k) => k.id === f.id)) added.push(f);
          // An assessment after one was posted is new information: a draft of its own, unless it says what the posted one said.
          else if (f.kind === "assessment" && !keep.some((k) => k.kind === "assessment" && k.text === f.text)) added.push({ ...f, id: `${f.id}:${keep.filter((k) => k.kind === "assessment").length + 1}` });
        }
        return [...keep, ...added] as unknown as Record<string, unknown>[];
      });
      await store.setMachine(ticket.key, { status, ...(ctx.repoPath ? { links: [{ kind: "repo", target: ctx.repoPath }] } : {}) });
    };
    const config = await this.deps.config(ctx.repoPath);
    const candidates = await this.deps.candidates(ticket, ctx.repoPath);
    const enrichment = await enrichTicket(ticket, { candidates, ...(this.deps.locate ? { locate: (text: string) => this.deps.locate!(ctx.repoPath, text) } : {}), lookbackDays: config.dedup.lookback_days }, at);
    const base = buildValidityContext(ticket, enrichment, candidates);

    if (ctx.question) {
      const decline = await declineDraft(this.deps.reply, ticket.key, base, (why) => (refused = why));
      return done("question", { outcome: "question" }, decline ? [decline] : []);
    }
    const validity = await checkValidity(this.deps.validity, ticket, enrichment, candidates);
    if (!validity) return done("validity_failed", { outcome: "validity_failed" }, []);
    if (validity.outcome === "duplicate") return done("duplicate", { outcome: "duplicate", duplicateOf: validity.duplicateOf }, []);
    if (validity.outcome === "not_ours") return done("not_ours", { outcome: "not_ours" }, [notOursDraft(ticket.key, null)]);
    if (validity.outcome === "needs_info") {
      const bug = (ticket.type ?? "").toLowerCase() === "bug";
      if (bug && validity.criteriaMet === false && validity.reporterReachable === false) {
        return done("parked", { outcome: "parked", reason: "a bug that cannot be reproduced, with no reporter to ask" }, []);
      }
      await done("needs_info", { outcome: "needs_info", missing: validity.missing }, [needsInfoDraft(ticket.key, validity.missing)]);
      await this.mergeClocks(ticket.key, { needsInfoSince: at.toISOString() });
      return;
    }
    const record = await assessTicket({ decide: this.deps.assess.decide }, ticket, enrichment, validity, config, at, { candidates });
    if (!record) return done("validity_failed", { outcome: "assess_failed" }, []);
    const { subScores: _kept, ...head } = record;
    const context: TicketContext = { ...base, assessment: { priority: record.priority, size: record.size, blastRadius: record.blastRadius, costOfDelay: record.costOfDelay, costOfDoing: record.costOfDoing, score: record.score } };
    const recommendation = await recommendWithDecision(this.deps.recommend, record, context);
    const drafts = [assessmentDraft(ticket.key, record, recommendation.action === "split" ? null : recommendation.action)];
    if (recommendation.action === "decline") {
      const decline = await declineDraft(this.deps.reply, ticket.key, context, (why) => (refused = why));
      if (decline) drafts.push(decline);
    }
    await done("assessed", { outcome: "workable", ...head, subScores: record.subScores, recommendation }, drafts);
    // A ticket already in the backlog keeps its rank in step with the new assessment (updated, never added).
    if (prev?.machineStatus === "scheduled" && this.deps.backlog) {
      const updated = await this.deps.backlog.upsertFromSource(backlogInput(ticket, ctx.repoPath, record), { createIfMissing: false }).catch(() => null);
      if (updated) await store.setMachine(ticket.key, { status: "scheduled" });
    }
  }

  /** Places the ticket in the shared backlog by its score, or updates its item. A tap. Nothing is written to the ticket. */
  async schedule(key: string): Promise<{ id: string; created: boolean }> {
    const row = await this.row(key);
    const last = [...row.assessments].reverse().find((a) => a.outcome === "workable");
    if (!last || !this.deps.backlog) throw new TicketRefusal("only a ticket assessed as workable goes to the backlog");
    const repo = row.machineLinks.find((l) => l.kind === "repo")?.target ?? null;
    const placed = await this.deps.backlog.upsertFromSource(backlogInput(row.canonical, repo, last as unknown as AssessmentRecord), { createIfMissing: true });
    if (!placed) throw new TicketRefusal("the backlog did not take the ticket");
    await this.deps.store.setMachine(key, { status: "scheduled" });
    await this.acknowledge(key);
    await this.learn(row, "schedule");
    return placed;
  }

  /** A backlog item that came from a ticket was declined: the decline reply is drafted on the ticket, behind a tap. Posts nothing. */
  async declineFromBacklog(sources: unknown[]): Promise<void> {
    for (const s of sources) {
      const x = s as Record<string, unknown>;
      const key = x.kind === "jira" && typeof x.key === "string" ? x.key : x.kind === "github" ? `${String(x.repo)}#${String(x.number)}` : null;
      if (!key || !(JIRA_KEY.test(key) || GITHUB_KEY.test(key))) continue;
      const row = await this.deps.store.get(key);
      if (!row) continue;
      const last = [...row.assessments].reverse().find((a) => a.outcome === "workable") as unknown as AssessmentRecord | undefined;
      const empty = { linked: [], epic: null, recent: [], files: [], shortlist: [] };
      const base = buildValidityContext(row.canonical, empty, []);
      const context: TicketContext = last ? { ...base, assessment: { priority: last.priority, size: last.size, blastRadius: last.blastRadius, costOfDelay: last.costOfDelay, costOfDoing: last.costOfDoing, score: last.score } } : base;
      const draft = await declineDraft(this.deps.reply, key, context);
      if (!draft) continue;
      await this.deps.store.updateDrafts(key, (current) => {
        const ds = current as unknown as Draft[];
        const busy = ds.find((d) => d.id === draft.id && (d.status === "posting" || d.status === "posted"));
        return (busy ? ds : [...ds.filter((d) => d.id !== draft.id), draft]) as unknown as Record<string, unknown>[];
      });
    }
  }

  async list(): Promise<TicketView[]> {
    return (await this.deps.store.list()).map(viewOf);
  }

  async view(key: string): Promise<TicketView> {
    return viewOf(await this.row(key));
  }

  /** Posts the draft the person saw (by its hash), and with `transition` moves the ticket too. A tap. */
  async approve(key: string, tap: { draft: string; hash: string; transition?: string }): Promise<void> {
    const row = await this.row(key);
    const draft = this.draftOf(row, tap.draft, tap.hash);
    await this.post(row, draft, draft, tap.hash, tap.transition);
    await this.keep(row, draft, "sent", null);
  }

  /** Posts the person's own text in place of the draft's, through `postable()`, after the token check. A tap. */
  async edit(key: string, tap: { draft: string; hash: string; text: string; transition?: string }): Promise<void> {
    const row = await this.row(key);
    const draft = this.draftOf(row, tap.draft, tap.hash);
    const edited = editDraft(draft, tap.text, this.now());
    if (!edited) throw new TicketRefusal("the text carries a token-shaped string and is not posted");
    await this.post(row, draft, edited, tap.hash, tap.transition);
    await this.keep(row, draft, "edited", edited.text);
  }

  async ignore(key: string, tap: { draft: string }): Promise<void> {
    const row = await this.row(key);
    const drafts = row.drafts as unknown as Draft[];
    const draft = drafts.find((d) => d.id === tap.draft);
    if (!draft) throw new TicketRefusal("no such draft on this ticket");
    await this.deps.store.updateDrafts(key, (current) => (current as unknown as Draft[]).map((d) => (d.id === draft.id && (d.status === "waiting" || d.status === "edited") ? ignoreDraft(d, this.now()) : d)) as unknown as Record<string, unknown>[]);
    await this.acknowledge(key);
    await this.keep(row, draft, "ignored", null);
  }

  /** Makes one card from the ticket, with its link as the source and the assessment as lower-confidence hints. A tap. Nothing is written to the ticket. */
  async card(key: string): Promise<{ id: string }> {
    const row = await this.row(key);
    if (row.cardId) throw new TicketRefusal("this ticket already has a card");
    const t = row.canonical;
    const last = [...row.assessments].reverse().find((a) => a.outcome === "workable");
    const repo = row.machineLinks.find((l) => l.kind === "repo")?.target;
    // Claimed under the row lock before the card exists: two taps, or a retry after a crash, cannot both make one.
    if (!(await this.deps.store.claimCard(key, this.now(), CARD_CLAIM_MS))) throw new TicketRefusal("this ticket already has a card, or one is being made for it");
    let card: { id: string };
    try {
      card = await this.deps.createCard({
      title: t.title,
      description: t.description,
      ...(repo ? { repoPath: repo } : {}),
      source: sourceOf(t),
      // Linked only to its own source: no Jira key is looked for in the text a stranger wrote.
      noJiraDetection: true,
      ...(t.reporter ? { reporter: { id: t.reporter.id, channel: t.tool } } : {}),
      ...(last ? { hints: { size: String(last.size), urgency: String(last.priority) } } : {}),
    } as NewTask, `ticket-card:${t.key}`);
    } catch (error) {
      await this.deps.store.releaseCard(key).catch(() => {});
      throw error;
    }
    await this.deps.store.setMachine(key, { cardId: card.id, status: "carded" });
    await this.acknowledge(key);
    await this.learn(row, "do_now");
    return card;
  }

  private async row(key: string): Promise<TicketRow> {
    const row = await this.deps.store.get(parseTicketKey(key));
    if (!row) throw new TicketNotFound(key);
    return row;
  }

  private draftOf(row: TicketRow, id: string, hash: string): Draft {
    const draft = (row.drafts as unknown as Draft[]).find((d) => d.id === id);
    if (!draft) throw new TicketRefusal("no such draft on this ticket");
    if (draft.status === "posting") throw new TicketRefusal("the draft is being posted right now");
    if (draft.status === "posted" || draft.status === "ignored") throw new TicketRefusal(`the draft is already ${draft.status}`);
    if (hashOf(draft.text) !== hash) throw new TicketRefusal("the draft changed since you read it: read it again");
    return draft;
  }

  /** Posts `to` in place of `before`. The draft is marked `posting` by a conditional change under the row lock BEFORE the port is called (only a waiting or edited draft with the hash the person saw can move), `posted` after; a failed post puts it back. Two taps in flight post once. */
  private async post(row: TicketRow, before: Draft, to: Draft, hash: string, transition: string | undefined): Promise<void> {
    if (transition !== undefined && row.canonical.tool === "github") throw new TicketRefusal("a GitHub issue has no transition the machine makes: approve without one");
    if (carriesSecret(to.text)) throw new TicketRefusal("the text carries a token-shaped string and is not posted");
    const port = this.deps.port(row.canonical.tool);
    let claimed = false;
    await this.deps.store.updateDrafts(row.key, (current) => {
      const ds = current as unknown as Draft[];
      const cur = ds.find((d) => d.id === before.id);
      if (!cur || (cur.status !== "waiting" && cur.status !== "edited") || hashOf(cur.text) !== hash) return current;
      claimed = true;
      return ds.map((d) => (d.id === before.id ? { ...to, status: "posting" as const } : d)) as unknown as Record<string, unknown>[];
    });
    if (!claimed) throw new TicketRefusal("the draft is already being posted, or it changed since you read it");
    try {
      await port.comment(row.key, to.text);
    } catch (error) {
      await this.deps.store.updateDrafts(row.key, (current) => (current as unknown as Draft[]).map((d) => (d.id === before.id && d.status === "posting" ? before : d)) as unknown as Record<string, unknown>[]);
      throw error;
    }
    // The comment is out: the draft is posted whatever the transition does next, so a second tap cannot post it again.
    const at = this.now().toISOString();
    await this.deps.store.updateDrafts(row.key, (current) => (current as unknown as Draft[]).map((d) => (d.id === before.id ? { ...d, status: "posted" as const, history: [...to.history, { at, did: "posted" as const, from: before.text }] } : d)) as unknown as Record<string, unknown>[]);
    if (before.kind === "park") await this.deps.store.setMachine(row.key, { status: "parked" });
    if (transition !== undefined) {
      try {
        await port.transition(row.key, transition);
      } catch {
        throw new TicketRefusal("the comment was posted, but the transition did not happen: make it in the ticket's own tool");
      }
    }
    await this.acknowledge(row.key);
  }

  /** What was done to a draft is kept with it (sent as drafted, edited with the text before and after, ignored), and a person's taking or leaving a recommendation is ground truth. Never throws: a truth is a bonus. */
  private async keep(row: TicketRow, draft: Draft, did: "sent" | "edited" | "ignored", final: string | null): Promise<void> {
    try {
      await this.deps.truth?.draft({ key: row.key, draft: draft.id, kind: draft.kind, did, original: draft.original ?? draft.text, final, at: this.now().toISOString() });
      if (did === "ignored") return;
      const chosen = draft.kind === "decline" ? "decline" : draft.kind === "park" ? "needs_decision" : null;
      if (chosen) await this.learn(row, chosen);
    } catch (error) {
      console.warn(`ticket truth: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The label of what the person chose, on the `ticket_recommend` record behind the recommendation: confirmed when it is what was recommended, an override when not. No record (the rule decided, no engine ran) labels nothing. */
  private async learn(row: TicketRow, chosen: string): Promise<void> {
    try {
      const last = [...row.assessments].reverse().find((a) => a.outcome === "workable") as { recommendation?: { action?: string; recordId?: string } } | undefined;
      const recordId = last?.recommendation?.recordId;
      if (!recordId || !this.deps.truth) return;
      await this.deps.truth.learned({ pack: "ticket_recommend", recordId, label: { action: { choice: chosen } }, source: last?.recommendation?.action === chosen ? "ticket_confirmed" : "ticket_override" });
    } catch (error) {
      console.warn(`ticket truth: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async mergeClocks(key: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.deps.store.get(key);
    if (row) await this.deps.store.setClocks(key, { ...row.clocks, ...patch });
  }

  /** A person tapped: the acknowledge clock stops. */
  private async acknowledge(key: string): Promise<void> {
    const row = await this.deps.store.get(key);
    if (row && !row.clocks.acknowledgedAt) await this.mergeClocks(key, { acknowledgedAt: this.now().toISOString() });
  }

  /** Computes every ticket's clocks, keeps them on the ticket (the board shows an overdue one), and drafts what an overdue waiting clock leads to: a reminder, then a park. A clock posts nothing and approves nothing. */
  async sweepClocks(now: Date = this.now()): Promise<Array<{ key: string; overdue: string[] }>> {
    const out: Array<{ key: string; overdue: string[] }> = [];
    for (const row of await this.deps.store.list()) {
      const repo = row.machineLinks.find((l) => l.kind === "repo")?.target ?? null;
      const config = (await this.deps.config(repo)).tickets;
      const last = [...row.assessments].reverse().find((a) => a.outcome === "workable") as { priority?: "P0" | "P1" | "P2" | "P3" } | undefined;
      const since = typeof row.clocks.needsInfoSince === "string" ? new Date(row.clocks.needsInfoSince) : null;
      const clocks = ticketClocks({ firstSeenAt: row.createdAt, acknowledgedAt: typeof row.clocks.acknowledgedAt === "string" ? new Date(row.clocks.acknowledgedAt) : null, priority: last?.priority ?? null, status: row.machineStatus, needsInfoSince: since, updatedAt: activityOf(row) }, now, config);
      const overdue = clocks.filter((c) => c.overdue).map((c) => c.name);
      const drafts = row.drafts as unknown as Draft[];
      const missing = ([...row.assessments].reverse().find((a) => a.outcome === "needs_info")?.missing as string[] | undefined) ?? [];
      const add: Draft[] = [];
      if (overdue.includes("needs_info_reminder") && !drafts.some((d) => d.kind === "reminder")) add.push(reminderDraft(row.key, missing));
      if (overdue.includes("needs_info_park") && !drafts.some((d) => d.kind === "park")) add.push(parkDraft(row.key));
      if (add.length) await this.deps.store.updateDrafts(row.key, (current) => [...current, ...add.filter((a) => !(current as unknown as Draft[]).some((d) => d.id === a.id))] as unknown as Record<string, unknown>[]);
      await this.mergeClocks(row.key, { computed: clocks.map((c) => ({ name: c.name, dueAt: c.dueAt.toISOString(), overdue: c.overdue })), overdue });
      if (overdue.length) out.push({ key: row.key, overdue });
    }
    return out;
  }
}

/** The last time the tool says the ticket changed; the row's own `updated_at` moves with every clock the machine writes, so it dates nothing. */
function activityOf(row: TicketRow): Date {
  const at = new Date(row.canonical.updatedAt ?? "");
  return Number.isNaN(at.getTime()) ? row.createdAt : at;
}

/** The backlog item for a ticket: its five urgency sub-scores as the scores, its size, and its ticket as the source. */
function backlogInput(t: CanonicalTicket, repo: string | null, r: AssessmentRecord): BacklogAddInput {
  const v = (k: "who" | "what" | "impact" | "time" | "demand") => Math.min(3, Math.max(1, r.subScores[k].value));
  return {
    title: t.title.slice(0, 300),
    text: t.description.slice(0, 4000),
    sources: [sourceOf(t)],
    repo,
    scores: { who: v("who"), what: v("what"), impact: v("impact"), time: v("time"), demand: v("demand") },
    size: r.size,
    dependsOn: [],
  };
}

function viewOf(row: TicketRow): TicketView {
  return { key: row.key, canonical: row.canonical, status: row.machineStatus, assessments: row.assessments, drafts: (row.drafts as unknown as Draft[]).map((d) => ({ ...d, hash: hashOf(d.text) })), cardId: row.cardId, clocks: row.clocks };
}
void (null as unknown as AssessAnswer);
