import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CapacityContext, StatusReportContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BacklogEntry } from "@hardness/contracts";
import { ComplianceDrafts } from "./compliance-drafts.ts";
import { StatusReport, type StatusReportDeps } from "./status-report.ts";

const MONDAY = new Date(2026, 10, 16, 9, 0, 0);
const at = (day: number, hour = 12) => new Date(2026, 10, day, hour, 0, 0);

const task = (over: Record<string, unknown>) => ({ id: "t", title: "A card", state: "closed", source: null, reason: null, archiveReason: null, repoPath: null, stateSince: at(10), updatedAt: at(10), createdAt: at(1), ...over });
const tasks = [
  task({ id: "1", title: "Export a report as CSV", source: { kind: "github_pr", repo: "acme/api", number: 38, url: "u", headRef: "h", baseRef: "main" }, stateSince: at(11) }),
  task({ id: "2", title: "Archived duplicate", state: "archived", archiveReason: "duplicate" }),
  task({ id: "3", title: "Closed last month", stateSince: new Date(2026, 9, 20), updatedAt: new Date(2026, 9, 20) }),
  task({ id: "4", title: "Rate limits per tenant", state: "implementing", stateSince: at(12) }),
  task({ id: "5", title: "Migrate auth", state: "awaiting_answers", reason: null }),
  task({ id: "6", title: "Flaky build", state: "escalated", reason: "the verify loop ran out" }),
  task({ id: "7", title: "A draft", state: "draft" }),
  task({ id: "8", title: "Closed three weeks ago", stateSince: at(-5, 12) }),
];

const metrics = { tasks: { created: 9, closed: 7, open: 12, waitingOnYou: 2, running: 1, queued: 0 }, flow: { leadTimeMs: { median: 31.5 * 3_600_000, p90: null, n: 4 } }, firstPassRate: { verifying: 0.8, ci_watch: null, implementing: null }, escalations: { rate: null, topReasons: [] }, cost: { totalUsd: 42.5 } };

const entry = (n: number): BacklogEntry => ({ id: `b${n}`, title: `Item ${n}`, text: "", sources: [], repo: "acme/api", scores: { who: 1, what: 1, impact: 1, time: 1, demand: 1 }, size: "M", demand: 1, dependsOn: [], addedAt: "x", assessedAt: "x", score: 10 - n / 10, stale: false, schedulable: n !== 2 }) as BacklogEntry;

const answer = { headline: "Seven cards shipped", shipped: ["CSV export"], risks: ["Auth waits"], compliance: ["3 exceptions"], asks: [], summary: "Seven shipped." };
const capacityAnswer = { over_agent_capacity: { value: true, p: 0.8 }, over_review_capacity: { value: false, p: 0.2 }, at_risk: { score: 1, confidence: 0.6 } };

let stateDir: string;
beforeEach(() => void (stateDir = mkdtempSync(join(tmpdir(), "status-report-"))));

function world(over: Partial<StatusReportDeps> = {}) {
  const drafts = new ComplianceDrafts({ stateDir });
  const write = vi.fn(async (_context: StatusReportContext): Promise<unknown> => answer);
  const assess = vi.fn(async (_context: CapacityContext): Promise<unknown> => capacityAnswer);
  const mergedPrs = vi.fn(async (_repo: string, _since: string, _until: string) => [
    { number: 1, title: "t", url: "u", body: "", author: "marta", mergedBy: "lee", mergedAt: at(11).toISOString(), mergeSha: null, baseRef: "main", headRef: "h", headSha: null, closingIssues: [], reviews: [{ author: "me", state: "APPROVED" as const, commitId: null, submittedAt: at(11).toISOString() }, { author: "lee", state: "APPROVED" as const, commitId: null, submittedAt: at(11).toISOString() }] },
    { number: 2, title: "t", url: "u", body: "", author: "marta", mergedBy: "lee", mergedAt: at(12).toISOString(), mergeSha: null, baseRef: "main", headRef: "h", headSha: null, closingIssues: [], reviews: [{ author: "me", state: "COMMENTED" as const, commitId: null, submittedAt: at(12).toISOString() }] },
  ]);
  const log = vi.fn();
  const deps: StatusReportDeps = {
    drafts,
    tasks: async () => tasks as never,
    metrics: async () => metrics as never,
    github: { mergedPrs, viewer: async () => ({ login: "me", teams: [] }) },
    incidents: {
      list: async () =>
        [
          { id: "i1", title: "Export bucket public", severity: "high", status: "open", startedAt: at(10).toISOString(), resolvedAt: null, service: null, signals: [], timeline: [], breach: { assessedAt: "x", answers: {}, regimes: ["gdpr", "hipaa"], clocks: { gdpr: "2026-11-18T09:00:00.000Z", hipaa: "2027-01-10T09:00:00.000Z" }, error: "rate limited", errorAt: "2026-11-15T00:00:00.000Z" } },
          { id: "i2", title: "Old one", severity: "low", status: "resolved", startedAt: at(1).toISOString(), resolvedAt: at(2).toISOString(), service: null, signals: [], timeline: [] },
        ] as never,
    },
    vulns: { list: async () => [{ repo: "acme/api", key: "dependabot:7", severity: "high", lane: "fast", deadline: "2026-11-20", cardId: "c1", overdue: true }] as never },
    backlog: { list: async () => Array.from({ length: 35 }, (_, i) => entry(i + 1)) },
    headroom: async () => [{ engine: "claude:sonnet", budgetLeftUsd: 12, rateLimitedHours: 2 }],
    assess,
    write,
    repos: async () => ["acme/api"],
    wikiRepo: "acme/home",
    slackChannel: "C0123ABC",
    day: "monday",
    stateDir,
    log,
    now: () => MONDAY,
    ...over,
  };
  return { job: new StatusReport(deps), drafts, write, assess, mergedPrs, log };
}

