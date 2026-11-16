import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QuestionnaireContext } from "@hardness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeJira } from "../test/jira.ts";
import type { SlackItemRow } from "../domain/slack-item.ts";
import { ComplianceDrafts, DraftStatusError } from "./compliance-drafts.ts";
import { Questionnaires, pickRepo } from "./questionnaires.ts";
import type { Wiki, WikiPage } from "./wiki.ts";

let stateDir: string;
beforeEach(() => void (stateDir = mkdtempSync(join(tmpdir(), "questionnaires-"))));

const POLICY: WikiPage = { path: "Compliance/Policies/Encryption.md", text: "Data at rest is encrypted with AES-256." };
const CONTROL: WikiPage = { path: "Compliance/Controls/Access.md", text: "MFA is required for every admin." };
const BANK: WikiPage = { path: "Compliance/Answers/do-you-encrypt-5a02c3.md", text: "# Do you encrypt?\n\nYes." };

const answer = {
  answers: [
    { n: 1, question: "Do you encrypt data at rest?", answer: "Yes, with AES-256.", citations: [POLICY.path, "Compliance/Policies/Invented.md"], fromBank: null, confidence: "high" },
    { n: 2, question: "Is MFA on?", answer: "Yes.", citations: [CONTROL.path], fromBank: "Compliance/Answers/not-in-the-bank.md", confidence: "medium" },
  ],
  unanswered: [{ n: 3, question: "Do you hold ISO 27001?", why: "No page names it." }],
};

function setup(over: { repos?: string[]; defaultRepo?: string | null; pages?: Record<string, WikiPage[]>; run?: (c: QuestionnaireContext) => Promise<unknown>; fileText?: string; bankChars?: number } = {}) {
  const pages = over.pages ?? { "acme/api": [POLICY, CONTROL, BANK], "acme/web": [CONTROL] };
  const readPages = vi.fn<Wiki["readPages"]>(async (slug, prefix) => (pages[slug] ?? []).filter((p) => p.path.startsWith(prefix)));
  const run = vi.fn(over.run ?? (async () => answer));
  const downloadFile = vi.fn(async (id: string) => ({ name: id === "F1" ? "acme.csv" : "x.md", mimetype: "text/csv", text: over.fileText ?? "1,Do you encrypt data at rest?\n2,Is MFA on?\n3,Do you hold ISO 27001?" }));
  const logs: string[] = [];
  const drafts = new ComplianceDrafts({ stateDir });
  const jira = fakeJira({ issues: [{ key: "SEC-42" }, { key: "SEC-43" }], attachments: { "SEC-42": [{ id: "9001", name: "q.md", mimetype: "text/markdown", text: "1. Do you encrypt data at rest?" }, { id: "9002", name: "x.png", mimetype: "image/png", text: "" }], "SEC-43": [{ id: "9003", name: "x.png", mimetype: "image/png", text: "" }] } });
  const job = new Questionnaires({ slack: { downloadFile }, jira, wiki: { readPages }, drafts, run, repos: async () => over.repos ?? ["acme/api", "acme/web"], defaultRepo: over.defaultRepo === undefined ? null : over.defaultRepo, stateDir, ...(over.bankChars ? { bankChars: over.bankChars } : {}), log: (l) => void logs.push(l) });
  return { job, drafts, readPages, run, downloadFile, logs, jira };
}

const row = (over: { id?: string; text?: string; category?: string; files?: Array<{ id: string; name: string; kind: string }> } = {}): SlackItemRow =>
  ({
    id: over.id ?? "C0123ABCD:1731772800.000100",
    slackTs: "1731772800.000100",
    channel: { id: "C0123ABCD", name: "sales", kind: "channel" },
    author: { id: "U1", name: "dana", isBot: false },
    text: over.text ?? "Acme sent a security questionnaire for acme/api, can you fill it in?",
    triage: { category: over.category ?? "compliance_request" },
    conversation: { history: [{ id: "C0123ABCD:1731772800.000100", text: "x", attachments: over.files ?? [{ id: "F1", name: "acme.csv", kind: "csv" }] }] },
  }) as unknown as SlackItemRow;

