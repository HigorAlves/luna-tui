import type { JiraIntakeAnswer } from "@hardness/contracts";
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

function wire(over: { triager?: boolean; comments?: JiraPolicy["comments"] } = {}) {
  const jira = fakeJira({
    issues: [
      { key: "PLAT-1", summary: "Login page", description: "Users sign in.\n\n- [ ] bad password errors", issueType: "Story" },
      { key: "PLAT-2", summary: "Make search faster", description: "", updated: "u2" },
      { key: "PLAT-3", summary: "Rotate the prod password", issueType: "Task" },
      { key: "PLAT-4", summary: "Already asked", comments: [{ author: "Luna", authorId: "A-ME", text: "Before an agent starts…", created: "" }] },
    ],
  });
  const triaged: string[] = [];
  const triager = over.triager === false ? null : { triage: async (issue: JiraIssue) => (triaged.push(issue.key), verdicts[issue.key] ?? null) };
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: "https://acme.atlassian.net" });
  let now = new Date("2026-10-28T12:00:00Z");
  const logs: string[] = [];
  const intake = new JiraIntake({
    pipeline,
    jira,
    policies: { for: async () => ({ ...DEFAULT_POLICY, jira: { ...policy, comments: over.comments ?? "milestones" } }) },
    repos: async () => ["/r/a", "/r/a"],
    triager,
    now: () => now,
    log: (l) => logs.push(l),
  });
  return { jira, pipeline, intake, triaged, logs, setNow: (d: Date) => (now = d) };
}

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