describe("StatusReport.build", () => {
  it("opens one draft for the week: the page, the headline as summary, the channel and the wiki page as targets", async () => {
    const { job, drafts } = world();
    const draft = await job.build("2026-W46");
    expect(draft).toMatchObject({ id: "status_report:2026-W46", kind: "status_report", repo: "acme/home", title: "Status, 2026-W46", period: "2026-W46", summary: "Seven cards shipped", status: "waiting" });
    expect(draft.targets).toEqual([{ kind: "slack_channel", channel: "C0123ABC" }, { kind: "wiki", repo: "acme/home", path: "Status/2026-W46.md" }]);
    expect(draft.text).toContain("## Summary\n\nSeven shipped.");
    expect(draft.text).toContain("Cards: 9 created, 7 closed, 12 open, 2 waiting on you");
    expect((await drafts.list()).map((d) => d.id)).toEqual(["status_report:2026-W46"]);
  });

  it("targets only the wiki without a channel", async () => {
    const { job } = world({ slackChannel: null });
    expect((await job.build("2026-W46")).targets).toEqual([{ kind: "wiki", repo: "acme/home", path: "Status/2026-W46.md" }]);
  });

  it("gives the writer the week's facts: shipped, in flight, blocked, merged, the metrics and the compliance state", async () => {
    const { job, write, drafts } = world();
    await drafts.open({ id: "change_evidence:acme/api:2026-10", kind: "change_evidence", repo: "acme/api", title: "Change management, acme/api, 2026-10", period: "2026-10", summary: "142 PRs, 3 with exceptions", text: "t", targets: [{ kind: "wiki", repo: "acme/api", path: "p.md" }] });
    await drafts.open({ id: "access_review:acme:2026-Q4", kind: "access_review", repo: "acme/home", title: "Access review, acme, 2026-Q4", period: "2026-Q4", summary: "4 flags, 1 new", text: "t", targets: [{ kind: "wiki", repo: "acme/home", path: "p.md" }, { kind: "access_slices", org: "acme", period: "2026-Q4" }] });
    await job.build("2026-W46");
    const context = write.mock.calls[0]![0];
    expect(StatusReportContext.safeParse(context).success).toBe(true);
    expect(context).toMatchObject({ week: "2026-W46", from: "2026-11-09", to: "2026-11-15" });
    expect(context.metrics).toEqual({ created: 9, closed: 7, open: 12, waitingOnYou: 2, leadTimeHours: 31.5, firstPassRate: 0.8, escalationRate: null, costUsd: 42.5 });
    expect(context.shipped).toEqual([{ title: "Export a report as CSV", repo: "acme/api", pr: "acme/api#38" }]);
    expect(context.inFlight).toEqual([{ title: "Rate limits per tenant", state: "implementing" }]);
    expect(context.blocked).toEqual([{ title: "Migrate auth", why: "waiting on an answer" }, { title: "Flaky build", why: "the verify loop ran out" }]);
    expect(context.merged).toEqual([{ repo: "acme/api", count: 2 }]);
    expect(context.compliance.waitingDrafts.map((d) => d.kind).sort()).toEqual(["access_review", "change_evidence"]);
    expect(context.compliance.evidence).toEqual([{ repo: "acme/api", period: "2026-10", exceptions: 3 }]);
    expect(context.compliance.access).toEqual([{ org: "acme", period: "2026-Q4", flags: 4, signed: false }]);
    expect(context.compliance.incidents).toEqual([{ title: "Export bucket public", severity: "high", status: "open", nextDeadline: { regime: "GDPR", at: "2026-11-18T09:00:00.000Z" } }]);
    expect(context.compliance.vulns).toEqual([{ repo: "acme/api", severity: "high", deadline: "2026-11-20", overdue: true }]);
  });

  it("asks capacity_check about the coming week: the top thirty by WSJF, the closed and reviewed counts of the last four weeks, the headroom", async () => {
    const { job, assess, write } = world();
    await job.build("2026-W46");
    const context = assess.mock.calls[0]![0];
    expect(context.week).toBe("2026-W47");
    expect(context.backlog).toHaveLength(30);
    expect(context.backlog[0]).toEqual({ title: "Item 1", repo: "acme/api", size: "M", wsjf: 9.9, state: "ready" });
    expect(context.backlog[1]!.state).toBe("blocked");
    // Weeks W43 to W46, oldest first: the card closed on the 10th and the one on the 11th are in W46; the ones from October are in W43 and W44.
    expect(context.throughput.closedPerWeek).toEqual([1, 1, 0, 1]);
    // The person ("me") reviewed PR 1 (approved) and PR 2 (commented) in W46.
    expect(context.throughput.reviewedPerWeek).toEqual([0, 0, 0, 2]);
    expect(context.headroom).toEqual([{ engine: "claude:sonnet", budgetLeftUsd: 12, rateLimitedHours: 2 }]);
    expect(write.mock.calls[0]![0].capacity).toEqual({ answers: { overAgentCapacity: true, overReviewCapacity: false, atRisk: "some" } });
  });

  it("goes on without capacity when the check fails or answers nonsense", async () => {
    for (const assess of [async () => Promise.reject(new Error("no model")), async () => ({ nonsense: true })]) {
      const { job, write, log } = world({ assess });
      await job.build("2026-W46");
      expect(write.mock.calls[0]![0].capacity).toBeNull();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("capacity"));
    }
  });

  it("opens no draft when the writer fails or answers nonsense", async () => {
    for (const writer of [async () => Promise.reject(new Error("no model")), async () => ({ headline: "" })]) {
      const { job, drafts } = world({ write: writer });
      await expect(job.build("2026-W46")).rejects.toThrow();
      expect(await drafts.list()).toEqual([]);
    }
  });

  it("leaves a repo out of the merged counts when GitHub fails for it", async () => {
    const { job, write, log } = world({ github: { mergedPrs: async () => Promise.reject(new Error("403")), viewer: async () => ({ login: "me", teams: [] }) } });
    await job.build("2026-W46");
    expect(write.mock.calls[0]![0].merged).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("acme/api"));
  });
});

