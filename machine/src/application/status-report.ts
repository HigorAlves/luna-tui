// The weekly status for leadership (RFC 0008, wave 7). On the configured weekday, at or after 08:00 machine time, the previous
// Monday to Sunday becomes one draft page: the machine gathers the facts in-process (the board, GitHub's merged PRs, the drafts, the
// incidents, the vulnerabilities, the backlog), asks `capacity_check` about the coming week and has `status_report` write it. A cursor
// under `<stateDir>/compliance/` remembers the last week done, so an hourly tick does no work once it is. A pack that fails opens no
// draft and the week stays undone: the next tick tries again. A capacity check that fails never blocks the report.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type BacklogEntry, type CapacityContext, type ComplianceDraft, type Metrics, StatusReportAnswer, StatusReportContext } from "@hardness/contracts";
import { z } from "zod";

import type { StatusDay } from "../config.ts";
import { STATUS_DAYS } from "../config.ts";
import { assessedBreach } from "../domain/breach.ts";
import type { Incident } from "../domain/incident.ts";
import { isoWeek, statusPage, statusPath, weekBounds } from "../domain/status-report.ts";
import type { TaskRow } from "../domain/task.ts";
import { COMPLIANCE_DIR, type ComplianceDrafts } from "./compliance-drafts.ts";
import type { GitHub } from "./github.ts";
import type { VulnRow } from "./vulns.ts";

const CursorSchema = z.object({ schema: z.literal(1), done: z.string().nullable() });
const DAY_MS = 86_400_000;
/** The report goes out at or after this hour, machine time. */
const REPORT_HOUR = 8;

const REGIME_NAME: Record<string, string> = { gdpr: "GDPR", lgpd: "LGPD", hipaa: "HIPAA", us_privacy: "US privacy" };
/** What each waiting state is waiting for, in the words the report shows. */
const BLOCKED: Record<string, string> = {
  escalated: "escalated",
  paused_rate_limit: "paused on a rate limit",
  awaiting_answers: "waiting on an answer",
  awaiting_approval: "waiting for the plan's approval",
  awaiting_test_check: "waiting for the test check",
  awaiting_setup: "waiting for setup",
  awaiting_ship: "waiting for the ship approval",
};
const NOT_IN_FLIGHT = new Set(["draft", "closed", "archived"]);

/** capacity_check's answers in the words the report uses; anything that is not that shape is no answer. */
const CapacityAnswers = z.object({
  over_agent_capacity: z.object({ value: z.boolean() }),
  over_review_capacity: z.object({ value: z.boolean() }),
  at_risk: z.object({ score: z.number() }),
});

export interface StatusReportDeps {
  drafts: Pick<ComplianceDrafts, "open" | "list">;
  /** The board's tasks. */
  tasks(): Promise<TaskRow[]>;
  /** `GET /metrics` for a window: the same numbers, read in-process. */
  metrics(since: Date, until: Date): Promise<Metrics>;
  /** The PRs merged in a window, and who the token is (the person whose reviews are counted). */
  github: Pick<GitHub, "mergedPrs" | "viewer">;
  incidents: { list(): Promise<Incident[]> };
  vulns: { list(): Promise<VulnRow[]> };
  /** The backlog, ranked by WSJF, best first. */
  backlog: { list(): Promise<BacklogEntry[]> };
  /** Each engine's budget left and the hours it was rate limited lately. */
  headroom(): Promise<CapacityContext["headroom"]>;
  /** The one run of the `capacity_check` pack; its answer is validated here. */
  assess(context: CapacityContext): Promise<unknown>;
  /** The one run of the `status_report` pack; its answer is validated here. */
  write(context: StatusReportContext): Promise<unknown>;
  /** The `owner/name` of every compliance repository. */
  repos(): Promise<string[]>;
  /** The home wiki the page is written to. */
  wikiRepo: string;
  /** The channel the summary is posted to; null leaves the draft with the wiki target alone. */
  slackChannel: string | null;
  day: StatusDay;
  stateDir: string;
  log?: (line: string) => void;
  now?: () => Date;
}

/** `YYYY-MM-DD` to a local date at the given time. */
const local = (date: string, h: number, m: number, s: number, ms: number): Date => {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, h, m, s, ms);
};

