import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComplianceDraft } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeJira } from "../test/jira.ts";
import { fakeSlack } from "../test/slack.ts";
import { questionnaireWriters } from "./compliance-writers.ts";
import { SlackSender, tapOf } from "./slack-send.ts";
import type { Wiki } from "./wiki.ts";

const text = [
  "# acme.csv: answers",
  "",
  "## 1. Do you encrypt data at rest?",
  "",
  "Yes, with AES-256.",
  "",
  "_Sources: Compliance/Policies/Encryption.md_",
  "",
  "## 2. Is MFA on?",
  "",
  "Yes.",
  "",
  "_Sources: Compliance/Controls/Access.md, Compliance/Answers/is-mfa-on-abcdef.md · from the answer bank_",
  "",
  "## Unanswered",
  "",
  "- 3. ISO 27001? No page.",
  "",
].join("\n");

const draft = (over: Partial<ComplianceDraft> = {}): ComplianceDraft =>
  ({ id: "questionnaire:slack:C1:1.0", kind: "questionnaire", repo: "acme/api", title: "Questionnaire: acme.csv", period: null, summary: "2 answered, 1 unanswered", text, status: "posting", hash: "h", targets: [], ...over }) as ComplianceDraft;

let stateDir: string;
beforeEach(() => void (stateDir = mkdtempSync(join(tmpdir(), "compliance-writers-"))));

function world(over: { limit?: number } = {}) {
  const writePages = vi.fn<Wiki["writePages"]>(async () => ({ sha: "abc" }));
  const wiki: Wiki = { readPages: async () => [], writePages };
  const slack = fakeSlack({ postMessage: async () => "9.1" });
  const jira = fakeJira({ issues: [{ key: "SEC-42" }] });
  const writers = questionnaireWriters({ wiki, sender: new SlackSender(slack), jira, stateDir, now: () => new Date("2026-11-16T12:00:00Z"), ...(over.limit ? { slackLimit: over.limit, jiraLimit: over.limit } : {}) });
  return { writers, writePages, slack, jira };
}
const tap = tapOf("POST /compliance/drafts/:id/approve");

describe("answer_bank writer", () => {
  it("writes one bank page per answer in one commit, reusing the bank page the sources name", async () => {
    const { writers, writePages } = world();
    await writers.answer_bank!(draft(), { kind: "answer_bank", repo: "acme/api" }, tap);
    expect(writePages).toHaveBeenCalledTimes(1);
    const [repo, pages, message] = writePages.mock.calls[0]!;
    expect(repo).toBe("acme/api");
    expect(message).toBe("Questionnaire answers Questionnaire: acme.csv");
    expect(pages.map((p) => p.path)).toEqual(["Compliance/Answers/do-you-encrypt-data-at-rest-5a02c3.md", "Compliance/Answers/is-mfa-on-abcdef.md"]);
    expect(pages[0]!.text).toContain("Yes, with AES-256.");
    expect(pages[0]!.text).toContain("- Approved: 2026-11-16");
    expect(pages[1]!.text).toContain("- Sources: Compliance/Controls/Access.md");
  });

  it("writes what the person edited, not what the model answered", async () => {
    const { writers, writePages } = world();
    await writers.answer_bank!(draft({ text: text.replace("Yes, with AES-256.", "Yes: AES-256 and TLS 1.3.") }), { kind: "answer_bank", repo: "acme/api" }, tap);
    expect(writePages.mock.calls[0]![1][0]!.text).toContain("Yes: AES-256 and TLS 1.3.");
  });

  it("writes nothing when the approved text holds no answer", async () => {
    const { writers, writePages } = world();
    await writers.answer_bank!(draft({ text: "# acme.csv: answers\n" }), { kind: "answer_bank", repo: "acme/api" }, tap);
    expect(writePages).not.toHaveBeenCalled();
  });
});

describe("slack_thread writer", () => {
  const target = { kind: "slack_thread" as const, channel: "C1", ts: "1.0" };

  it("posts the approved text in the thread", async () => {
    const { writers, slack } = world();
    await writers.slack_thread!(draft(), target, tap);
    expect(slack.calls).toEqual([["postMessage", "C1", text.trim(), "1.0"]]);
  });

  it("posts a long text as ordered chunks under the limit, all in the thread", async () => {
    const { writers, slack } = world({ limit: 120 });
    await writers.slack_thread!(draft(), target, tap);
    const posted = slack.calls.map((c) => c[2] as string);
    expect(posted.length).toBeGreaterThan(1);
    for (const chunk of posted) expect(chunk.length).toBeLessThanOrEqual(120);
    expect(slack.calls.every((c) => c[1] === "C1" && c[3] === "1.0")).toBe(true);
    expect(posted.join("\n\n").replace(/\s+/g, " ")).toBe(text.trim().replace(/\s+/g, " "));
  });

  it("is safe to repeat: a second approve posts nothing, and a retry after a failure posts only what is left", async () => {
    const { writers, slack } = world({ limit: 120 });
    await writers.slack_thread!(draft(), target, tap);
    const first = slack.calls.length;
    await writers.slack_thread!(draft(), target, tap);
    expect(slack.calls).toHaveLength(first);

    const other = world({ limit: 120 });
    let n = 0;
    other.slack.postMessage.mockImplementation(async () => {
      if (++n === 2) throw new Error("ratelimited");
      return "9.1";
    });
    const d = draft({ id: "questionnaire:slack:C1:2.0" });
    await expect(other.writers.slack_thread!(d, target, tap)).rejects.toThrow("ratelimited");
    await other.writers.slack_thread!(d, target, tap);
    expect(other.slack.postMessage).toHaveBeenCalledTimes(first + 1);
  });

  it("posts again when the person's text changed", async () => {
    const { writers, slack } = world();
    await writers.slack_thread!(draft(), target, tap);
    await writers.slack_thread!(draft({ text: text.replace("Yes.", "Yes, always.") }), target, tap);
    expect(slack.calls).toHaveLength(2);
  });

  it("refuses without a person's tap", async () => {
    const { writers, slack } = world();
    await expect(writers.slack_thread!(draft(), target, null)).rejects.toThrow("needs a person's tap");
    expect(slack.calls).toEqual([]);
  });
});

describe("jira_comment writer", () => {
  const target = { kind: "jira_comment" as const, key: "SEC-42" };

  it("comments on the issue with the approved text, once", async () => {
    const { writers, jira } = world();
    await writers.jira_comment!(draft({ id: "questionnaire:jira:SEC-42" }), target, tap);
    await writers.jira_comment!(draft({ id: "questionnaire:jira:SEC-42" }), target, tap);
    expect(jira.comments["SEC-42"]).toEqual([text.trim()]);
  });

  it("splits a comment over the limit into ordered comments", async () => {
    const { writers, jira } = world({ limit: 120 });
    await writers.jira_comment!(draft({ id: "questionnaire:jira:SEC-42" }), target, tap);
    expect(jira.comments["SEC-42"]!.length).toBeGreaterThan(1);
    for (const c of jira.comments["SEC-42"]!) expect(c.length).toBeLessThanOrEqual(120);
  });
});
