import { describe, expect, it } from "vitest";

import { ChangeExceptionKind, ChangeExceptionsAnswer, ChangeExceptionsContext, NO_ACCESS, PACKS, ComplianceActInput, ComplianceDraft, ComplianceDraftKind, ComplianceDraftsResponse, ComplianceEditInput, ComplianceTarget } from "./index.ts";

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
});

