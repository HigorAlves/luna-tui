import { describe, expect, it } from "vitest";

import { StatusReportAnswer, StatusReportContext, AccessReviewAnswer, AccessReviewContext, PostmortemAnswer, PostmortemContext, QuestionnaireAnswer, QuestionnaireContext, VulnTriageAnswer, VulnTriageContext, ReleaseNotesAnswer, ReleaseNotesContext, ChangeExceptionKind, ChangeExceptionsAnswer, ChangeExceptionsContext, NO_ACCESS, PACKS, ComplianceActInput, ComplianceDraft, ComplianceDraftKind, ComplianceDraftsResponse, ComplianceEditInput, ComplianceTarget } from "./index.ts";

const draft = {
  id: "change_evidence:acme/api:2026-10",
  kind: "change_evidence",
  repo: "acme/api",
  title: "Change management, acme/api, 2026-10",
  period: "2026-10",
  summary: "142 PRs, 3 exceptions",
  text: "# Change management\n",
  status: "waiting",
  hash: "0123456789abcdef",
  targets: [{ kind: "wiki", repo: "acme/api", path: "Compliance/Change-Management/2026-10.md" }],
  history: [],
  createdAt: "2026-11-01T06:00:00.000Z",
  updatedAt: "2026-11-01T06:00:00.000Z",
};