describe("StatusReport.tick", () => {
  it("does nothing off the configured day, or before eight in the morning", async () => {
    const { job, write } = world();
    await job.tick(new Date(2026, 10, 17, 9, 0));
    await job.tick(new Date(2026, 10, 16, 7, 59));
    expect(write).not.toHaveBeenCalled();
  });

  it("builds the previous Monday to Sunday on the day, once: the cursor remembers the week", async () => {
    const { job, write, drafts } = world();
    await job.tick(MONDAY);
    await job.tick(new Date(2026, 10, 16, 15, 0));
    expect(write).toHaveBeenCalledTimes(1);
    expect((await drafts.list()).map((d) => d.id)).toEqual(["status_report:2026-W46"]);
    expect(JSON.parse(readFileSync(join(stateDir, "compliance", "status-cursor.json"), "utf8"))).toEqual({ schema: 1, done: "2026-W46" });
    // The next Monday is another week.
    await job.tick(new Date(2026, 10, 23, 9, 0));
    expect((await drafts.list()).map((d) => d.id).sort()).toEqual(["status_report:2026-W46", "status_report:2026-W47"]);
  });

  it("follows the configured day", async () => {
    const { job, write } = world({ day: "friday" });
    await job.tick(MONDAY);
    expect(write).not.toHaveBeenCalled();
    await job.tick(new Date(2026, 10, 20, 8, 0));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("logs a failure, opens no draft and does not mark the week: the next tick tries again", async () => {
    let fail = true;
    const { job, drafts, log } = world({ write: async () => (fail ? Promise.reject(new Error("rate limited")) : answer) });
    await job.tick(MONDAY);
    expect(await drafts.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
    fail = false;
    await job.tick(new Date(2026, 10, 16, 10, 0));
    expect((await drafts.list()).map((d) => d.id)).toEqual(["status_report:2026-W46"]);
  });

  it("joins a pass already running instead of doubling it", async () => {
    const { job, write } = world();
    await Promise.all([job.tick(MONDAY), job.tick(MONDAY)]);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
