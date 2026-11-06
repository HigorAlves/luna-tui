// The Ticket Machine: a ticket in scope is read, checked for validity, assessed, recommended, and its replies drafted, and then it WAITS. The
// rule of this wave: nothing leaves the machine without a person's tap. `ingest` never calls a writing method of the `Tickets` port and never makes
// a card; only `approve`, `edit` and `card`, each started by a person's request, do. A clock or an event handler has no path to them.
import { createHash } from "node:crypto";

import { type BacklogAddInput, SplitChild, type CanonicalTicket, type FactoryConfig, PACKS, type SizeContext, type SplitContext, type TaskSource, type TicketContext, applyPolicy, sizeLimits, sizeVerdict } from "@hardness/contracts";

import { z } from "zod";

import { carriesSecret, postable } from "../domain/postable.ts";
import { decompositionLoop } from "./stages/decompose.ts";
import type { Candidate } from "../domain/similarity.ts";
import { buildValidityContext } from "./ticket-validity.ts";
import type { AssessAnswer } from "../domain/ticket-score.ts";
import { type AssessDeps, type AssessmentRecord, assessTicket } from "./ticket-assess.ts";
import { type Draft, type RecommendDeps, type ReplyDeps, assessmentDraft, declineDraft, parkDraft, reminderDraft, editDraft, ignoreDraft, splitDraft, draftHash, needsInfoDraft, notOursDraft, recommendWithDecision } from "./ticket-drafts.ts";
import { ticketClocks } from "../domain/ticket-sla.ts";
import { enrichTicket } from "./ticket-enrich.ts";
import { type SizeDecision, type SizedCard, similarCards, sizeContextOf, sizeDecisionOf } from "./size-estimate.ts";
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
  /** Where approving a split draft creates the child tickets: the Jira project or the GitHub repository of this ticket's own key; null when the key is neither. */
  splitTarget: string | null;
}