export class StatusReport {
  private ticking: Promise<void> | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: StatusReportDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
    this.now = deps.now ?? (() => new Date());
  }

  /** The draft page for one ISO week (`2026-W46`), opened or refreshed. A failed writer throws and opens nothing. */
  async build(week: string): Promise<ComplianceDraft> {
    const { from, to } = weekBounds(week);
    const since = local(from, 0, 0, 0, 0);
    const until = local(to, 23, 59, 59, 999);
    const [tasks, metrics, merged, compliance] = await Promise.all([this.deps.tasks(), this.deps.metrics(since, until), this.merged(since, until), this.complianceFacts(week, since, this.now())]);
    const capacity = await this.capacity(week, until, tasks);
    const inWindow = (d: Date | null) => d !== null && d >= since && d <= until;
    const shipped = tasks.filter((t) => t.state === "closed" && t.archiveReason === null && inWindow(t.stateSince ?? t.updatedAt));
    const m = metrics;
    const facts = StatusReportContext.parse({
      week,
      from,
      to,
      metrics: {
        created: m.tasks.created,
        closed: m.tasks.closed,
        open: m.tasks.open,
        waitingOnYou: m.tasks.waitingOnYou,
        leadTimeHours: m.flow?.leadTimeMs.median != null ? Math.round((m.flow.leadTimeMs.median / 3_600_000) * 10) / 10 : null,
        firstPassRate: m.firstPassRate.verifying,
        escalationRate: m.escalations.rate,
        costUsd: Math.round(m.cost.totalUsd * 100) / 100,
      },
      shipped: shipped.slice(0, 40).map((t) => ({ title: t.title.slice(0, 200), repo: repoOf(t), pr: prOf(t) })),
      inFlight: tasks.filter((t) => !NOT_IN_FLIGHT.has(t.state) && !(t.state in BLOCKED)).slice(0, 40).map((t) => ({ title: t.title.slice(0, 200), state: t.state })),
      blocked: tasks.filter((t) => t.state in BLOCKED).slice(0, 30).map((t) => ({ title: t.title.slice(0, 200), why: (t.reason ?? BLOCKED[t.state]!).slice(0, 300) })),
      merged,
      compliance,
      capacity,
    });
    const answer = StatusReportAnswer.parse(await this.deps.write(facts));
    return this.deps.drafts.open({
      id: `status_report:${week}`,
      kind: "status_report",
      repo: this.deps.wikiRepo,
      title: `Status, ${week}`,
      period: week,
      summary: answer.headline,
      text: statusPage(week, answer, facts),
      // The wiki first: a failure after the Slack post would leave a link to a page that is not there.
      targets: [{ kind: "wiki" as const, repo: this.deps.wikiRepo, path: statusPath(week) }, ...(this.deps.slackChannel ? [{ kind: "slack_channel" as const, channel: this.deps.slackChannel }] : [])],
    });
  }

  /** One pass: the previous week of `now`, on the configured day from 08:00, when it is not done. A pass already running is joined, not doubled. */
  tick(now: Date = this.now()): Promise<void> {
    if (now.getDay() !== STATUS_DAYS.indexOf(this.deps.day) || now.getHours() < REPORT_HOUR) return Promise.resolve();
    this.ticking ??= this.pass(isoWeek(new Date(now.getTime() - 7 * DAY_MS))).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(week: string): Promise<void> {
    if ((await this.loadCursor()).done === week) return;
    try {
      await this.build(week);
    } catch (error) {
      this.log(`status report: ${week}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.saveCursor({ schema: 1, done: week });
  }

  /** Merged PRs per compliance repo in the window; a repo GitHub cannot answer for is left out and logged. */
  private async merged(since: Date, until: Date): Promise<{ repo: string; count: number }[]> {
    const out: { repo: string; count: number }[] = [];
    for (const repo of await this.deps.repos()) {
      try {
        const prs = await this.deps.github.mergedPrs(repo, since.toISOString(), until.toISOString());
        if (prs.length > 0) out.push({ repo, count: prs.length });
      } catch (error) {
        this.log(`status report: merged PRs of ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return out;
  }

  private async complianceFacts(week: string, since: Date, now: Date): Promise<StatusReportContext["compliance"]> {
    const drafts = (await this.deps.drafts.list()).filter((d) => d.id !== `status_report:${week}`);
    const latest = (kind: string, key: (d: ComplianceDraft) => string) => {
      const best = new Map<string, ComplianceDraft>();
      for (const d of drafts.filter((x) => x.kind === kind)) {
        const k = key(d);
        const seen = best.get(k);
        if (!seen || (d.period ?? "") > (seen.period ?? "")) best.set(k, d);
      }
      return [...best.values()];
    };
    const count = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
    const incidents = (await this.deps.incidents.list()).filter((i) => i.status === "open" || clockRunning(i, since));
    const vulns = await this.deps.vulns.list();
    return {
      waitingDrafts: drafts.filter((d) => d.status === "waiting" || d.status === "edited").slice(0, 30).map((d) => ({ kind: d.kind, title: d.title.slice(0, 200) })),
      evidence: latest("change_evidence", (d) => d.repo).slice(0, 40).map((d) => ({ repo: d.repo, period: d.period ?? "", exceptions: count(d.summary, /(\d+) with exceptions/) })),
      access: latest("access_review", (d) => orgOf(d))
        .slice(0, 10)
        .map((d) => ({ org: orgOf(d), period: d.period ?? "", flags: count(d.summary, /^(\d+) flags/), signed: d.status === "posted" })),
      incidents: incidents.slice(0, 20).map((i) => ({ title: i.title.slice(0, 200), severity: i.severity, status: i.status, nextDeadline: nextDeadline(i, now) })),
      vulns: vulns
        .toSorted((a, b) => Number(b.overdue) - Number(a.overdue))
        .slice(0, 40)
        .map((v) => ({ repo: v.repo, severity: String(v.severity).slice(0, 20), deadline: String(v.deadline).slice(0, 40), overdue: v.overdue })),
    };
  }

  /** capacity_check's reading of the coming week; null, with a note, when the check fails or answers nothing usable. */
  private async capacity(week: string, until: Date, tasks: TaskRow[]): Promise<StatusReportContext["capacity"]> {
    try {
      const next = isoWeek(new Date(until.getTime() + DAY_MS));
      const weeks = [3, 2, 1, 0].map((back) => weekBounds(isoWeek(new Date(until.getTime() - back * 7 * DAY_MS))));
      const bucket = (at: Date | null): number => (at === null ? -1 : weeks.findIndex((w) => at >= local(w.from, 0, 0, 0, 0) && at <= local(w.to, 23, 59, 59, 999)));
      const closed = [0, 0, 0, 0];
      for (const t of tasks) {
        const i = t.state === "closed" && t.archiveReason === null ? bucket(t.stateSince ?? t.updatedAt) : -1;
        if (i >= 0) closed[i]!++;
      }
      const reviewed = await this.reviewed(weeks, bucket);
      const context: CapacityContext = {
        week: next,
        backlog: (await this.deps.backlog.list()).slice(0, 30).map((b) => ({ title: b.title.slice(0, 200), repo: b.repo === null ? null : b.repo.slice(0, 200), size: b.size, wsjf: b.score, state: b.schedulable === false ? "blocked" : "ready" })),
        throughput: { closedPerWeek: closed, reviewedPerWeek: reviewed },
        headroom: await this.deps.headroom(),
      };
      const answers = CapacityAnswers.parse(await this.deps.assess(context));
      const atRisk = (["none", "some", "many"] as const)[Math.min(2, Math.max(0, Math.round(answers.at_risk.score)))]!;
      return { answers: { overAgentCapacity: answers.over_agent_capacity.value, overReviewCapacity: answers.over_review_capacity.value, atRisk } };
    } catch (error) {
      this.log(`status report: ${week}: capacity check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The reviews the token's own login left on merged PRs, per week of the four: the PRs the machine can see are the compliance repos' merged ones. */
  private async reviewed(weeks: { from: string; to: string }[], bucket: (at: Date | null) => number): Promise<number[]> {
    const counts = [0, 0, 0, 0];
    const me = (await this.deps.github.viewer()).login;
    const since = local(weeks[0]!.from, 0, 0, 0, 0).toISOString();
    const until = local(weeks[3]!.to, 23, 59, 59, 999).toISOString();
    for (const repo of await this.deps.repos()) {
      try {
        for (const pr of await this.deps.github.mergedPrs(repo, since, until)) {
          for (const r of pr.reviews) {
            const i = r.author === me && r.state !== "PENDING" && r.submittedAt ? bucket(new Date(r.submittedAt)) : -1;
            if (i >= 0) counts[i]!++;
          }
        }
      } catch (error) {
        this.log(`status report: reviews in ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return counts;
  }

  private cursorFile(): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "status-cursor.json");
  }

  /** A damaged or missing file is an empty cursor: the week is built again. */
  private async loadCursor(): Promise<z.infer<typeof CursorSchema>> {
    try {
      return CursorSchema.parse(JSON.parse(await readFile(this.cursorFile(), "utf8")));
    } catch {
      return { schema: 1, done: null };
    }
  }

  private async saveCursor(cursor: z.infer<typeof CursorSchema>): Promise<void> {
    await mkdir(join(this.deps.stateDir, COMPLIANCE_DIR), { recursive: true });
    const tmp = `${this.cursorFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor));
    await rename(tmp, this.cursorFile());
  }
}

const repoOf = (t: TaskRow): string | null => (t.source && "repo" in t.source ? t.source.repo.slice(0, 200) : null);
const prOf = (t: TaskRow): string | null => (t.source?.kind === "github_pr" ? `${t.source.repo}#${t.source.number}` : null);
const orgOf = (d: ComplianceDraft): string => {
  const target = d.targets.find((x) => x.kind === "access_slices");
  return target && target.kind === "access_slices" ? target.org : d.title;
};

/** A breach clock not yet past, or past within the report week (from `since`): a resolved incident still owes its notice. */
function clockRunning(incident: Incident, since: Date): boolean {
  const breach = assessedBreach(incident.breach);
  return breach !== null && Object.values(breach.clocks).some((at) => new Date(at as string) >= since);
}

/** The next breach deadline of an open incident: the earliest clock still ahead, else the earliest there is. */
function nextDeadline(incident: Incident, now: Date): { regime: string; at: string } | null {
  const breach = assessedBreach(incident.breach);
  if (!breach) return null;
  const clocks = Object.entries(breach.clocks).map(([regime, at]) => ({ regime: REGIME_NAME[regime] ?? regime, at: at as string }));
  const sorted = clocks.toSorted((a, b) => a.at.localeCompare(b.at));
  return sorted.find((c) => new Date(c.at) >= now) ?? sorted[0] ?? null;
}
