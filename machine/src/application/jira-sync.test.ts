import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY, type JiraPolicy } from "../domain/policy.ts";
import { freshTestDatabase } from "../test/database.ts";
import { WORKFLOW, fakeJira } from "../test/jira.ts";
import { JiraSync } from "./jira-sync.ts";
import { Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stubs.reset();
});

const SITE = "https://acme.atlassian.net";
const jiraPolicy = (over: Partial<JiraPolicy> = {}): JiraPolicy => ({
  project: "PLAT",
  intake: null,
  on: { implementing: "In Progress", awaiting_ship: "In Review", closed: "Done", escalated: "Blocked" },
  comments: "milestones",
  fields: {},
  branch: "{type}/{key}",
  ...over,
});

/** A pipeline whose events feed the sync, over a fake Jira with one issue. */
function wire(policy: JiraPolicy | null = jiraPolicy(), issue: Partial<Parameters<typeof fakeJira>[0]> = {}) {
  const jira = fakeJira({ issues: [{ key: "PLAT-123", status: "To Do", statusCategory: "new", issueType: "Bug" }], transitions: WORKFLOW, ...issue });
  let sync: JiraSync;
  const pipeline = new Pipeline(db, stubs.runnerFor, {
    inline: true,
    hasConfig: () => true,
    jiraSite: SITE,
    policies: { for: async () => ({ ...DEFAULT_POLICY, jira: policy }) },
    onEvent: (event) => void sync.handle(event),
  });
  sync = new JiraSync({ pipeline, jira, enabled: true, boardUrl: "http://board.local", now: () => new Date("2026-10-28T12:00:00Z") });
  return { pipeline, jira, sync };
}

const kinds = async (pipeline: Pipeline, id: string) => (await pipeline.events(id)).filter((e) => e.kind.startsWith("jira.")).map((e) => [e.kind, e.payload]);

