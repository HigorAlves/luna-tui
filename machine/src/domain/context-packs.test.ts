import { PackId, StageInput } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import { CONTEXT_OF, NOT_ON_DEMAND, contextSchema, isContextPack } from "./context-packs.ts";
import { packStates } from "./packs.ts";
import { buildContextPackInput, buildJiraIntakeInput, buildSlackTriageInput } from "./stage-input.ts";

const chat = { source: "slack" as const, me: { id: "U1", name: "higor" }, items: [{ id: "C1:1", place: "#eng", kind: "channel" as const, author: "@marta", isBot: false, text: "review?" }] };
const issue = { title: "Board crashes on resize", description: "It panics.", labels: ["bug"] };
const jira = { key: "PLAT-1", url: "https://a.atlassian.net/browse/PLAT-1", summary: "Login", description: "Sign in.", issueType: "Story", priority: null, labels: [], dueAt: null, comments: [], repoPath: null };
const plan = { record: null, brief: "Guard the empty list", criteria: ["no panic"], assumptions: [], slices: [{ title: "s", est_loc: 5, touchpoints: ["a.ts"], acceptance: ["no panic"] }], cases: [{ title: "t", criterion: "no panic", approach: "run it" }] };
const slack = { me: { id: "U1", name: "higor" }, watches: [], rules: "", items: [] };

describe("context-only packs", () => {
  it("are the packs that run in no task state, but for the deny list: slack_triage, jira_intake, triage_signals, the three plan checks and chat_triage", () => {
    const none = PackId.options.filter((id) => packStates(id).length === 0);
    // A new context-only pack must be given a context key or be denied: never on demand by accident.
    expect(none.filter((id) => !NOT_ON_DEMAND.includes(id)).sort()).toEqual(Object.keys(CONTEXT_OF).sort());
    expect(Object.keys(CONTEXT_OF).sort()).toEqual(["access_review", "breach_assess", "capacity_check", "change_exceptions", "chat_triage", "ci_failure_class", "comment_intent", "conversation_assess", "conversation_relation", "conversation_reply", "coverage_check", "decompose", "e2e_failure_cause", "escalation_reason", "event_class", "evidence_format", "evidence_valid", "fact_propose", "finding_classify", "fix_scope", "foreman", "frame_privacy", "intake_dedup", "jira_intake", "loop_judge", "loop_redirect", "plan_check", "postmortem", "pr_link", "questionnaire", "red_check", "release_notes", "risk_score", "scope_check", "size_estimate", "slack_triage", "split_check", "status_report", "ticket_assess", "ticket_recommend", "ticket_reply", "ticket_safety", "ticket_validity", "triage_signals", "vuln_triage", "worth_learning"]);
    expect(isContextPack("triage")).toBe(false);
    expect(isContextPack("reviewing_memory")).toBe(false);
    expect(isContextPack("chat_triage")).toBe(true);
  });

  it("never include eval_judge: it runs in no task state, but grades eval cases for the evals runner only", () => {
    expect(packStates("eval_judge")).toEqual([]);
    expect(NOT_ON_DEMAND).toContain("eval_judge");
    expect(isContextPack("eval_judge")).toBe(false);
  });

  it("never include compliance_review: it reviews a PR's diff in a worktree, so a client has nothing to send it", () => {
    expect(packStates("compliance_review")).toEqual([]);
    expect(NOT_ON_DEMAND).toContain("compliance_review");
    expect(isContextPack("compliance_review")).toBe(false);
  });

  it("never include docs_drift: it reads a change in a worktree, so a client has nothing to send it", () => {
    expect(packStates("docs_drift")).toEqual([]);
    expect(NOT_ON_DEMAND).toContain("docs_drift");
    expect(isContextPack("docs_drift")).toBe(false);
  });

  it("take an object with the pack's own key and nothing else", () => {
    expect(contextSchema("chat_triage").safeParse({ chat }).success).toBe(true);
    for (const pack of ["risk_score", "coverage_check", "plan_check"] as const) {
      expect(packStates(pack)).toEqual([]);
      expect(contextSchema(pack).safeParse({ plan }).success).toBe(true);
      expect(contextSchema(pack).safeParse({ issue }).success).toBe(false);
    }
    expect(contextSchema("triage_signals").safeParse({ issue }).success).toBe(true);
    expect(contextSchema("jira_intake").safeParse({ jira }).success).toBe(true);
    expect(contextSchema("chat_triage").safeParse({ issue }).success).toBe(false);
    expect(contextSchema("chat_triage").safeParse({ chat, issue }).success).toBe(false);
    expect(contextSchema("chat_triage").safeParse({ chat: { ...chat, items: [] } }).success).toBe(false);
  });
});

