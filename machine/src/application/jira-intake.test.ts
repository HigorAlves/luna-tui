import type { IssueContext, JiraIntakeAnswer, TaskClassification } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type JiraPolicy } from "../domain/policy.ts";
import { freshTestDatabase } from "../test/database.ts";
import { fakeJira, issueOf } from "../test/jira.ts";
import type { JiraIssue } from "./jira.ts";
import { JiraIntake, briefComment, reposUnder } from "./jira-intake.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const policy: JiraPolicy = { project: "PLAT", intake: { jql: "project = PLAT AND labels = luna", everySecs: 300 }, on: {}, comments: "milestones", fields: {}, branch: "{type}/{key}" };

const verdicts: Record<string, JiraIntakeAnswer> = {
  "PLAT-1": { verdict: "ready", reason: "clear ask, the route is missing", title: "Add the login page", description: "Users sign in.\n\nAssumed: email + password only.", criteria: ["a wrong password shows an inline error", "/login renders"] },
  "PLAT-2": { verdict: "needs_brief", reason: "which search?", title: "Speed up search", questions: [{ question: "Which search: the global bar or the list filter?", recommended: "the global bar" }, { question: "How fast is fast enough?", recommended: null }] },
  "PLAT-3": { verdict: "not_for_agent", reason: "needs production credentials" },
};

const classified = (kind: string, confidence = 0.9): TaskClassification => ({ kind, area: "machine", ready: kind !== "question", size: 1, confidence, at: "2026-10-28T12:00:00.000Z", model: "typesafe-ai/jev" });

function wire(over: { triager?: boolean; comments?: JiraPolicy["comments"]; classify?: (issue: IssueContext) => TaskClassification | null | Promise<TaskClassification | null> } = {}) {
  const jira = fakeJira({
    issues: [
      { key: "PLAT-1", summary: "Login page", description: "Users sign in.\n\n- [ ] bad password errors", issueType: "Story" },
      { key: "PLAT-2", summary: "Make search faster", description: "", updated: "u2" },
      { key: "PLAT-3", summary: "Rotate the prod password", issueType: "Task" },
      { key: "PLAT-4", summary: "Already asked", comments: [{ author: "Luna", authorId: "A-ME", text: "Before an agent starts…", created: "" }] },
    ],
  });
  const triaged: string[] = [];
  const hints: Array<TaskClassification | null | undefined> = [];
  const triager = over.triager === false ? null : { triage: async (issue: JiraIssue, _repo: string | null, hint?: TaskClassification | null) => (triaged.push(issue.key), hints.push(hint), verdicts[issue.key] ?? null) };
  const read: IssueContext[] = [];
  const classify = over.classify;
  const classifier = classify ? { classify: async (issue: IssueContext) => (read.push(issue), classify(issue)) } : undefined;
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: "https://acme.atlassian.net" });
  let now = new Date("2026-10-28T12:00:00Z");
  const logs: string[] = [];
  const intake = new JiraIntake({
    pipeline,
    jira,
    policies: { for: async () => ({ ...DEFAULT_POLICY, jira: { ...policy, comments: over.comments ?? "milestones" } }) },
    repos: async () => ["/r/a", "/r/a"],
    triager,
    ...(classifier ? { classifier } : {}),
    now: () => now,
    log: (l) => logs.push(l),
  });
  return { jira, pipeline, intake, triaged, hints, read, logs, setNow: (d: Date) => (now = d) };
}

describe("JiraIntake with the ticket machine's scope", () => {
  it("with a scope configured, ignores what is not assigned to it: no read, no comment, no ticket", async () => {
    const jira = fakeJira({ issues: [{ key: "PLAT-1", summary: "mine", assignee: { id: "a1", name: "Ana" } }, { key: "PLAT-2", summary: "theirs", assignee: { id: "a2", name: "Carla" } }, { key: "PLAT-3", summary: "nobody's" }] });
    const triaged: string[] = [];
    const triager = { triage: async (issue: JiraIssue) => (triaged.push(issue.key), verdicts["PLAT-3"]!) };
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: "https://acme.atlassian.net" });
    const factory = { ...DEFAULT_POLICY.factory, tickets: { ...DEFAULT_POLICY.factory.tickets, assignees: ["ana"] } };
    const intake = new JiraIntake({ pipeline, jira, policies: { for: async () => ({ ...DEFAULT_POLICY, factory, jira: { ...policy } }) }, repos: async () => ["/r/a"], triager, now: () => new Date("2026-10-28T12:00:00Z"), log: () => {} });
    await intake.tick();
    expect(triaged).toEqual(["PLAT-1"]);
    expect(jira.comments["PLAT-2"]).toBeUndefined();
    expect(jira.comments["PLAT-3"]).toBeUndefined();
    expect(await pipeline.findByJiraKey("PLAT-2")).toBeNull();
  });
});

