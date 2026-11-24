// The reviewing stage of a review PR task: the host fetches the PR's diff, files and the
// comments already on it (the sandbox has no GitHub credential), the pr-reviewer pack answers
// with line-anchored comments and a verdict, and the host posts one COMMENT review at once.
// An approve / request-changes verdict waits at the gate; `postVerdictRunner` posts it on `a`.
import { type DecisionOverrides, type Finding, PrReviewAnswer, type RequestedAction, type ReviewContext, type ReviewLinks, mergeDuplicateFindings } from "@hardness/contracts";

import { type Decide } from "./check-decide.ts";
import { type ComplianceDeps, runCompliance } from "./compliance-review.ts";
import { type HelperDeps, type HelpersOutcome, confirmHelperFindings, runHelpers } from "./review-helpers.ts";
import { addUsage } from "./usage.ts";
import { excerptOf } from "./verify.ts";
import { type GitHub, type ReviewPost, messageOf } from "../github.ts";
import type { Jira } from "../jira.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type LinkableCard, type PrLinkDeps, type PrLinks, linkReview } from "../pr-link.ts";
import { readTickets } from "../review-tickets.ts";

export interface PrReviewDeps {
  github: GitHub;
  /** Runs the reviewing pack with what the host fetched. */
  runPack: (context: StageContext, review: ReviewContext) => Promise<StageResult>;
  /** The security, migration, infrastructure and second-opinion passes, run on every PR after the main review; absent runs none. `decide` (read at call time) asks finding_confirm about what only a pass found; null keeps those findings unchecked. */
  helpers?: HelperDeps & {
    decide: Decide | null;
    /** The repo's decision overrides (luna.yaml `policy.decisions`); absent, none. */
    decisions?: (repoPath: string | null) => Promise<Record<string, DecisionOverrides>>;
  };
  /** The compliance review beside this one, only when the machine has a wiki to read controls from; it runs when the repo declares regimes. */
  compliance?: ComplianceDeps;
  /** The Jira port, only when Jira is configured: the tickets the PR names are read and the reviewer checks the diff against them. */
  jira?: Jira | null;
  /** The Jira projects the machine knows for a repo checkout; absent, or none, accepts any project key. */
  projects?: (repoPath: string | null) => Promise<readonly string[]>;
  /** The board cards and tickets the PR is linked to (by fact, else by the `pr_link` decision); absent, only the keys the PR names are read. */
  links?: PrLinkDeps & {
    /** Told once a review has passed with what it was linked to: the review's own card keeps it and each linked card logs the review. Never fails a review. */
    record?(taskId: string, links: ReviewLinks, pr: { url: string; number: number; repo: string }): Promise<void>;
  };
}

/** A card's description as the reviewer reads it: capped, the data block quotes the rest. */
const CARD_DESCRIPTION_CAP = 4000;
const cardOf = (c: LinkableCard) => ({ id: c.id, title: c.title, criteria: c.criteria, description: c.description.trim().slice(0, CARD_DESCRIPTION_CAP) });

const EVENT_OF = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" } as const;

/** The review event from the set of severities, as orc's review-contract defines it: no finding approves; a bug, a
 *  security, an api-surface or a test finding requests changes; anything else (suggestion, question, nit) comments. */
export function verdictOf(findings: ReadonlyArray<{ severity: string }>): "approve" | "request_changes" | "comment" {
  if (findings.length === 0) return "approve";
  const blocking = new Set(["bug", "security", "api-surface", "test"]);
  return findings.some((f) => blocking.has(f.severity)) ? "request_changes" : "comment";
}

/** inline-review's cap: more than this erodes signal, so the lowest severities stay in findings only. */
export const MAX_INLINE_COMMENTS = 15;
const SEVERITY_RANK: Record<string, number> = { security: 0, bug: 1, "api-surface": 2, test: 3, suggestion: 4, question: 5, nit: 6 };

/** The comments to post: at most `MAX_INLINE_COMMENTS`, the gravest findings first, the pack's order otherwise. */
export function capComments<T extends { path: string; line: number }>(comments: T[], findings: Array<{ path: string; line: number; severity: string }>): T[] {
  if (comments.length <= MAX_INLINE_COMMENTS) return comments;
  const rank = (c: T) => {
    const found = findings.find((f) => f.path === c.path && f.line === c.line);
    return SEVERITY_RANK[found?.severity ?? ""] ?? 9;
  };
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .slice(0, MAX_INLINE_COMMENTS)
    .map(({ c }) => c);
}

/** What a finding's file looked like in the PR's diff, when the worktree cannot show it: the file's own section, capped. */
const DIFF_EXCERPT_CAP = 2000;
export function diffExcerptOf(diff: string, finding: Pick<Finding, "path">): string {
  const sections = diff.split(/^(?=diff --git )/m);
  const section = sections.find((part) => part.startsWith(`diff --git a/${finding.path} `) || part.split("\n", 1)[0]!.endsWith(` b/${finding.path}`));
  return (section ?? "").slice(0, DIFF_EXCERPT_CAP);
}