describe("buildContextPackInput", () => {
  it("builds chat_triage's and triage_signals's input around a synthetic task with the context under its key", () => {
    const chatInput = buildContextPackInput("chat_triage", { chat }, "codex:luna");
    expect(StageInput.parse(chatInput)).toEqual(chatInput);
    expect(chatInput).toMatchObject({ pack: "chat_triage", stage: "chat_triage", engine: "codex:luna", attempt: 1, task: { id: "chat-triage", title: "Chat triage", repoPath: "", branch: "", source: null }, plan: null, context: { projectContext: null, chat }, limits: { maxTurns: 3, timeoutMs: 180_000 } });
    const issueInput = buildContextPackInput("triage_signals", { issue });
    expect(StageInput.parse(issueInput)).toEqual(issueInput);
    expect(issueInput).toMatchObject({ pack: "triage_signals", task: { id: "triage-signals", title: "Board crashes on resize", description: "It panics." }, context: { projectContext: null, issue }, limits: { maxTurns: 1, timeoutMs: 60_000 } });
    expect(issueInput).not.toHaveProperty("engine");
  });

  it("builds foreman's input around a synthetic task with the board under context.foreman", () => {
    const foreman = { question: "what needs me?", history: [], board: { now: "2026-11-16T12:00:00.000Z", cards: [], packs: [] } };
    expect(isContextPack("foreman")).toBe(true);
    expect(packStates("foreman")).toEqual([]);
    expect(contextSchema("foreman").safeParse({ foreman }).success).toBe(true);
    expect(contextSchema("foreman").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("foreman", { foreman });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "foreman", stage: "foreman", task: { id: "foreman", title: "Foreman", repoPath: "" }, context: { projectContext: null, foreman }, limits: { maxTurns: 2, timeoutMs: 120_000 } });
  });

  it("builds change_exceptions' input around a synthetic task with the facts under context.exceptions", () => {
    const exceptions = { repo: "acme/api", period: "2026-10", controls: ["SOC2 CC8.1"], exceptions: [] };
    expect(isContextPack("change_exceptions")).toBe(true);
    expect(packStates("change_exceptions")).toEqual([]);
    expect(contextSchema("change_exceptions").safeParse({ exceptions }).success).toBe(true);
    expect(contextSchema("change_exceptions").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("change_exceptions", { exceptions });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "change_exceptions", stage: "change_exceptions", task: { id: "change-exceptions", title: "Change exceptions of acme/api, 2026-10", repoPath: "" }, context: { projectContext: null, exceptions }, limits: { maxTurns: 1, timeoutMs: 120_000 } });
  });

  it("builds access_review's input around a synthetic task with the flags under context.access", () => {
    const access = { org: "acme", period: "2026-Q4", flags: [], removedSinceSigned: [] };
    expect(isContextPack("access_review")).toBe(true);
    expect(packStates("access_review")).toEqual([]);
    expect(contextSchema("access_review").safeParse({ access }).success).toBe(true);
    expect(contextSchema("access_review").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("access_review", { access });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "access_review", stage: "access_review", task: { id: "access-review", title: "Access review of acme, 2026-Q4", repoPath: "" }, context: { projectContext: null, access }, limits: { maxTurns: 1, timeoutMs: 120_000 } });
  });

  it("builds breach_assess' input around a synthetic task named for the incident, the facts under context.breach", () => {
    const breach = { title: "Export bucket public", severity: "high" as const, service: null, startedAt: "2026-11-10T09:00:00.000Z", timeline: [], signals: [] };
    expect(isContextPack("breach_assess")).toBe(true);
    expect(packStates("breach_assess")).toEqual([]);
    expect(contextSchema("breach_assess").safeParse({ breach }).success).toBe(true);
    expect(contextSchema("breach_assess").safeParse({ breach: { ...breach, severity: "p0" } }).success).toBe(false);
    const input = buildContextPackInput("breach_assess", { breach });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "breach_assess", task: { id: "breach-assess", title: "Incident: Export bucket public", repoPath: "" }, context: { projectContext: null, breach }, limits: { maxTurns: 1 } });
  });

  it("builds postmortem's input around a synthetic task named for the incident, the facts under context.postmortem", () => {
    const postmortem = { incident: { title: "Export bucket public", severity: "high" as const, service: null, startedAt: "2026-11-10T09:00:00.000Z", resolvedAt: null, timeline: [], signals: [] }, breach: null };
    expect(isContextPack("postmortem")).toBe(true);
    expect(packStates("postmortem")).toEqual([]);
    expect(contextSchema("postmortem").safeParse({ postmortem }).success).toBe(true);
    expect(contextSchema("postmortem").safeParse({ postmortem: { ...postmortem, breach: { regimes: ["x"], clocks: {} } } }).success).toBe(false);
    const input = buildContextPackInput("postmortem", { postmortem });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "postmortem", task: { id: "postmortem", title: "Postmortem: Export bucket public", repoPath: "" }, context: { projectContext: null, postmortem }, limits: { maxTurns: 1 } });
  });

  it("builds questionnaire's input around a synthetic task named for the repo with the file and pages under context.questionnaire", () => {
    const questionnaire = { repo: "acme/api", source: "jira" as const, requester: null, questionnaire: { name: "q.md", markdown: "1. Do you encrypt?" }, policies: [], bank: [] };
    expect(isContextPack("questionnaire")).toBe(true);
    expect(packStates("questionnaire")).toEqual([]);
    expect(contextSchema("questionnaire").safeParse({ questionnaire }).success).toBe(true);
    expect(contextSchema("questionnaire").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("questionnaire", { questionnaire });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "questionnaire", stage: "questionnaire", task: { id: "questionnaire", title: "Questionnaire for acme/api", repoPath: "" }, context: { projectContext: null, questionnaire }, limits: { maxTurns: 2 } });
  });

  it("builds vuln_triage's input around a synthetic task named for the alert, the alert and policy under context.vulns", () => {
    const vulns = { repo: "acme/api", alert: { source: "dependabot" as const, number: 7, severity: "high" as const, title: "Prototype pollution", url: "https://github.com/acme/api/security/dependabot/7", createdAt: "2026-11-01T00:00:00Z", package: "lodash", ecosystem: "npm", manifestPath: "pnpm-lock.yaml", vulnerableRange: "< 4.17.21", patchedVersion: "4.17.21", ghsa: "GHSA-aaaa", cve: null, rule: null, tool: null, path: null }, policy: null, today: "2026-11-16" };
    expect(isContextPack("vuln_triage")).toBe(true);
    expect(packStates("vuln_triage")).toEqual([]);
    expect(contextSchema("vuln_triage").safeParse({ vulns }).success).toBe(true);
    expect(contextSchema("vuln_triage").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("vuln_triage", { vulns });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "vuln_triage", stage: "vuln_triage", task: { id: "vuln-triage", title: "Vulnerability alert of acme/api", repoPath: "" }, context: { projectContext: null, vulns }, limits: { maxTurns: 1, timeoutMs: 120_000 } });
  });

  it("builds release_notes' input around a synthetic task named for the release, the PRs under context.release", () => {
    const release = { repo: "acme/api", tag: "v1.4.0", since: "2026-10-01T00:00:00Z", prs: [{ number: 38, title: "Export a report as CSV", author: "marta", body: "Adds the button.", url: "https://github.com/acme/api/pull/38" }] };
    expect(isContextPack("release_notes")).toBe(true);
    expect(packStates("release_notes")).toEqual([]);
    expect(contextSchema("release_notes").safeParse({ release }).success).toBe(true);
    expect(contextSchema("release_notes").safeParse({ chat }).success).toBe(false);
    const input = buildContextPackInput("release_notes", { release });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "release_notes", stage: "release_notes", task: { id: "release-notes", title: "Release notes of acme/api v1.4.0", repoPath: "" }, context: { projectContext: null, release }, limits: { maxTurns: 1, timeoutMs: 120_000 } });
  });

  it("builds status_report's input around a synthetic task named for the week, the facts under context.status", () => {
    const status = { week: "2026-W46", from: "2026-11-09", to: "2026-11-15",
    metrics: { created: 9, closed: 7, open: 12, waitingOnYou: 2, leadTimeHours: 31.5, firstPassRate: 0.8, escalationRate: 0.1, costUsd: 42.5 },
    shipped: [{ title: "Export a report as CSV", repo: "acme/api", pr: "acme/api#38" }],
    inFlight: [{ title: "Rate limits per tenant", state: "implementing" }],
    blocked: [{ title: "Migrate auth", why: "waiting on an answer" }],
    merged: [{ repo: "acme/api", count: 14 }],
    compliance: {
      waitingDrafts: [{ kind: "change_evidence", title: "Change management, acme/api, 2026-10" }],
      evidence: [{ repo: "acme/api", period: "2026-10", exceptions: 3 }],
      access: [{ org: "acme", period: "2026-Q4", flags: 4, signed: false }],
      incidents: [{ title: "Export bucket public", severity: "high" as const, status: "open", nextDeadline: { regime: "GDPR", at: "2026-11-18T09:00:00.000Z" } }],
      vulns: [{ repo: "acme/api", severity: "high", deadline: "2026-11-20", overdue: false }],
    },
    capacity: { answers: { overAgentCapacity: true, overReviewCapacity: false, atRisk: "some" as const } } };
    expect(isContextPack("status_report")).toBe(true);
    expect(packStates("status_report")).toEqual([]);
    expect(contextSchema("status_report").safeParse({ status }).success).toBe(true);
    expect(contextSchema("status_report").safeParse({ status: { ...status, week: "last week" } }).success).toBe(false);
    const input = buildContextPackInput("status_report", { status });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "status_report", task: { id: "status-report", title: "Status of 2026-W46", repoPath: "" }, context: { projectContext: null, status }, limits: { maxTurns: 1, timeoutMs: 120_000 } });
  });

  it("builds capacity_check's input around a synthetic task named for the week, the facts under context.capacity", () => {
    const capacity = { week: "2026-W47", backlog: [], throughput: { closedPerWeek: [1, 2, 3, 4], reviewedPerWeek: [4, 3, 2, 1] }, headroom: [] };
    expect(isContextPack("capacity_check")).toBe(true);
    expect(packStates("capacity_check")).toEqual([]);
    expect(contextSchema("capacity_check").safeParse({ capacity }).success).toBe(true);
    expect(contextSchema("capacity_check").safeParse({ capacity: { ...capacity, week: "next" } }).success).toBe(false);
    const input = buildContextPackInput("capacity_check", { capacity });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "capacity_check", task: { id: "capacity-check", title: "Capacity of 2026-W47", repoPath: "" }, context: { projectContext: null, capacity }, limits: { maxTurns: 1 } });
  });

  it("builds the plan checks' input around a synthetic task named for the brief, the plan under context.plan", () => {
    for (const pack of ["risk_score", "coverage_check", "plan_check"] as const) {
      const input = buildContextPackInput(pack, { plan });
      expect(StageInput.parse(input)).toEqual(input);
      expect(input).toMatchObject({ pack, stage: pack, attempt: 1, task: { title: "Guard the empty list", repoPath: "" }, plan: null, context: { projectContext: null, plan }, limits: { maxTurns: 1 } });
    }
  });

  it("builds the build checks' input with the check under context.check", () => {
    for (const pack of ["red_check", "scope_check"] as const) {
      const check = { kind: pack === "red_check" ? ("red" as const) : ("scope" as const), output: "AssertionError" };
      expect(contextSchema(pack).safeParse({ check }).success).toBe(true);
      expect(contextSchema(pack).safeParse({ plan }).success).toBe(false);
      const input = buildContextPackInput(pack, { check });
      expect(StageInput.parse(input)).toEqual(input);
      expect(input).toMatchObject({ pack, stage: pack, task: { title: pack === "red_check" ? "Red check" : "Scope check", repoPath: "" }, context: { projectContext: null, check }, limits: { maxTurns: 1 } });
    }
  });

  it("builds evidence_format's input with the evidence context under context.evidence, titled by the record's goal or the task", () => {
    const e2e = { ran: true, verdict: "pass", hasVideo: true, hasSteps: true, scenarios: 2, skippedReason: null };
    const evidence = { record: null, risk: "low" as const, webSurface: true, e2e, videoImage: true };
    expect(contextSchema("evidence_format").safeParse({ evidence }).success).toBe(true);
    expect(contextSchema("evidence_format").safeParse({ plan }).success).toBe(false);
    expect(packStates("evidence_format")).toEqual([]);
    expect(isContextPack("evidence_format")).toBe(true);
    const input = buildContextPackInput("evidence_format", { evidence });
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "evidence_format", stage: "evidence_format", task: { title: "Evidence format", repoPath: "" }, plan: null, context: { projectContext: null, evidence }, limits: { maxTurns: 1 } });
    const record = { source: "github", kind: "bug", goal: "Pressing j on an empty list must not panic", size: "small", urgency: "normal", risk: "low" as const, signals: {}, qa: [], decision: "plan" as const, reason: "r", at: "2026-11-03T12:00:00.000Z", model: "m" };
    expect(buildContextPackInput("evidence_format", { evidence: { ...evidence, record } }).task.title).toBe("Evidence format: Pressing j on an empty list must not panic");
  });

  it("builds each ship decision's input with the ship context under context.ship, titled by the event, the comment, the fix or the retro", () => {
    const event = { kind: "event" as const, event: { actor: "ana", isBot: false, isMe: false, kind: "review" as const, body: "no", url: null } };
    const comment = { kind: "comment" as const, comment: { thread: { id: "T1", path: "a.ts", line: 3, comments: [] }, pack: { summary: "s", scenarios: [], howToVerify: "h" }, myReplies: 0 } };
    const fix = { kind: "fix" as const, fix: { changed: ["a.ts"], diffSummary: "d", scenarios: [], threadSummary: "rename x" } };
    const retro = { kind: "retro" as const, retro: { predicted: { size: null, risk: null, estLoc: null }, actual: { added: 1, removed: 0, retries: { verify: 0, e2e: 0, ci: 0, total: 0 }, escalations: 0, format: null, durationMin: null }, runs: 1 } };
    for (const pack of ["event_class", "comment_intent", "fix_scope", "evidence_valid", "worth_learning"] as const) {
      expect(contextSchema(pack).safeParse({ ship: event }).success).toBe(true);
      expect(contextSchema(pack).safeParse({ plan }).success).toBe(false);
      expect(packStates(pack)).toEqual([]);
      expect(isContextPack(pack)).toBe(true);
    }
    const titled = (ship: typeof event | typeof comment | typeof fix | typeof retro) => buildContextPackInput("event_class", { ship });
    expect(titled(event).task.title).toBe("PR event: ana review");
    expect(titled(comment).task.title).toBe("Comment on a.ts");
    expect(titled(fix).task.title).toBe("Fix: rename x");
    expect(titled(retro).task.title).toBe("Retro: task");
    const input = titled(event);
    expect(StageInput.parse(input)).toEqual(input);
    expect(input).toMatchObject({ pack: "event_class", context: { projectContext: null, ship: event }, limits: { maxTurns: 1 } });
  });

  it("titles the finding and e2e checks' synthetic task", () => {
    const finding = { path: "src/a.ts", line: 3, severity: "bug", title: "off by one", body: "loops past the end", confidence: 0.8 };
    const f = buildContextPackInput("finding_classify", { check: { kind: "finding", finding, excerpt: "for (;;) {}" } });
    expect(StageInput.parse(f)).toEqual(f);
    expect(f.task.title).toBe("Finding: off by one");
    expect(f.context.check).toMatchObject({ kind: "finding", excerpt: "for (;;) {}" });
    const e2e = { verdict: "fail" as const, summary: "login broke", criteria: [{ text: "login", result: "fail" as const }], attempt: 2 };
    const e = buildContextPackInput("e2e_failure_cause", { check: { kind: "e2e", e2e } });
    expect(StageInput.parse(e)).toEqual(e);
    expect(e.task.title).toBe("E2E failure: attempt 2");
  });

  it("gives slack_triage and jira_intake exactly the input their own runners build", () => {
    expect(buildContextPackInput("slack_triage", { slack }, "claude:haiku")).toEqual(buildSlackTriageInput(slack, "claude:haiku"));
    expect(buildContextPackInput("jira_intake", { jira }, "claude:sonnet")).toEqual(buildJiraIntakeInput(jira, "claude:sonnet"));
  });
});

describe("the change-size decisions", () => {
  const limit = { target: [1000, 2000] as [number, number], hard: 2500 };
  it("size_estimate reads context.size and split_check context.split, both on demand with no task state", () => {
    const size = { title: "Export", text: "x", criteria: [], files: [], symbols: [], similar: [], limit };
    const split = { origin: { title: "Big", text: "x", criteria: [] }, files: [], limit: { ...limit, maxChildren: 8 }, children: [], round: 1 };
    for (const [pack, context] of [["size_estimate", { size }], ["split_check", { split }]] as const) {
      expect(packStates(pack)).toEqual([]);
      expect(isContextPack(pack)).toBe(true);
      expect(contextSchema(pack).safeParse(context).success).toBe(true);
      expect(contextSchema(pack).safeParse({ plan }).success).toBe(false);
      const input = buildContextPackInput(pack, context);
      expect(StageInput.parse(input)).toEqual(input);
      expect(input).toMatchObject({ pack, stage: pack, plan: null, context: { projectContext: null, ...context }, limits: { maxTurns: 1 } });
    }
    expect(buildContextPackInput("size_estimate", { size }).task.title).toBe("Export");
  });
});