describe("Questionnaires.fromSlack", () => {
  it("downloads the file, reads the repo's pages, runs the pack and opens one draft with the thread and the bank as targets", async () => {
    const { job, run, readPages } = setup();
    const draft = await job.fromSlack(row());
    expect(readPages).toHaveBeenCalledWith("acme/api", "Compliance/Policies/");
    expect(readPages).toHaveBeenCalledWith("acme/api", "Compliance/Controls/");
    expect(readPages).toHaveBeenCalledWith("acme/api", "Compliance/Answers/");
    const context = run.mock.calls[0]![0];
    expect(context).toMatchObject({ repo: "acme/api", source: "slack", requester: "dana", questionnaire: { name: "acme.csv" } });
    expect(context.questionnaire.markdown).toContain("Do you hold ISO 27001?");
    expect(context.policies.map((p) => p.path)).toEqual([POLICY.path, CONTROL.path]);
    expect(context.bank.map((p) => p.path)).toEqual([BANK.path]);
    expect(draft).toMatchObject({
      id: "questionnaire:slack:C0123ABCD:1731772800.000100",
      kind: "questionnaire",
      repo: "acme/api",
      title: "Questionnaire: acme.csv",
      period: null,
      summary: "2 answered, 1 unanswered",
      status: "waiting",
      targets: [{ kind: "slack_thread", channel: "C0123ABCD", ts: "1731772800.000100" }, { kind: "answer_bank", repo: "acme/api" }],
    });
    expect(draft!.text).toContain("## 1. Do you encrypt data at rest?");
  });

  it("keeps only citations and a bank page that are in the context", async () => {
    const { job } = setup();
    const draft = await job.fromSlack(row());
    expect(draft!.text).toContain("_Sources: Compliance/Policies/Encryption.md_");
    expect(draft!.text).not.toContain("Invented");
    expect(draft!.text).not.toContain("not-in-the-bank");
  });

  it("makes one draft per thread: a second pass runs nothing", async () => {
    const { job, run, downloadFile } = setup();
    await job.fromSlack(row());
    expect(await job.fromSlack(row())).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  it("ignores an item that is not a compliance request", async () => {
    const { job, run } = setup();
    expect(await job.fromSlack(row({ category: "request" }))).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("answers inline questions when the text has at least two and no file", async () => {
    const { job, run } = setup();
    const inline = row({ files: [], text: "For acme/api: 1. Do you encrypt data? 2. Is MFA on?" });
    expect(await job.fromSlack(inline)).not.toBeNull();
    expect(run.mock.calls[0]![0].questionnaire).toMatchObject({ name: "Slack thread" });
    const one = setup();
    expect(await one.job.fromSlack(row({ files: [], text: "Do you encrypt data? acme/api" }))).toBeNull();
    expect(one.run).not.toHaveBeenCalled();
  });

  it("takes the repo named in the text, by slug or by name, else the default and says so", async () => {
    const byName = setup({ defaultRepo: "acme/web" });
    await byName.job.fromSlack(row({ id: "C0123ABCD:1.1", text: "the api questionnaire from Acme" }));
    expect(byName.run.mock.calls[0]![0].repo).toBe("acme/api");
    const fallback = setup({ defaultRepo: "acme/web" });
    const draft = await fallback.job.fromSlack(row({ id: "C0123ABCD:1.2", text: "questionnaire from Acme" }));
    expect(fallback.run.mock.calls[0]![0].repo).toBe("acme/web");
    expect(draft!.summary).toBe("2 answered, 1 unanswered; answered from the home wiki: acme/web");
  });

  it("opens a draft that asks for a repository when none is named and there is no default; the board's pick then answers it", async () => {
    const { job, run, drafts } = setup();
    const draft = await job.fromSlack(row({ id: "C0123ABCD:1.3", text: "questionnaire from Acme" }));
    expect(run).not.toHaveBeenCalled();
    expect(draft).toMatchObject({ id: "questionnaire:slack:C0123ABCD:1.3", kind: "questionnaire", status: "waiting", summary: "pick a repository", targets: [{ kind: "slack_thread", channel: "C0123ABCD", ts: "1.3" }] });
    expect(draft!.text).toContain("needs a repository");
    expect(draft!.text).toContain("acme.csv");
    expect(await job.fromSlack(row({ id: "C0123ABCD:1.3", text: "questionnaire from Acme" }))).toBeNull();
    const answered = await job.rerun(draft!.id, "acme/api");
    expect(answered).toMatchObject({ repo: "acme/api", summary: "2 answered, 1 unanswered", targets: [{ kind: "slack_thread" }, { kind: "answer_bank", repo: "acme/api" }] });
    expect((await drafts.get(draft!.id))!.repo).toBe("acme/api");
  });

  it("opens the same kind of draft for a Jira issue with no repository, and never throws when the pack fails", async () => {
    const { job, jira } = setup();
    const draft = await job.fromJira(await jira.issue("SEC-42"));
    expect(draft).toMatchObject({ id: "questionnaire:jira:SEC-42", summary: "pick a repository", targets: [{ kind: "jira_comment", key: "SEC-42" }] });
    const failing = setup({ run: async () => Promise.reject(new Error("no credential")) });
    expect(await failing.job.fromSlack(row())).toBeNull();
    expect(failing.logs.join("\n")).toContain("no credential");
  });

  it("asks for another repository when the chosen wiki has no policy page", async () => {
    const empty = setup({ pages: { "acme/api": [] } });
    const draft = await empty.job.fromSlack(row());
    expect(empty.run).not.toHaveBeenCalled();
    expect(draft).toMatchObject({ repo: "acme/api", summary: "pick a repository", targets: [{ kind: "slack_thread" }] });
    expect(draft!.text).toContain("no policy or control pages");
    expect(draft!.text).toContain("acme/api");
  });

  it("sends the bank pages that share words with the questionnaire first, within a character budget", async () => {
    const filler = Array.from({ length: 30 }, (_, i): WikiPage => ({ path: `Compliance/Answers/filler-${i}.md`, text: `# Unrelated ${i}\n\n${"lorem ".repeat(30)}` }));
    const match: WikiPage = { path: "Compliance/Answers/encrypt-zzz.md", text: "# Do you encrypt data at rest?\n\nYes." };
    const { job, run } = setup({ pages: { "acme/api": [POLICY, ...filler, match] }, bankChars: 600 });
    await job.fromSlack(row());
    const paths = run.mock.calls[0]![0].bank.map((p) => p.path);
    expect(paths[0]).toBe(match.path);
    expect(paths.reduce((n, path) => n + [...filler, match].find((p) => p.path === path)!.text.length, 0)).toBeLessThanOrEqual(600);
  });
});

describe("pickRepo", () => {
  const known = ["acme/api", "acme/api-gateway", "acme/security"];

  it("prefers the longest match and respects word boundaries", () => {
    expect(pickRepo("for acme/api-gateway please", known)).toBe("acme/api-gateway");
    expect(pickRepo("use acme/api.", known)).toBe("acme/api");
    expect(pickRepo("the api-gateway repo", known)).toBe("acme/api-gateway");
    expect(pickRepo("the gateway questionnaire", known)).toBeNull();
    expect(pickRepo("see other/acme/api2", known)).toBeNull();
  });

  it("is ambiguous, so null, when two owners share the name named", () => {
    expect(pickRepo("the api repo", ["a/api", "b/api"])).toBeNull();
    expect(pickRepo("b/api", ["a/api", "b/api"])).toBe("b/api");
  });
});

describe("Questionnaires: the text that names the repository", () => {
  it("is the message and the file name, never the file's body", async () => {
    const { job, run } = setup({ defaultRepo: "acme/web", repos: ["acme/api", "acme/web", "acme/security"], fileText: "1,Does the api use TLS?\n2,Is there a security team?" });
    await job.fromSlack(row({ id: "C0123ABCD:2.1", text: "questionnaire from Acme", files: [{ id: "F1", name: "acme.csv", kind: "csv" }] }));
    expect(run.mock.calls[0]![0].repo).toBe("acme/web");
  });
});

describe("Questionnaires.fromJira", () => {
  it("answers the issue's text attachment and targets a comment on the issue", async () => {
    const { job, run, jira } = setup({ defaultRepo: "acme/api" });
    const issue = await jira.issue("SEC-42");
    const draft = await job.fromJira(issue);
    expect(run.mock.calls[0]![0]).toMatchObject({ repo: "acme/api", source: "jira", requester: null, questionnaire: { name: "q.md", markdown: "1. Do you encrypt data at rest?" } });
    expect(draft).toMatchObject({ id: "questionnaire:jira:SEC-42", targets: [{ kind: "jira_comment", key: "SEC-42" }, { kind: "answer_bank", repo: "acme/api" }] });
    // Asked again (a restart re-reads the issue): the draft that stands is returned, not rebuilt.
    expect(await job.fromJira(issue)).toMatchObject({ id: "questionnaire:jira:SEC-42" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an issue with no text attachment", async () => {
    const { job, run, jira } = setup({ defaultRepo: "acme/api" });
    expect(await job.fromJira(await jira.issue("SEC-43"))).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Questionnaires.rerun", () => {
  it("answers the same questionnaire from another repo's pages and reopens the draft there", async () => {
    const { job, run, drafts } = setup();
    const first = await job.fromSlack(row());
    const again = await job.rerun(first!.id, "acme/web");
    expect(run.mock.calls[1]![0]).toMatchObject({ repo: "acme/web", policies: [{ path: CONTROL.path }] });
    expect(again).toMatchObject({ id: first!.id, repo: "acme/web", status: "waiting", targets: [{ kind: "slack_thread" }, { kind: "answer_bank", repo: "acme/web" }] });
    expect((await drafts.get(first!.id))!.repo).toBe("acme/web");
  });

  it("refuses a draft that is posting or posted", async () => {
    const { job, drafts } = setup();
    const first = await job.fromSlack(row());
    await drafts.claim(first!.id, first!.hash);
    await expect(job.rerun(first!.id, "acme/web")).rejects.toBeInstanceOf(DraftStatusError);
  });
});