/** Marks a finding the confirmation was not sure of; the person reads the mark before posting. */
const UNSURE = "Unsure: ";

/** The PR a task came from, or null when the task is not a PR task. */
export function prOf(context: StageContext): { repo: string; number: number; url: string } | null {
  const source = context.task.source;
  return source?.kind === "github_pr" ? { repo: source.repo, number: source.number, url: source.url } : null;
}

/** The PR's facts as the review and address packs read them. Throws when GitHub no longer shows it. */
export async function gatherPr(github: GitHub, repo: string, number: number): Promise<ReviewContext["pr"]> {
  const node = await github.prFacts(repo, number);
  if (!node) throw new Error(`${repo}#${number} is gone from GitHub`);
  return {
    repo,
    number,
    url: node.url,
    title: node.title,
    body: node.body ?? null,
    author: node.author?.login ?? "ghost",
    baseRef: node.baseRefName,
    headRef: node.headRefName,
  };
}

/** What the review keeps of its links: the tickets that were read (with how they were found), the cards, and the suggestion; null when there is nothing to show. */
export function reviewLinksOf(links: PrLinks, tickets: ReadonlyArray<{ key: string; url: string; summary: string }>): ReviewLinks | null {
  const jira = links.jira.flatMap((j) => {
    const t = tickets.find((x) => x.key === j.key);
    return t ? [{ key: t.key, url: t.url, summary: t.summary, how: j.how }] : [];
  });
  const cards = links.cards.map((l) => ({ id: l.card.id, title: l.card.title, how: l.how, ...(l.fact ? { fact: l.fact } : {}) }));
  if (jira.length === 0 && cards.length === 0 && !links.suggestion) return null;
  return { at: new Date().toISOString(), jira, cards, ...(links.suggestion ? { suggestion: links.suggestion } : {}) };
}