describe("JiraSync", () => {
  it("moves the issue through the declared statuses as the task walks the pipeline, and comments at the milestones", async () => {
    const { pipeline, jira, sync } = wire();
    const task = await pipeline.createTask({ title: "PLAT-123 Login page", repoPath: "/r/a", criteria: ["bad password shows an error"] });
    expect(task.jira).toMatchObject({ key: "PLAT-123", url: `${SITE}/browse/PLAT-123`, status: null });
    await pipeline.start(task.id);
    await sync.idle();
    expect(jira.comments["PLAT-123"]).toEqual([`Picked up as task #${task.id.slice(0, 8)} on the Luna board.`]);
    // No status is declared for triage or the plan gate: the issue stays put.
    expect(jira.issues.get("PLAT-123")!.status).toBe("To Do");

    stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/7", prNumber: 7 } });
    await pipeline.decide(task.id, "approved"); // plan → test_design → awaiting_test_check
    await pipeline.decide(task.id, "approved"); // → implementing → … → awaiting_ship
    await sync.idle();
    expect(jira.issues.get("PLAT-123")!.status).toBe("In Review");
    expect(jira.writes.filter((w) => w[0] === "transition").map((w) => w[2])).toEqual(["11", "21"]);
    expect(jira.comments["PLAT-123"]).toContain("PR opened: https://github.com/o/a/pull/7");

    await pipeline.decide(task.id, "approved"); // ship → reviewing_memory
    await pipeline.decide(task.id, "approved"); // → closed
    await sync.idle();
    expect(jira.issues.get("PLAT-123")!.status).toBe("Done");
    const closing = jira.comments["PLAT-123"]!.at(-1)!;
    expect(closing).toContain(`Closed on the Luna board as task #${task.id.slice(0, 8)}.`);
    expect(closing).toContain("PR: https://github.com/o/a/pull/7");
    expect(closing).toContain("Criteria:\n- bad password shows an error");
    const events = await kinds(pipeline, task.id);
    expect(events).toEqual([
      ["jira.transitioned", { from: "To Do", to: "In Progress" }],
      ["jira.commented", { url: "https://github.com/o/a/pull/7" }],
      ["jira.transitioned", { from: "In Progress", to: "In Review" }],
      ["jira.transitioned", { from: "In Review", to: "Done" }],
    ]);
    const after = await pipeline.get(task.id);
    expect(after.jira).toMatchObject({ key: "PLAT-123", status: "Done", blocked: null, syncedAt: "2026-10-28T12:00:00.000Z" });
    // Gates were not commented on: milestones only.
    expect(jira.comments["PLAT-123"]!.some((c) => c.startsWith("Needs you"))).toBe(false);
  });

  it("does nothing when the issue is already in the wanted status, and records jira.blocked when no transition leads there", async () => {
    const { pipeline, jira, sync } = wire(jiraPolicy({ on: { implementing: "In Progress", awaiting_ship: "Done" } }));
    jira.issues.get("PLAT-123")!.status = "In Progress";
    const task = await pipeline.createTask({ title: "Fix PLAT-123", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    // implementing wanted In Progress: already there, no write. awaiting_ship wanted Done: In Progress cannot reach Done.
    expect(jira.writes.filter((w) => w[0] === "transition")).toEqual([]);
    const events = await kinds(pipeline, task.id);
    expect(events).toEqual([["jira.blocked", { wanted: "Done", current: "In Progress", why: 'no transition to "Done" from "In Progress"' }]]);
    const after = await pipeline.get(task.id);
    expect(after.jira?.blocked).toEqual({ wanted: "Done", current: "In Progress", why: 'no transition to "Done" from "In Progress"', at: "2026-10-28T12:00:00.000Z" });
    expect(after.jira?.status).toBe("In Progress");
  });

  it("marks the link blocked with Jira's words when the transition is refused, and clears it when the next one succeeds", async () => {
    const { pipeline, jira, sync } = wire(jiraPolicy({ on: { implementing: "In Progress", closed: "Done" } }));
    const refuse = async () => {
      throw new Error("POST issue/PLAT-123/transitions: resolution: Field 'resolution' is required");
    };
    const perform = jira.transition;
    jira.transition = refuse;
    const task = await pipeline.createTask({ title: "PLAT-123", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved"); // implementing: the move is refused; the task goes on to awaiting_ship
    await sync.idle();
    const mid = await pipeline.get(task.id);
    expect(mid.state).toBe("awaiting_ship");
    expect(mid.jira?.blocked).toEqual({ wanted: "In Progress", current: "To Do", why: "POST issue/PLAT-123/transitions: resolution: Field 'resolution' is required", at: "2026-10-28T12:00:00.000Z" });
    // Someone fixed the workflow and moved the issue along in Jira: the next declared move succeeds and the mark goes.
    jira.transition = perform;
    jira.issues.get("PLAT-123")!.status = "In Review";
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    expect((await pipeline.get(task.id)).jira).toMatchObject({ status: "Done", blocked: null });
    expect((await kinds(pipeline, task.id)).map((e) => e[0])).toEqual(["jira.blocked", "jira.transitioned"]);
  });

  it("renders the declared fields ({pr_url}, {task_id}, {branch}, {board_url}) into the transition", async () => {
    const { pipeline, jira, sync } = wire(jiraPolicy({ on: { awaiting_ship: "In Review" }, fields: { awaiting_ship: { customfield_10045: "{pr_url}", customfield_10046: "task {task_id} on {branch} via {board_url}" } } }));
    jira.issues.get("PLAT-123")!.status = "In Progress";
    stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/9" } });
    const task = await pipeline.createTask({ title: "PLAT-123 x", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    const write = jira.writes.find((w) => w[0] === "transition")!;
    expect(write[3]).toEqual({ customfield_10045: "https://github.com/o/a/pull/9", customfield_10046: `task ${task.id} on  via http://board.local` });
    expect(await kinds(pipeline, task.id)).toEqual([
      ["jira.commented", { url: "https://github.com/o/a/pull/9" }],
      ["jira.transitioned", { from: "In Progress", to: "In Review", fields: ["customfield_10045", "customfield_10046"] }],
    ]);
  });

  it("comments every gate with `gates`, nothing with `none`, and ignores tasks with no link or repos with no jira block", async () => {
    const gates = wire(jiraPolicy({ comments: "gates", on: {} }));
    const t1 = await gates.pipeline.createTask({ title: "PLAT-123 a", repoPath: "/r/a" });
    await gates.pipeline.start(t1.id);
    await gates.sync.idle();
    expect(gates.jira.comments["PLAT-123"]).toEqual([`Picked up as task #${t1.id.slice(0, 8)} on the Luna board.`, "Needs you: approve the plan."]);

    const none = wire(jiraPolicy({ comments: "none" }));
    const t2 = await none.pipeline.createTask({ title: "PLAT-123 b", repoPath: "/r/a" });
    await none.pipeline.start(t2.id);
    await none.pipeline.decide(t2.id, "approved");
    await none.pipeline.decide(t2.id, "approved");
    await none.sync.idle();
    expect(none.jira.comments["PLAT-123"]).toBeUndefined();
    expect(none.jira.issues.get("PLAT-123")!.status).toBe("In Review");

    const unlinked = wire();
    const t3 = await unlinked.pipeline.createTask({ title: "no key here", repoPath: "/r/a" });
    await unlinked.pipeline.start(t3.id);
    await unlinked.sync.idle();
    expect(unlinked.jira.writes).toEqual([]);

    const noBlock = wire(null);
    const t4 = await noBlock.pipeline.createTask({ title: "PLAT-123 c", repoPath: "/r/a" });
    await noBlock.pipeline.start(t4.id);
    await noBlock.sync.idle();
    expect(noBlock.jira.writes).toEqual([]);
  });

  it("round-trips Blocked: escalated moves the issue to the declared status and resuming moves it back to the stage's", async () => {
    const { pipeline, jira, sync } = wire();
    stubs.plan("implementing", { outcome: "escalated", reason: "stuck on a flaky test" } as never);
    const task = await pipeline.createTask({ title: "PLAT-123", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    expect((await pipeline.get(task.id)).state).toBe("escalated");
    expect(jira.issues.get("PLAT-123")!.status).toBe("Blocked");
    await pipeline.decide(task.id, "approved"); // resume into implementing
    await sync.idle();
    const statuses = jira.writes.filter((w) => w[0] === "transition").map((w) => w[2]);
    expect(statuses).toEqual(["11", "22", "31", "21"]);
    expect((await kinds(pipeline, task.id)).map((e) => (e[1] as { to: string }).to)).toEqual(["In Progress", "Blocked", "In Progress", "In Review"]);
  });

  it("serializes reactions per task, so two quick transitions land in order and the later status wins", async () => {
    const { pipeline, jira, sync } = wire(jiraPolicy({ on: { implementing: "In Progress", awaiting_ship: "In Review" } }));
    // A slow Jira: every reaction in flight at once would read the transitions from "To Do" and the later one would find no way to In Review.
    const read = jira.transitions.bind(jira);
    jira.transitions = async (key) => {
      const found = await read(key);
      await new Promise((r) => setTimeout(r, 50));
      return found;
    };
    const task = await pipeline.createTask({ title: "PLAT-123", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    expect(jira.issues.get("PLAT-123")!.status).toBe("In Review");
    expect(jira.writes.filter((w) => w[0] === "transition").map((w) => w[2])).toEqual(["11", "21"]);
    expect((await kinds(pipeline, task.id)).map((e) => e[0])).toEqual(["jira.transitioned", "jira.transitioned"]);
  });

  it("skips a stepping stone when the task has already moved on and the later status is reachable directly", async () => {
    const direct = { ...WORKFLOW, "To Do": [...WORKFLOW["To Do"]!, { id: "12", name: "Review now", to: { name: "In Review", categoryKey: "indeterminate" } }] };
    const { pipeline, jira, sync } = wire(jiraPolicy({ on: { implementing: "In Progress", awaiting_ship: "In Review" } }), { transitions: direct });
    const read = jira.transitions.bind(jira);
    jira.transitions = async (key) => {
      const found = await read(key);
      await new Promise((r) => setTimeout(r, 50));
      return found;
    };
    const task = await pipeline.createTask({ title: "PLAT-123", repoPath: "/r/a" });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    expect(jira.issues.get("PLAT-123")!.status).toBe("In Review");
    expect(jira.writes.filter((w) => w[0] === "transition").map((w) => w[2])).toEqual(["12"]);
  });

  it("comments PR opened once per url, remembered as a jira.commented event, and leaves Picked up to intake for an imported issue", async () => {
    const { pipeline, jira, sync } = wire();
    stubs.plan("delivering", { outcome: "pass", detail: { prUrl: "https://github.com/o/a/pull/7", prNumber: 7 } });
    const task = await pipeline.createTask({ title: "Login", repoPath: "/r/a", source: { kind: "jira", key: "PLAT-123", url: `${SITE}/browse/PLAT-123`, issueType: "Bug" } });
    await pipeline.start(task.id);
    await pipeline.decide(task.id, "approved");
    await pipeline.decide(task.id, "approved");
    await sync.idle();
    expect(jira.comments["PLAT-123"]).toEqual(["PR opened: https://github.com/o/a/pull/7"]);
    const events = await pipeline.events(task.id);
    expect(events.filter((e) => e.kind === "jira.commented").map((e) => e.payload)).toEqual([{ url: "https://github.com/o/a/pull/7" }]);
    // A fresh sync (a restart) sees the same finish again: the record, not memory, stops the repeat.
    const again = new JiraSync({ pipeline, jira, enabled: true });
    await again.handle(events.find((e) => e.kind === "stage.finished" && (e.payload.detail as { prUrl?: string })?.prUrl)!);
    expect(jira.comments["PLAT-123"]).toEqual(["PR opened: https://github.com/o/a/pull/7"]);
  });

  it("links a ticket whose text names a key only when Jira is configured, and an intake import always", async () => {
    const quiet = new Pipeline(db, stubs.runnerFor, { inline: true });
    expect((await quiet.createTask({ title: "PLAT-123 nothing" })).jira).toBeNull();
    const imported = await quiet.createTask({ title: "x", source: { kind: "jira", key: "PLAT-7", url: `${SITE}/browse/PLAT-7`, issueType: "Bug" } });
    expect(imported.jira).toMatchObject({ key: "PLAT-7", issueType: "Bug", status: null });
    expect(await quiet.findByJiraKey("PLAT-7")).toMatchObject({ id: imported.id });
    const { pipeline } = wire();
    expect((await pipeline.createTask({ title: "x", description: "see plat-1 and PLAT-42 and PLAT-43" })).jira?.key).toBe("PLAT-42");
    expect(await pipeline.findByJiraKey("PLAT-42")).not.toBeNull();
    expect(await pipeline.findByJiraKey("PLAT-999")).toBeNull();
  });
});