describe("compliance drafts", () => {
  it("parses a change-evidence draft that targets a repo's wiki", () => {
    expect(ComplianceDraft.parse(draft)).toEqual(draft);
    expect(ComplianceDraftsResponse.parse({ drafts: [draft] }).drafts).toHaveLength(1);
  });

  it("keeps the person's edit beside the machine's text, and a failed push's reason", () => {
    const edited = { ...draft, status: "edited", original: "# machine", text: "# mine", error: "push refused", history: [{ at: draft.createdAt, did: "edited", from: "board" }] };
    expect(ComplianceDraft.parse(edited).original).toBe("# machine");
  });

  it("refuses an unknown kind, status or target", () => {
    expect(() => ComplianceDraft.parse({ ...draft, kind: "memo" })).toThrow();
    expect(() => ComplianceDraft.parse({ ...draft, status: "sent" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "email", to: "x" })).toThrow();
  });

  it("refuses a wiki path that climbs out of the wiki or is absolute", () => {
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme/api", path: "../secrets.md" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme/api", path: "/etc/passwd" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "wiki", repo: "acme", path: "Home.md" })).toThrow();
  });

  it("names change evidence as the first kind", () => {
    expect(ComplianceDraftKind.options).toContain("change_evidence");
  });

  it("asks for the shown hash on every tap, and text on an edit", () => {
    expect(ComplianceActInput.parse({ hash: "0123456789abcdef" })).toEqual({ hash: "0123456789abcdef" });
    expect(() => ComplianceActInput.parse({})).toThrow();
    expect(() => ComplianceEditInput.parse({ hash: "0123456789abcdef", text: "" })).toThrow();
  });

  it("names the five change-management exceptions", () => {
    expect(ChangeExceptionKind.options).toEqual(["no_independent_approval", "stale_approval", "no_ticket", "checks_red", "bypassed"]);
  });

  it("gives the exception explainer a context of facts and an answer of one short text per exception", () => {
    const exception = { pr: 41, title: "Hotfix: login loop (INC-204)", url: "https://github.com/acme/api/pull/41", author: "marta", mergedBy: "marta", mergedAt: "2026-10-14T09:30:00Z", approvedBy: [], ticket: null, checks: "green", bypass: "no", kinds: ["no_independent_approval"], body: "Fixes the incident." };
    const context = { repo: "acme/api", period: "2026-10", controls: ["SOC2 CC8.1"], exceptions: [exception] };
    expect(ChangeExceptionsContext.parse(context)).toEqual(context);
    expect(() => ChangeExceptionsContext.parse({ ...context, exceptions: [{ ...exception, body: "x".repeat(2001) }] })).toThrow();
    expect(() => ChangeExceptionsContext.parse({ ...context, exceptions: Array(201).fill(exception) })).toThrow();
    expect(() => ChangeExceptionsContext.parse({ ...context, period: "October" })).toThrow();
    expect(() => ChangeExceptionsContext.parse({ ...context, exceptions: [{ ...exception, kinds: ["vibes"] }] })).toThrow();
    const answer = { explanations: [{ pr: 41, kind: "no_independent_approval", text: "A hotfix for INC-204, merged by its author.", followUp: "Marta should confirm who reviewed it." }] };
    expect(ChangeExceptionsAnswer.parse(answer)).toEqual(answer);
    expect(() => ChangeExceptionsAnswer.parse({ explanations: [{ ...answer.explanations[0], text: "" }] })).toThrow();
    expect(() => ChangeExceptionsAnswer.parse({ explanations: [{ ...answer.explanations[0], text: "x".repeat(401) }] })).toThrow();
    expect(() => ChangeExceptionsAnswer.parse({ explanations: [{ ...answer.explanations[0], followUp: "x".repeat(201) }] })).toThrow();
    expect(ChangeExceptionsAnswer.parse({ explanations: [{ ...answer.explanations[0], followUp: null }] }).explanations[0]!.followUp).toBeNull();
  });

  it("runs the exception explainer as a text-only agent on haiku or sonnet, with no hands", () => {
    expect(PACKS.change_exceptions).toMatchObject({ kind: "agent", agent: "exception-explainer", writable: false, maxTurns: 1, effort: "low", template: "change_exceptions.md", helpers: [], skills: [] });
    expect(PACKS.change_exceptions.engines).toMatchObject({ default: "claude:haiku", allowed: ["claude:haiku", "claude:sonnet"] });
    expect(PACKS.change_exceptions.access).toEqual(NO_ACCESS);
  });

  it("gives the access reviewer a context of flags and an answer of one suggestion per flag", () => {
    const flag = { id: "org_owner:ann:-", kind: "org_owner", subject: "ann", repo: null, detail: "organization owner", change: "new" };
    const context = { org: "acme", period: "2026-Q4", flags: [flag], removedSinceSigned: ["gone"] };
    expect(AccessReviewContext.parse(context)).toEqual(context);
    expect(() => AccessReviewContext.parse({ ...context, period: "2026-Q5" })).toThrow();
    expect(() => AccessReviewContext.parse({ ...context, flags: [{ ...flag, kind: "vibes" }] })).toThrow();
    expect(() => AccessReviewContext.parse({ ...context, flags: Array(301).fill(flag) })).toThrow();
    const answer = { recommendations: [{ flagId: flag.id, action: "keep", reason: "The founder." }], summary: "One owner." };
    expect(AccessReviewAnswer.parse(answer)).toEqual(answer);
    expect(() => AccessReviewAnswer.parse({ ...answer, recommendations: [{ ...answer.recommendations[0], action: "delete" }] })).toThrow();
    expect(() => AccessReviewAnswer.parse({ ...answer, recommendations: [{ ...answer.recommendations[0], reason: "x".repeat(301) }] })).toThrow();
    expect(() => AccessReviewAnswer.parse({ ...answer, summary: "x".repeat(601) })).toThrow();
  });

  it("runs the access reviewer as a text-only agent on sonnet or haiku, with no hands", () => {
    expect(PACKS.access_review).toMatchObject({ kind: "agent", agent: "access-reviewer", writable: false, maxTurns: 1, effort: "low", template: "access_review.md", helpers: [], skills: [] });
    expect(PACKS.access_review.engines).toMatchObject({ default: "claude:sonnet", allowed: ["claude:sonnet", "claude:haiku"] });
    expect(PACKS.access_review.access).toEqual(NO_ACCESS);
  });

  it("gives the questionnaire drafter the file, the policy pages and the answer bank, and takes back answers with their sources", () => {
    const context = {
      repo: "acme/api",
      source: "slack",
      requester: "dana",
      questionnaire: { name: "acme-vendor.csv", markdown: "1. Do you encrypt data at rest?" },
      policies: [{ path: "Compliance/Policies/Encryption.md", text: "Data at rest is encrypted with AES-256." }],
      bank: [{ path: "Compliance/Answers/do-you-encrypt-ab12cd.md", text: "Yes, AES-256." }],
    };
    expect(QuestionnaireContext.parse(context)).toEqual(context);
    expect(QuestionnaireContext.parse({ ...context, requester: null, source: "jira" }).source).toBe("jira");
    expect(() => QuestionnaireContext.parse({ ...context, source: "email" })).toThrow();
    expect(() => QuestionnaireContext.parse({ ...context, questionnaire: { name: "q.md", markdown: "x".repeat(100_001) } })).toThrow();
    expect(() => QuestionnaireContext.parse({ ...context, policies: Array(21).fill(context.policies[0]) })).toThrow();
    expect(() => QuestionnaireContext.parse({ ...context, bank: Array(101).fill(context.bank[0]) })).toThrow();
    const answer = {
      answers: [{ n: 1, question: "Do you encrypt data at rest?", answer: "Yes, with AES-256.", citations: ["Compliance/Policies/Encryption.md"], fromBank: "Compliance/Answers/do-you-encrypt-ab12cd.md", confidence: "high" }],
      unanswered: [{ n: 2, question: "Do you hold ISO 27001?", why: "No page names the certification." }],
    };
    expect(QuestionnaireAnswer.parse(answer)).toEqual(answer);
    expect(() => QuestionnaireAnswer.parse({ ...answer, answers: [{ ...answer.answers[0], n: 0 }] })).toThrow();
    expect(() => QuestionnaireAnswer.parse({ ...answer, answers: [{ ...answer.answers[0], answer: "x".repeat(1501) }] })).toThrow();
    expect(() => QuestionnaireAnswer.parse({ ...answer, answers: [{ ...answer.answers[0], confidence: "certain" }] })).toThrow();
    expect(QuestionnaireAnswer.parse({ ...answer, answers: [{ ...answer.answers[0], fromBank: null }] }).answers[0]!.fromBank).toBeNull();
  });

  it("runs the questionnaire drafter as a text-only agent on sonnet or opus, with no hands", () => {
    expect(PACKS.questionnaire).toMatchObject({ kind: "agent", agent: "questionnaire-drafter", writable: false, maxTurns: 2, effort: "medium", template: "questionnaire.md", helpers: [], skills: [] });
    expect(PACKS.questionnaire.engines).toMatchObject({ default: "claude:sonnet", allowed: ["claude:sonnet", "claude:opus"] });
    expect(PACKS.questionnaire.access).toEqual(NO_ACCESS);
  });

  it("names every manager draft the waves add", () => {
    expect(ComplianceDraftKind.options).toEqual(["change_evidence", "questionnaire", "access_review", "postmortem", "status_report", "release_notes"]);
  });

  it("parses each target an approved draft can go to", () => {
    const targets = [
      { kind: "wiki", repo: "acme/api", path: "Compliance/Answers/encryption-at-rest.md" },
      { kind: "slack_thread", channel: "C0123ABCD", ts: "1731772800.000100" },
      { kind: "slack_channel", channel: "C0123ABCD" },
      { kind: "jira_comment", key: "SEC-42" },
      { kind: "jira_actions", project: "OPS" },
      { kind: "answer_bank", repo: "acme/api" },
      { kind: "access_slices", org: "acme", period: "2026-Q4" },
      { kind: "github_release", repo: "acme/api", tag: "v1.4.0" },
    ];
    for (const target of targets) expect(ComplianceTarget.parse(target)).toEqual(target);
  });

  it("refuses a malformed channel, thread, key, project, period or tag", () => {
    expect(() => ComplianceTarget.parse({ kind: "slack_thread", channel: "general", ts: "1731772800.000100" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "slack_thread", channel: "C0123ABCD", ts: "yesterday" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "jira_comment", key: "sec-42" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "jira_actions", project: "OPS-1" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "access_slices", org: "acme", period: "Q4" })).toThrow();
    expect(() => ComplianceTarget.parse({ kind: "github_release", repo: "acme/api", tag: "v1 4" })).toThrow();
  });

  it("gives the incident writer a context of facts and a blameless answer with checkable action items", () => {
    const context = {
      incident: { title: "Export bucket public", severity: "high", service: "exports", startedAt: "2026-11-10T09:00:00.000Z", resolvedAt: "2026-11-10T15:00:00.000Z", timeline: [{ at: "2026-11-10T09:00:00.000Z", source: "jira", text: "Jira signal: Export bucket public" }], signals: [] },
      breach: { regimes: ["gdpr"], clocks: { gdpr: "2026-11-13T09:00:00.000Z" } },
    };
    expect(PostmortemContext.parse(context)).toEqual(context);
    expect(PostmortemContext.parse({ ...context, breach: null }).breach).toBeNull();
    expect(() => PostmortemContext.parse({ ...context, breach: { regimes: ["ccpa"], clocks: {} } })).toThrow();
    const answer = { summary: "A bucket served the export.", impact: "Customers' export was readable for six hours.", timeline: [{ at: "2026-11-10T09:00:00.000Z", text: "Declared." }], rootCauses: ["The bucket policy was widened by a migration."], contributingFactors: [], actionItems: [{ title: "Add a public-access check to the deploy", owner: null, due: "2026-12-01" }], breachNotes: null };
    expect(PostmortemAnswer.parse(answer)).toEqual(answer);
    expect(() => PostmortemAnswer.parse({ ...answer, summary: "x".repeat(801) })).toThrow();
    expect(() => PostmortemAnswer.parse({ ...answer, rootCauses: Array(6).fill("a cause") })).toThrow();
    expect(() => PostmortemAnswer.parse({ ...answer, actionItems: Array(11).fill(answer.actionItems[0]) })).toThrow();
    expect(() => PostmortemAnswer.parse({ ...answer, actionItems: [{ title: "x".repeat(121), owner: null, due: null }] })).toThrow();
    expect(() => PostmortemAnswer.parse({ ...answer, actionItems: [{ title: "Fix", owner: null, due: "1 Dec" }] })).toThrow();
  });

  it("runs the incident writer as a text-only agent on sonnet or opus, one turn, medium effort", () => {
    expect(PACKS.postmortem).toMatchObject({ kind: "agent", agent: "incident-writer", writable: false, maxTurns: 1, effort: "medium", template: "postmortem.md", helpers: [], skills: [] });
    expect(PACKS.postmortem.engines).toMatchObject({ default: "claude:sonnet", allowed: ["claude:sonnet", "claude:opus"] });
    expect(PACKS.postmortem.access).toEqual(NO_ACCESS);
  });

  it("gives the vulnerability triage one alert, the company's policy and today, and answers a lane, a deadline and a work item", () => {
    const alert = { source: "dependabot", number: 7, severity: "high", title: "Prototype pollution in lodash", url: "https://github.com/acme/api/security/dependabot/7", createdAt: "2026-11-01T00:00:00Z", package: "lodash", ecosystem: "npm", manifestPath: "pnpm-lock.yaml", vulnerableRange: "< 4.17.21", patchedVersion: "4.17.21", ghsa: "GHSA-aaaa-bbbb-cccc", cve: "CVE-2026-1", rule: null, tool: null, path: null };
    const context = { repo: "acme/api", alert, policy: { path: "Compliance/Policies/Vulnerability-Management.md", text: "High: 14 days." }, today: "2026-11-16" };
    expect(VulnTriageContext.parse(context)).toEqual(context);
    expect(VulnTriageContext.parse({ ...context, policy: null }).policy).toBeNull();
    expect(() => VulnTriageContext.parse({ ...context, alert: { ...alert, source: "snyk" } })).toThrow();
    expect(() => VulnTriageContext.parse({ ...context, today: "yesterday" })).toThrow();
    expect(() => VulnTriageContext.parse({ ...context, alert: { ...alert, title: "x".repeat(501) } })).toThrow();
    const answer = { lane: "fast", deadline: "2026-12-16", severity: "high", title: "Bump lodash to 4.17.21", goal: "Close Dependabot alert 7.", acceptance_criteria: ["The alert closes", "The suite passes"], reason: "A patch bump with a patched version." };
    expect(VulnTriageAnswer.parse(answer)).toEqual(answer);
    expect(() => VulnTriageAnswer.parse({ ...answer, lane: "slow" })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, deadline: "16/12/2026" })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, title: "x".repeat(121) })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, goal: "x".repeat(601) })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, reason: "x".repeat(301) })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, acceptance_criteria: [] })).toThrow();
    expect(() => VulnTriageAnswer.parse({ ...answer, acceptance_criteria: Array(6).fill("c") })).toThrow();
  });

  it("runs the vulnerability triager as a text-only agent on haiku or sonnet, with no hands", () => {
    expect(PACKS.vuln_triage).toMatchObject({ kind: "agent", agent: "vuln-triager", writable: false, maxTurns: 1, effort: "low", template: "vuln_triage.md", helpers: [], skills: [] });
    expect(PACKS.vuln_triage.engines).toMatchObject({ default: "claude:haiku", allowed: ["claude:haiku", "claude:sonnet"] });
    expect(PACKS.vuln_triage.access).toEqual(NO_ACCESS);
  });

  it("gives the release writer the merged PRs and answers highlights, sections of items with their PRs, and breaking changes", () => {
    const pr = { number: 38, title: "Export a report as CSV", author: "marta", body: "Adds the button.", url: "https://github.com/acme/api/pull/38" };
    const context = { repo: "acme/api", tag: "v1.4.0", since: "2026-10-01T00:00:00Z", prs: [pr] };
    expect(ReleaseNotesContext.parse(context)).toEqual(context);
    expect(ReleaseNotesContext.parse({ ...context, prs: [{ ...pr, author: null }] }).prs[0]!.author).toBeNull();
    expect(() => ReleaseNotesContext.parse({ ...context, prs: [{ ...pr, body: "x".repeat(2001) }] })).toThrow();
    expect(() => ReleaseNotesContext.parse({ ...context, prs: Array(201).fill(pr) })).toThrow();
    expect(() => ReleaseNotesContext.parse({ ...context, tag: "v1 4" })).toThrow();
    const answer = { highlights: ["CSV export"], sections: [{ heading: "Features", items: [{ text: "Export a report as CSV", prs: [38] }] }], breaking: [] };
    expect(ReleaseNotesAnswer.parse(answer)).toEqual(answer);
    expect(() => ReleaseNotesAnswer.parse({ ...answer, highlights: Array(6).fill("h") })).toThrow();
    expect(() => ReleaseNotesAnswer.parse({ ...answer, sections: [{ heading: "Chores", items: [] }] })).toThrow();
    expect(() => ReleaseNotesAnswer.parse({ ...answer, sections: [{ heading: "Fixes", items: [{ text: "x".repeat(201), prs: [] }] }] })).toThrow();
  });

  it("runs the release writer as a text-only agent on haiku or sonnet, with no hands", () => {
    expect(PACKS.release_notes).toMatchObject({ kind: "agent", agent: "release-writer", writable: false, maxTurns: 1, effort: "low", template: "release_notes.md", helpers: [], skills: [] });
    expect(PACKS.release_notes.engines).toMatchObject({ default: "claude:haiku", allowed: ["claude:haiku", "claude:sonnet"] });
    expect(PACKS.release_notes.access).toEqual(NO_ACCESS);
  });

  it("gives the status writer one week's facts and answers a headline, shipped, risks, compliance lines, asks and the Slack text, each capped", () => {
    const context = { week: "2026-W46", from: "2026-11-09", to: "2026-11-15",
    metrics: { created: 9, closed: 7, open: 12, waitingOnYou: 2, leadTimeHours: 31.5, firstPassRate: 0.8, escalationRate: 0.1, costUsd: 42.5 },
    shipped: [{ title: "Export a report as CSV", repo: "acme/api", pr: "acme/api#38" }],
    inFlight: [{ title: "Rate limits per tenant", state: "implementing" }],
    blocked: [{ title: "Migrate auth", why: "waiting on an answer" }],
    merged: [{ repo: "acme/api", count: 14 }],
    compliance: {
      waitingDrafts: [{ kind: "change_evidence", title: "Change management, acme/api, 2026-10" }],
      evidence: [{ repo: "acme/api", period: "2026-10", exceptions: 3 }],
      access: [{ org: "acme", period: "2026-Q4", flags: 4, signed: false }],
      incidents: [{ title: "Export bucket public", severity: "high", status: "open", nextDeadline: { regime: "GDPR", at: "2026-11-18T09:00:00.000Z" } }],
      vulns: [{ repo: "acme/api", severity: "high", deadline: "2026-11-20", overdue: false }],
    },
    capacity: { answers: { overAgentCapacity: true, overReviewCapacity: false, atRisk: "some" } } };
    expect(StatusReportContext.parse(context)).toEqual(context);
    expect(StatusReportContext.parse({ ...context, capacity: null }).capacity).toBeNull();
    expect(StatusReportContext.parse({ ...context, compliance: { ...context.compliance, incidents: [{ ...context.compliance.incidents[0], nextDeadline: null }] } }).compliance.incidents[0]!.nextDeadline).toBeNull();
    expect(() => StatusReportContext.parse({ ...context, week: "2026-46" })).toThrow();
    expect(() => StatusReportContext.parse({ ...context, shipped: Array(41).fill(context.shipped[0]) })).toThrow();
    expect(() => StatusReportContext.parse({ ...context, capacity: { answers: { ...context.capacity.answers, atRisk: "most" } } })).toThrow();
    const answer = { headline: "Seven cards shipped; one risk", shipped: ["CSV export"], risks: ["Auth migration waits on an answer"], compliance: ["3 change exceptions in acme/api for 2026-10"], asks: ["Decide whether to hire a contractor for the auth migration"], summary: "Seven shipped." };
    expect(StatusReportAnswer.parse(answer)).toEqual(answer);
    expect(() => StatusReportAnswer.parse({ ...answer, headline: "x".repeat(201) })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, shipped: Array(9).fill("s") })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, risks: Array(7).fill("r") })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, compliance: Array(7).fill("c") })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, asks: Array(5).fill("a") })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, summary: "x".repeat(601) })).toThrow();
    expect(() => StatusReportAnswer.parse({ ...answer, summary: "" })).toThrow();
  });

  it("runs the status writer as a text-only agent on sonnet or haiku at medium effort, with no hands", () => {
    expect(PACKS.status_report).toMatchObject({ kind: "agent", agent: "status-writer", writable: false, maxTurns: 1, effort: "medium", template: "status_report.md", helpers: [], skills: [] });
    expect(PACKS.status_report.engines).toMatchObject({ default: "claude:sonnet", allowed: ["claude:sonnet", "claude:haiku"] });
    expect(PACKS.status_report.access).toEqual(NO_ACCESS);
  });
});