export function prReviewRunner(deps: PrReviewDeps): StageRunner {
  const { github } = deps;
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    let review: ReviewContext;
    let links: PrLinks;
    try {
      const [facts, diff, files, existingComments] = await Promise.all([
        gatherPr(github, pr.repo, pr.number),
        github.prDiff(pr.repo, pr.number),
        github.prFiles(pr.repo, pr.number),
        github.prComments(pr.repo, pr.number),
      ]);
      review = { pr: facts, diff, files, existingComments };
      const repoPath = context.task.repoPath ?? null;
      // What the PR is the work of: the keys it names, the cards that match by a recorded fact and, when nothing does, the decision's pick.
      links = await linkReview(
        { links: deps.links ?? { cards: async () => [], prUrls: async () => [] }, ...(deps.jira ? { jira: deps.jira } : {}), ...(deps.projects ? { projects: () => deps.projects!(repoPath) } : {}) },
        { pr: facts, files: files.map((f) => f.path), repoPath, selfId: context.task.id },
      );
      // A ticket that cannot be read is skipped inside readTickets: Jira never fails a review. A ticket a linked card carries is read like a named one.
      if (deps.jira) review.tickets = await readTickets(deps.jira, links.jira.map((j) => j.key));
      if (links.cards.length > 0) review.cards = links.cards.map((l) => cardOf(l.card));
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }

    const pack = await deps.runPack(context, review);
    if (pack.outcome !== "pass") return pack;
    const parsed = PrReviewAnswer.safeParse(pack.detail?.answer);
    if (!parsed.success) {
      return { ...pack, outcome: "fail", detail: { ...pack.detail, error: `the review answer does not parse: ${parsed.error.message}` } };
    }
    // The review passes read the same diff after the reviewer (they share its workspace, so one at a time); what only a pass found is checked once more before it joins.
    const worktree = pack.workspace?.worktreePath ?? context.task.worktreePath ?? null;
    let helpers: HelpersOutcome | null = null;
    let confirmed: Awaited<ReturnType<typeof confirmHelperFindings>> | null = null;
    if (deps.helpers) {
      helpers = await runHelpers(deps.helpers, context, review);
      const overrides = (await deps.helpers.decisions?.(context.task.repoPath ?? null).catch(() => ({}))) ?? {};
      const excerpt = async (finding: Finding): Promise<string> => (worktree ? await excerptOf(worktree, finding).catch(() => "") : "") || diffExcerptOf(review.diff, finding);
      confirmed = await confirmHelperFindings({ decide: deps.helpers.decide, repoPath: context.task.repoPath ?? null, decisions: overrides, excerpt, log: (line) => console.warn(`review: ${line}`) }, helpers.helpers, parsed.data.findings);
    }
    const kept = (confirmed?.kept ?? []).map(({ finding, unsure }) => (unsure ? { ...finding, title: `${UNSURE}${finding.title}` } : finding));
    const helperComments = kept.map((f) => ({ path: f.path, line: f.line, side: f.side === "LEFT" ? ("LEFT" as const) : ("RIGHT" as const), body: `${f.title}: ${f.body}` }));
    // The compliance lead reads the same diff beside the reviewer; its findings join before the verdict, so a high one blocks. It never fails the review.
    const compliance = deps.compliance ? await runCompliance(deps.compliance, context, pr.repo, review) : null;
    const joined = {
      ...parsed.data,
      summary: [parsed.data.summary, compliance?.summary ? `Compliance: ${compliance.summary}` : ""].filter(Boolean).join(" "),
      findings: [...parsed.data.findings, ...(compliance?.findings ?? [])],
      comments: [...parsed.data.comments, ...(compliance?.comments ?? [])],
    };
    const answer = helpers || compliance ? { ...joined, findings: mergeDuplicateFindings([...joined.findings, ...(confirmed?.agreed ?? []), ...kept]), comments: [...joined.comments, ...helperComments] } : parsed.data;
    // The verdict is the findings', never the model's (orc review-contract): any finding keeps a review from approving.
    const verdict = verdictOf(answer.findings);

    // Nothing is posted here: the review goes out under the person's name, so every verdict, its body and its line
    // comments wait at "post the verdict?" until the person says yes (or edits or drops it).
    const comments = capComments(
      answer.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      answer.findings,
    );
    // The sub-runs' cost joins the review's, so the budget and the engine's counters see all of it.
    const usage = addUsage(addUsage(pack.usage, helpers?.usage), compliance?.usage);
    const base = { ...pack, ...(usage ? { usage } : {}), findings: answer.findings };
    const reviewLinks = reviewLinksOf(links, review.tickets ?? []);
    const detail = {
      ...pack.detail,
      summary: answer.summary,
      // Which tickets the review was checked against, for the board's Result page.
      ...(review.tickets?.length ? { tickets: review.tickets.map((t) => ({ key: t.key, url: t.url, summary: t.summary })) } : {}),
      // What the review was linked to and how (key | fact | decision), and a suggestion that stayed under the bar.
      ...(reviewLinks ? { links: reviewLinks } : {}),
      verdict,
      ...(helpers
        ? {
            helpers: helpers.helpers.map((h) => {
              const verdicts = confirmed?.verdicts[h.pack];
              const dropped = h.findings.length - (confirmed?.duplicates[h.pack] ?? 0) - (confirmed?.kept.filter((k) => k.pack === h.pack).length ?? 0);
              return { pack: h.pack, ...(h.engine ? { engine: h.engine } : {}), outcome: h.outcome, findings: h.findings.length, ...(verdicts ? { confirm: verdicts } : {}), ...(dropped > 0 ? { dropped } : {}), ...(confirmed?.duplicates[h.pack] ? { alsoFoundByReviewer: confirmed.duplicates[h.pack] } : {}) };
            }),
            ...(helpers.notes.length > 0 ? { helperNotes: helpers.notes } : {}),
          }
        : {}),
      ...(compliance ? { compliance: { regimesRun: compliance.regimesRun, findings: compliance.findings.length, notes: compliance.notes } } : {}),
      ...(parsed.data.verdict !== verdict ? { modelVerdict: parsed.data.verdict } : {}),
      posted: false,
      comments: comments.length,
      reason: "verdict",
    };
    if (reviewLinks && deps.links?.record) {
      try {
        await deps.links.record(context.task.id, reviewLinks, { url: pr.url, number: pr.number, repo: pr.repo });
      } catch (error) {
        console.warn(`review: could not record the links of ${pr.url} (${messageOf(error)})`);
      }
    }
    const requested: RequestedAction[] = [
      { kind: "pr_review_post", target: pr.url, payload: { event: EVENT_OF[verdict], body: answer.summary, comments } },
    ];
    return { ...base, detail, requested };
  };
}

/** The review route's `shipping`: posts the review the gate carried (APPROVE, REQUEST_CHANGES or COMMENT) with its line comments. */
export function postVerdictRunner(deps: { github: GitHub }): StageRunner {
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    const gate = context.approvals.filter((a) => a.kind === "awaiting_ship" && a.decision === "approved").at(-1);
    const actions = (gate?.requested as { actions?: RequestedAction[] } | undefined)?.actions ?? [];
    const post = actions.find((a) => a.kind === "pr_review_post");
    const event = post?.payload.event;
    if (!post || (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT")) {
      return { outcome: "fail", detail: { error: "the gate carried no verdict to post" } };
    }
    const body = typeof post.payload.body === "string" ? post.payload.body : "";
    // The line comments ride on the gate since every review waits for the person; a gate stored before that has none.
    const comments = Array.isArray(post.payload.comments) ? (post.payload.comments as ReviewPost["comments"]) : [];
    try {
      await deps.github.postReview(pr.repo, pr.number, { event, body, comments });
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
    return { outcome: "pass", detail: { posted: event, prUrl: pr.url } };
  };
}