describe("JiraIntake with triage_signals", () => {
  it("reads each new issue first, declines a question Jev is sure of without jira_intake, saying why once with the classification", async () => {
    const { jira, pipeline, intake, triaged, read, logs } = wire({ classify: (issue) => classified(issue.title === "Rotate the prod password" ? "question" : "feature") });
    await intake.tick();
    expect(read.map((i) => i.source)).toEqual(["jira:PLAT-1", "jira:PLAT-2", "jira:PLAT-3"]);
    expect(read[0]).toEqual({ title: "Login page", description: "Users sign in.\n\n- [ ] bad password errors", labels: [], source: "jira:PLAT-1" });
    expect(triaged).toEqual(["PLAT-1", "PLAT-2"]);
    expect(jira.comments["PLAT-3"]).toEqual(["Not for an agent: it reads as a question, not a change (question · machine · not ready · size small · lowest confidence 0.90 (typesafe-ai/jev))."]);
    expect(logs).toContainEqual(expect.stringMatching(/PLAT-3 not for an agent: classified as a question/));
    // Answered once: an unchanged issue is neither classified nor commented on again.
    await intake.pollRepo("/r/a", "project = PLAT");
    expect(read).toHaveLength(3);
    expect(jira.comments["PLAT-3"]).toHaveLength(1);
    expect(await pipeline.list()).toHaveLength(1);
  });

  it("runs jira_intake as before on anything less, the classification passed as a hint and not kept on the ticket (triage reads its own)", async () => {
    const unsure = classified("question", 0.6);
    const { jira, pipeline, intake, triaged, hints } = wire({ classify: (issue) => (issue.source === "jira:PLAT-3" ? unsure : classified("feature")) });
    await intake.tick();
    expect(triaged).toEqual(["PLAT-1", "PLAT-2", "PLAT-3"]);
    expect(hints).toEqual([classified("feature"), classified("feature"), unsure]);
    expect(jira.comments["PLAT-3"]).toEqual(["Not for an agent: needs production credentials"]);
    const [task] = await pipeline.list();
    expect(task).toMatchObject({ title: "Add the login page", classification: null });
  });

  it("without a classification (no Jev credential, a failed run) behaves exactly as without the classifier", async () => {
    const plain = wire();
    const unclassified = wire({ classify: () => null });
    await plain.intake.tick();
    const before = { triaged: [...plain.triaged], comments: { ...plain.jira.comments }, tasks: (await plain.pipeline.list()).map(({ title, description, criteria, source }) => ({ title, description, criteria, source })) };
    await db.query("truncate tasks cascade");
    await unclassified.intake.tick();
    expect(unclassified.triaged).toEqual(before.triaged);
    expect(unclassified.hints).toEqual([null, null, null]);
    const after = await unclassified.pipeline.list();
    expect(after.map(({ title, description, criteria, source }) => ({ title, description, criteria, source }))).toEqual(before.tasks);
    expect(after[0]!.classification).toBeNull();
    expect(Object.keys(unclassified.jira.comments).sort()).toEqual(Object.keys(before.comments).sort());
  });
});