export interface TicketMachineDeps {
  store: TicketStore;
  /** The tracker port for a tool: used only by a tap. */
  port(tool: CanonicalTicket["tool"]): Tickets;
  /** The cards and backlog items this ticket's audience may see: filtered by `canSeeKept` against its reporter, failing closed. */
  candidates(ticket: CanonicalTicket, repoPath: string | null): Promise<Candidate[]>;
  config(repoPath: string | null): Promise<FactoryConfig>;
  locate?(repoPath: string | null, text: string): Promise<string[]>;
  /** Makes a card through `create_card`. */
  createCard(input: NewTask): Promise<{ id: string }>;
  validity: ValidityDeps;
  assess: Pick<AssessDeps, "decide">;
  /**
   * The size estimate (wave 15): the typed decision `size_estimate` on the ticket's text, and the counted diff of closed cards by id. Only the closed cards among
   * `candidates` (already filtered to what the ticket's audience may see) are looked up. Absent, an assessment carries no estimate.
   */
  size?: { decide(context: SizeContext, repoPath: string | null): Promise<Record<string, unknown>>; counted?(ids: string[]): Promise<Array<{ id: string; added: number; removed: number }>> };
  /** The decomposer (an agent pack) and `split_check`, for a ticket whose recommendation is `split`. Absent, a ticket over the limit is only recommended `split`. */
  split?: { decompose(context: SplitContext, repoPath: string | null): Promise<Record<string, unknown>>; check: ((context: SplitContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null };
  recommend: RecommendDeps;
  reply: ReplyDeps;
  /** The shared backlog, for `schedule` and for keeping an item's rank in step with a re-assessment. */
  /** Ground truth: what a tap says about the decision `ticket_recommend` made (the decision log's `learned`), and what was done to a draft (a file beside a gate's). Absent: nothing is kept. */
  truth?: {
    learned(fact: { pack: "ticket_recommend" | "ticket_validity"; recordId: string; label: Record<string, Record<string, unknown>>; source: string; kind: "person" | "fact" | "outcome"; repoPath?: string | null }): Promise<boolean>;
    draft(entry: { key: string; draft: string; kind: string; did: "sent" | "edited" | "ignored"; original: string; final: string | null; at: string; repoPath?: string | null }): Promise<void>;
  };
  /** The label the GitHub intake watches for: a child ticket made on GitHub carries it, so the intake sees it. */
  intakeLabel?: string;
  backlog?: { upsertFromSource(input: BacklogAddInput, options: { createIfMissing: boolean }): Promise<{ id: string; created: boolean } | null> };
  now?: () => Date;
}

/** Fixed words and two numbers: why a ticket is split before it is planned; null when the estimate rules nothing. */
function splitReason(decision: SizeDecision, limits: ReturnType<typeof sizeLimits>): string | null {
  if (decision.sure && sizeVerdict(decision.estLoc, limits) === "over") return `estimated at about ${decision.estLoc} lines, over the limit of ${limits.hard}`;
  if (decision.reviewableNo) return "a reviewer could not read it as one change";
  return null;
}

const sourceOf = (t: CanonicalTicket): TaskSource => {
  const gh = GITHUB_KEY.exec(t.key);
  if (t.tool === "github" && gh) return { kind: "github", repo: `${gh[1]}/${gh[2]}`, number: Number(gh[3]), url: t.permalink };
  return { kind: "jira", key: t.key, url: t.permalink, issueType: t.type };
};

/** The repository a ticket is linked to, when one is. */
const repoOf = (row: Pick<TicketRow, "machineLinks">): string | null => row.machineLinks.find((l) => l.kind === "repo")?.target ?? null;

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
        return [...keep, ...drafts.filter((f) => !keep.some((k) => k.id === f.id))] as unknown as Record<string, unknown>[];
      });
      // The machine's own links (an origin, the siblings it waits for, a floor) stay; only the repository link is replaced.
      const kept = ((await store.get(ticket.key))?.machineLinks ?? []).filter((l) => l.kind !== "repo");
      await store.setMachine(ticket.key, { status, ...(ctx.repoPath ? { links: [...kept, { kind: "repo", target: ctx.repoPath }] } : {}) });
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
    // The tool's own fact about the reporter settles that question; nothing else about validity has a fact.
    if (validity.recordId && this.deps.truth) await this.deps.truth.learned({ pack: "ticket_validity", recordId: validity.recordId, label: { reporter: { value: ticket.reporter !== null } }, kind: "fact", source: "ticket_fact", repoPath: ctx.repoPath }).catch(() => false);
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
    const sized = await this.estimateSize(ticket, enrichment.files, candidates, config, ctx.repoPath, at);
    // The diagram's `est_loc <= limit and reviewable?`: a sure estimate over the hard limit, or a sure "not reviewable", is a split; the scores are not asked.
    const splitWhy = sized ? splitReason(sized.decision, sized.limits) : null;
    const recommendation = splitWhy ? { action: "split" as const, reason: splitWhy } : await recommendWithDecision(this.deps.recommend, record, context);
    const drafts = [assessmentDraft(ticket.key, record, recommendation.action === "split" ? null : recommendation.action, sized?.decision.sure ? { estLoc: sized.decision.estLoc, estFiles: sized.decision.estFiles } : null)];
    if (recommendation.action === "decline") {
      const decline = await declineDraft(this.deps.reply, ticket.key, context, (why) => (refused = why));
      if (decline) drafts.push(decline);
    }
    // A recommendation of `split` runs the decomposition loop: a valid split is a draft for a tap, none is a person's decision. Nothing is created here.
    let status = "assessed";
    let splitFailed: string | null = null;
    if (recommendation.action === "split" && this.deps.split) {
      const isPart = (prev?.machineLinks ?? []).some((l) => l.kind === "origin");
      const limits = sizeLimits(config.size);
      const looked = isPart
        ? null
        : await decompositionLoop(
            { decompose: (c) => this.deps.split!.decompose(c, ctx.repoPath), check: this.deps.split.check ? (c) => this.deps.split!.check!(c, ctx.repoPath) : null, bars: undefined },
            { origin: { title: ticket.title, text: ticket.description, criteria: [] }, files: enrichment.files.map((path) => ({ path })), limits },
          );
      if (looked?.ok) {
        drafts.push(splitDraft(ticket.key, looked.children));
        status = "split_proposed";
      } else {
        status = "needs_decision";
        splitFailed = looked ? looked.reason : "this ticket is itself part of a split; a part is not split again";
      }
    }
    await done(status, { outcome: "workable", ...head, ...(splitFailed ? { split: { failed: splitFailed } } : {}), subScores: record.subScores, recommendation, ...(sized ? { sizeEstimate: { estLoc: sized.decision.estLoc, estFiles: sized.decision.estFiles, reviewable: !sized.decision.reviewableNo, confidence: sized.decision.confidence } } : {}) }, drafts);
    // A ticket already in the backlog keeps its rank in step with the new assessment (updated, never added).
    if (prev?.machineStatus === "scheduled" && this.deps.backlog) {
      const updated = await this.deps.backlog.upsertFromSource(backlogInput(ticket, ctx.repoPath, record), { createIfMissing: false }).catch(() => null);
      if (updated) await store.setMachine(ticket.key, { status: "scheduled" });
    }
  }

  /** The `size_estimate` decision on the ticket, or null when none is wired or it failed (an unsure or failed estimate changes nothing). */
  private async estimateSize(ticket: CanonicalTicket, files: string[], candidates: Candidate[], config: FactoryConfig, repoPath: string | null, at: Date): Promise<{ decision: SizeDecision; limits: ReturnType<typeof sizeLimits> } | null> {
    const size = this.deps.size;
    if (!size) return null;
    try {
      const limits = sizeLimits(config.size);
      // Only the closed cards of the ticket's own candidates: what its audience may see. Their counted lines are looked up by id.
      const closed = candidates.filter((c) => c.kind === "closed");
      const counted = new Map((closed.length > 0 && size.counted ? await size.counted(closed.map((c) => c.id)).catch(() => []) : []).map((c) => [c.id, c]));
      const sizedCards: SizedCard[] = closed.map((c) => ({ ...c, diffAdded: counted.get(c.id)?.added ?? null, diffRemoved: counted.get(c.id)?.removed ?? null }));
      const similar = similarCards({ title: ticket.title, text: ticket.description, repo: repoPath }, sizedCards, { now: at, lookbackDays: config.dedup.lookback_days });
      const context = sizeContextOf({ title: ticket.title, text: ticket.description, criteria: [], files: files.map((path) => ({ path })), symbols: [], similar, limits });
      const answer = await size.decide(context, repoPath);
      const asked = PACKS.size_estimate;
      const { verdicts } = applyPolicy({ questions: asked.questions, policy: asked.policy }, answer, undefined);
      return { decision: sizeDecisionOf(answer, { sure: verdicts.est_loc === "proceed", reviewableSure: verdicts.reviewable === "proceed" }), limits };
    } catch (error) {
      console.warn(`ticket size: the estimate failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
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
    if (draft.kind === "split") return this.approveSplit(row, draft, tap.hash);
    await this.post(row, draft, draft, tap.hash, tap.transition);
    await this.keep(row, draft, "sent", null);
  }

  /** Posts the person's own text in place of the draft's, through `postable()`, after the token check. A tap. */
  async edit(key: string, tap: { draft: string; hash: string; text: string; transition?: string }): Promise<void> {
    const row = await this.row(key);
    const draft = this.draftOf(row, tap.draft, tap.hash);
    if (draft.kind === "split") throw new TicketRefusal("a split cannot be edited: approve it as drawn, or ignore it");
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
    // A ticket that depends on others needs a card for each first; its card waits on them (the dependency rule holds it).
    const deps = row.machineLinks.filter((l) => l.kind === "depends_on").map((l) => l.target);
    const cardIds: string[] = [];
    for (const d of deps) {
      const other = await this.deps.store.get(d);
      if (!other?.cardId) throw new TicketRefusal(`${d} has no card yet: make it first`);
      cardIds.push(other.cardId);
    }
    const floor = row.machineLinks.find((l) => l.kind === "risk_floor")?.target;
    const card = await this.deps.createCard({
      title: t.title,
      description: t.description,
      ...(repo ? { repoPath: repo } : {}),
      source: sourceOf(t),
      // Linked only to its own source: no Jira key is looked for in the text a stranger wrote.
      noJiraDetection: true,
      ...(t.reporter ? { reporter: { id: t.reporter.id, channel: t.tool } } : {}),
      ...(last ? { hints: { size: String(last.size), urgency: String(last.priority) } } : {}),
      ...(cardIds.length > 0 || floor ? { stack: { ...(cardIds.length > 0 ? { dependsOn: cardIds } : {}), ...(floor === "low" || floor === "medium" || floor === "high" ? { riskFloor: floor } : {}) } } : {}),
    } as NewTask);
    await this.deps.store.setMachine(key, { cardId: card.id, status: "carded" });
    await this.acknowledge(key);
    await this.learn(row, "do_now");
    return card;
  }

  /**
   * The tap on a split draft: claimed as `posting` under the row lock with the hash the person saw, the children created once each (progress is kept, so a retry
   * goes on), then the origin is marked `epic`. A failure puts the draft back to `waiting` with what was made.
   */
  private async approveSplit(row: TicketRow, draft: Draft, hash: string): Promise<void> {
    if (draft.rev !== 2) throw new TicketRefusal("this split draft is from an older version: it has to be drafted again before it can be approved");
    let claimed = false;
    let held: unknown = null;
    await this.deps.store.updateDrafts(row.key, (current) => {
      const cur = (current as unknown as Draft[]).find((d) => d.id === draft.id);
      if (!cur || cur.rev !== 2 || (cur.status !== "waiting" && cur.status !== "edited") || draftHash(cur) !== hash) return current;
      claimed = true;
      held = cur.children;
      return (current as unknown as Draft[]).map((d) => (d.id === draft.id ? { ...d, status: "posting" as const } : d)) as unknown as Record<string, unknown>[];
    });
    if (!claimed) throw new TicketRefusal("the draft is already being posted, or it changed since you read it");
    // The children are the ones read under the lock, with the hash the person saw.
    const children = z.array(SplitChild).safeParse(held);
    try {
      if (!children.success) throw new TicketRefusal("the split draft holds no readable children");
      this.childTexts(row.canonical, children.data, new Map());
      await this.splitChildren(row.key, children.data, { id: draft.id, draft: draft.id });
    } catch (error) {
      await this.deps.store.updateDrafts(row.key, (current) => (current as unknown as Draft[]).map((d) => (d.id === draft.id && d.status === "posting" ? { ...d, status: "waiting" as const } : d)) as unknown as Record<string, unknown>[]);
      throw error instanceof TicketRefusal ? error : new TicketRefusal(`a child ticket could not be created, so the split stopped part way; approve again to go on: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
    }
    const at = this.now().toISOString();
    await this.deps.store.updateDrafts(row.key, (current) => (current as unknown as Draft[]).map((d) => (d.id === draft.id ? { ...d, status: "posted" as const, history: [...d.history, { at, did: "posted" as const, from: d.text }] } : d)) as unknown as Record<string, unknown>[]);
    await this.acknowledge(row.key);
  }

  /** The texts of every child, each made postable; the whole split is refused (nothing created) when one carries a token-shaped string. Titles and bodies are model-written. */
  private childTexts(origin: CanonicalTicket, children: SplitChild[], keys: Map<number, string>): Array<{ title: string; body: string }> {
    return children.map((c, i) => {
      const parts = [`Part ${i + 1} of ${children.length} of ${origin.key}.`, c.goal, ...c.acceptance_criteria.map((a) => `- ${a}`), ...(c.depends_on.length > 0 ? [`After: ${c.depends_on.map((p) => keys.get(p) ?? `part ${p}`).join(", ")}`] : [])];
      if ([c.title, ...parts].some((t) => carriesSecret(t))) throw new TicketRefusal("a child's text carries a token-shaped string: the split is not made");
      return { title: postable(c.title, 200), body: parts.map((t, j) => (j === 0 || t.startsWith("After: ") ? t : postable(t, 1000))).join("\n") };
    });
  }

  /**
   * Creates a split's children in the tracker of `originKey`, in dependency order, once each under the split's id (`split.id`: a draft's id or a card gate's id): what was
   * made is kept as links on the origin, so a retry makes only the rest. Then each child is read back, linked to its origin, its siblings and the risk floor, and assessed
   * as any ticket; the origin becomes `epic` and one comment lists the keys. Only a person's tap reaches this.
   */
  async splitChildren(originKey: string, children: SplitChild[], split: { id: string; draft?: string; floor?: "low" | "medium" | "high" }): Promise<{ keys: string[] }> {
    const row = await this.row(originKey);
    const origin = row.canonical;
    const port = this.deps.port(origin.tool);
    const prefix = `${split.id}:`;
    // A card-less split: the floor is the origin's assessed blast radius, never below medium (a card's split passes its own).
    const lastBlast = (row.assessments.at(-1) as { blastRadius?: unknown } | undefined)?.blastRadius;
    const floor: "low" | "medium" | "high" = split.floor ?? (lastBlast === "high" ? "high" : "medium");
    let links = [...row.machineLinks];
    const made = new Map<number, string>();
    for (const l of links) if (l.kind === "split_part" && l.target.startsWith(prefix)) {
      const [n, key] = l.target.slice(prefix.length).split(":");
      if (n && key) made.set(Number(n), key);
    }
    this.childTexts(origin, children, made);
    const order = children.map((c, i) => ({ c, n: i + 1 })).sort((a, b) => a.c.order - b.c.order || a.n - b.n);
    for (const { c, n } of order) {
      if (made.has(n)) continue;
      const text = this.childTexts(origin, children, made)[n - 1]!;
      const created = await port.create(origin, text, origin.tool === "github" && this.deps.intakeLabel ? { labels: [this.deps.intakeLabel] } : {});
      made.set(n, created.key);
      links = [...links, { kind: "split_part", target: `${prefix}${n}:${created.key}` }, { kind: "child", target: created.key }];
      await this.deps.store.setMachine(originKey, { links });
      // Linked now, from what `create` returned: a tracker that cannot read a child back by key must not leave it unlinked.
      await this.linkChild(origin, originKey, created, text, n, children, made, floor, links.find((l) => l.kind === "repo")?.target ?? null);
      if (split.draft) {
        const list = [...made].map(([m, key]) => ({ n: m, key })).sort((a, b) => a.n - b.n);
        await this.deps.store.updateDrafts(originKey, (current) => (current as unknown as Draft[]).map((d) => (d.id === split.draft ? { ...d, created: list } : d)) as unknown as Record<string, unknown>[]);
      }
    }
    const keys = children.map((_, i) => made.get(i + 1)!);
    if (!links.some((l) => l.kind === "split_done" && l.target === split.id)) {
      const repo = links.find((l) => l.kind === "repo")?.target ?? null;
      const texts = this.childTexts(origin, children, made);
      // Every child is linked (all its dependencies now known) before the split counts as done; a failure here leaves it undone and a retry links the rest.
      for (const [i, c] of children.entries()) await this.linkChild(origin, originKey, { key: keys[i]!, permalink: "" }, texts[i]!, i + 1, children, made, floor, repo);
      for (const [i] of children.entries()) {
        const row = await this.deps.store.get(keys[i]!);
        if (!row || !row.machineLinks.some((l) => l.kind === "origin" && l.target === originKey)) throw new Error(`child ${keys[i]} is not linked to its origin`);
      }
      for (const [i] of children.entries()) {
        const row = (await this.deps.store.get(keys[i]!))!;
        await this.ingest(row.canonical, { repoPath: repo, question: false, force: true }).catch((error: unknown) => console.warn(`ticket split: child ${keys[i]} was not assessed: ${error instanceof Error ? error.message : String(error)}`));
      }
      await this.deps.store.setMachine(originKey, { status: "epic", links: [...links, { kind: "split_done", target: split.id }] });
      await port.comment(originKey, `Split into: ${keys.join(", ")}.`).catch(() => {});
    }
    return { keys };
  }

  /** Stores a created child (a row built from what `create` returned, never read back) and writes its links: origin, the siblings it waits for, the floor and the repository. */
  private async linkChild(origin: CanonicalTicket, originKey: string, created: { key: string; permalink: string }, text: { title: string; body: string }, n: number, children: SplitChild[], made: Map<number, string>, floor: "low" | "medium" | "high", repo: string | null): Promise<void> {
    const at = this.now().toISOString();
    const existing = await this.deps.store.get(created.key);
    if (!existing) {
      await this.deps.store.read({
        tool: origin.tool, id: created.key, key: created.key, title: text.title.slice(0, 200), description: text.body, type: null, status: null, priority: null, reporter: origin.reporter, assignee: null,
        labels: origin.tool === "github" && this.deps.intakeLabel ? [this.deps.intakeLabel] : [], components: [], links: { blocks: [], duplicates: [], epic: null }, comments: [], attachments: [], sprint: null,
        dueAt: null, createdAt: at, updatedAt: at, permalink: created.permalink || origin.permalink,
      } as CanonicalTicket);
    }
    const c = children[n - 1]!;
    await this.deps.store.setMachine(created.key, { links: [{ kind: "origin", target: originKey }, ...c.depends_on.flatMap((p) => (made.get(p) ? [{ kind: "depends_on", target: made.get(p)! }] : [])), { kind: "risk_floor", target: floor }, ...(repo ? [{ kind: "repo", target: repo }] : [])] });
  }

  /** The ticket a card came from, when the store holds that ticket with this card as its own: what lets a card's split create tickets. Null for every other card. */
  async ticketOfCard(task: { id: string; source?: unknown; sources?: unknown }): Promise<{ tool: string; key: string } | null> {
    const first = (task.source ?? (Array.isArray(task.sources) ? task.sources[0] : null)) as { kind?: string; key?: string; repo?: string; number?: number } | null;
    const key = first?.kind === "jira" && typeof first.key === "string" ? first.key : first?.kind === "github" && typeof first.repo === "string" ? `${first.repo}#${first.number}` : null;
    if (!key) return null;
    const row = await this.deps.store.get(key);
    return row && row.cardId === task.id ? { tool: row.canonical.tool, key } : null;
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
    if (draftHash(draft) !== hash) throw new TicketRefusal("the draft changed since you read it: read it again");
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
      if (!cur || (cur.status !== "waiting" && cur.status !== "edited") || draftHash(cur) !== hash) return current;
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
      await this.deps.truth?.draft({ key: row.key, draft: draft.id, kind: draft.kind, did, original: draft.original ?? draft.text, final, at: this.now().toISOString(), repoPath: repoOf(row) });
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
      await this.deps.truth.learned({ pack: "ticket_recommend", recordId, label: { action: { choice: chosen } }, kind: "person", source: last?.recommendation?.action === chosen ? "ticket_confirmed" : "ticket_override", repoPath: repoOf(row) });
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
      const clocks = ticketClocks({ firstSeenAt: row.createdAt, acknowledgedAt: typeof row.clocks.acknowledgedAt === "string" ? new Date(row.clocks.acknowledgedAt) : null, priority: last?.priority ?? null, status: row.machineStatus, needsInfoSince: since, updatedAt: row.updatedAt }, now, config);
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

/** The tracker project children are created in: a Jira key's project, a GitHub key's `owner/repo` (the adapters parse the same from the origin's key). */
export function splitTargetOf(key: string): string | null {
  if (JIRA_KEY.test(key)) return key.slice(0, key.lastIndexOf("-"));
  const gh = GITHUB_KEY.exec(key);
  return gh ? `${gh[1]}/${gh[2]}` : null;
}

function viewOf(row: TicketRow): TicketView {
  return { key: row.key, canonical: row.canonical, status: row.machineStatus, assessments: row.assessments, drafts: (row.drafts as unknown as Draft[]).map((d) => ({ ...d, hash: draftHash(d) })), cardId: row.cardId, clocks: row.clocks, splitTarget: splitTargetOf(row.key) };
}
void (null as unknown as AssessAnswer);