describe("JiraIntake", () => {
  it("runs each new issue through the pack: ready makes the ticket, needs_brief asks on the issue, not_for_agent declines once, the machine's own last word is left alone", async () => {
    const { jira, pipeline, intake, triaged } = wire();
    await intake.tick();
    expect(jira.searches).toEqual(["project = PLAT AND labels = luna"]);
    expect(triaged).toEqual(["PLAT-1", "PLAT-2", "PLAT-3"]);
    const tasks = await pipeline.list();
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      title: "Add the login page",
      description: "Users sign in.\n\nAssumed: email + password only.",
      criteria: ["a wrong password shows an inline error", "/login renders"],
      repoPath: "/r/a",
      source: { kind: "jira", key: "PLAT-1", url: "https://acme.atlassian.net/browse/PLAT-1", issueType: "Story" },
      state: "draft",
    });
    expect(task.jira).toMatchObject({ key: "PLAT-1", issueType: "Story" });
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toEqual(["task.created", "jira.intake"]);
    expect(jira.comments["PLAT-1"]).toEqual([`Picked up as task #${task.id.slice(0, 8)} on the Luna board. clear ask, the route is missing`]);
    expect(jira.comments["PLAT-2"]).toEqual([
      "Before an agent starts on this, a few things need settling:\n\n- Which search: the global bar or the list filter? (the agent would go with: the global bar)\n- How fast is fast enough?\n\nEdit the issue (or answer here) and it is picked up again.",
    ]);
    expect(jira.comments["PLAT-3"]).toEqual(["Not for an agent: needs production credentials"]);
    expect(jira.comments["PLAT-4"]).toBeUndefined();
  });

  it("polls a repo on its own schedule, never imports an issue twice, and re-reads an answered issue only when it changed", async () => {
    const { jira, pipeline, intake, triaged, setNow } = wire();
    await intake.tick();
    await intake.tick();
    expect(jira.searches).toHaveLength(1);
    setNow(new Date("2026-10-28T12:06:00Z"));
    await intake.tick();
    expect(jira.searches).toHaveLength(2);
    // PLAT-1 is behind a ticket, PLAT-2 and PLAT-3 were answered and did not change: nothing runs again.
    expect(triaged).toEqual(["PLAT-1", "PLAT-2", "PLAT-3"]);
    expect(await pipeline.list()).toHaveLength(1);
    jira.issues.get("PLAT-2")!.updated = "u3";
    setNow(new Date("2026-10-28T12:12:00Z"));
    await intake.tick();
    expect(triaged).toEqual(["PLAT-1", "PLAT-2", "PLAT-3", "PLAT-2"]);
  });

  it("reads an issue the machine spoke last on again once it was edited after that comment", async () => {
    const { jira, intake, triaged } = wire();
    const ours = (created: string) => ({ author: "Luna", authorId: "A-ME", text: "Before an agent starts…", created });
    // Edited two hours after the machine asked: someone answered in the description, not in a comment.
    jira.issues.set("PLAT-5", issueOf({ key: "PLAT-5", summary: "Answered by editing", updated: "2026-10-28T11:00:00.000+0000", comments: [ours("2026-10-28T09:00:00.000+0000")] }));
    // Updated a second after our comment: that is the comment itself landing, not an edit.
    jira.issues.set("PLAT-6", issueOf({ key: "PLAT-6", summary: "Nothing since", updated: "2026-10-28T09:00:01.000+0000", comments: [ours("2026-10-28T09:00:00.000+0000")] }));
    await intake.tick();
    expect(triaged).toEqual(["PLAT-1", "PLAT-2", "PLAT-3", "PLAT-5"]);
  });

  it("imports every issue as written when agents are off, taking the criteria from its checklist, and stays silent with comments: none", async () => {
    const { jira, pipeline, intake } = wire({ triager: false, comments: "none" });
    await intake.tick();
    const tasks = await pipeline.list();
    expect(tasks.map((t) => t.title).sort()).toEqual(["Already asked", "Login page", "Make search faster", "Rotate the prod password"].filter((t) => t !== "Already asked"));
    expect(tasks.find((t) => t.title === "Login page")).toMatchObject({ description: "Users sign in.\n\n- [ ] bad password errors", criteria: ["bad password errors"] });
    expect(jira.comments).toEqual({});
  });

  it("finds the checkouts under the repos dir that carry a luna.yaml, and words the brief without questions from the reason", async () => {
    const repos = await reposUnder("/Users/me/Developer/", { readdir: async () => ["a", "b", "c"], exists: (p) => p === "/Users/me/Developer/a/luna.yaml" || p === "/Users/me/Developer/c/luna.yaml" });
    expect(repos).toEqual(["/Users/me/Developer/a", "/Users/me/Developer/c"]);
    expect(await reposUnder("/nope", { readdir: async () => { throw new Error("ENOENT"); }, exists: () => true })).toEqual([]);
    expect(briefComment({ verdict: "needs_brief", reason: "the issue names a service this repo does not have" })).toContain("- the issue names a service this repo does not have");
  });
});
