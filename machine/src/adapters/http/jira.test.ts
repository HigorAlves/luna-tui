import type { Task, TaskSla } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_POLICY } from "../../domain/policy.ts";
import { noTokenJira } from "../../application/jira.ts";
import { JiraTasks } from "../../application/jira-tasks.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { type FakeJira, SITE, fakeJira } from "../../test/jira.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;
let jira: FakeJira;
let bus: Bus;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: SITE, policies: { for: async () => ({ ...DEFAULT_POLICY, jira: { project: "PLAT", intake: null, on: {}, comments: "milestones", fields: {}, branch: "{type}/{key}" } }) } });
  jira = fakeJira({ issues: [{ key: "PLAT-123", summary: "Login page", status: "In Progress", issueType: "Bug", priority: "High", dueAt: "2026-10-31" }, { key: "PLAT-7", summary: "Login button colour", status: "To Do" }] });
  bus = new Bus();
});

const NOW = new Date("2026-10-28T12:00:00Z");
const sla: TaskSla = { gate: null, stage: null, cycle: { dueAt: "2026-10-31T12:00:00.000Z", overdue: false, targetSecs: 259_200 }, jiraDue: null };
const app = (over: { jira?: boolean; token?: boolean } = {}) =>
  createApp({
    db,
    pipeline,
    bus,
    ...(over.jira === false ? {} : { jira: new JiraTasks({ jira: over.token === false ? noTokenJira() : jira, site: over.token === false ? SITE : SITE, pipeline, now: () => NOW }) }),
    sla: async () => sla,
  });
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const post = (path: string, body?: unknown) => app().request(path, { method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("the Jira routes", () => {
  it("reports status and answers a search: a key is that issue, text is your issues first then everyone's", async () => {
    expect(await json(await app().request("/jira/status"))).toEqual({ configured: true, site: SITE, tokenExpiresAt: null, error: null });
    expect(await json(await app().request("/jira/search?q=plat-123"))).toEqual([{ key: "PLAT-123", summary: "Login page", status: "In Progress", issueType: "Bug", url: `${SITE}/browse/PLAT-123` }]);
    expect(await (await app().request("/jira/search?q=PLAT-999")).json()).toEqual([]);
    jira.searchHits = ["PLAT-7"];
    const hits = (await (await app().request("/jira/search?q=login")).json()) as Array<{ key: string }>;
    expect(hits.map((h) => h.key)).toEqual(["PLAT-7", "PLAT-123"]);
    expect(jira.searches).toEqual(['text ~ "login" AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 'text ~ "login" ORDER BY updated DESC']);
    expect(await (await app().request("/jira/search?q=")).json()).toEqual([]);
  });

  it("links a ticket to an issue Jira has (and publishes the task), refuses one it has not, and unlinks", async () => {
    const task = await pipeline.createTask({ title: "Login page" });
    const seen: Task[] = [];
    bus.subscribe((m) => m.type === "task.updated" && seen.push(m.task));
    const linked = (await json(await post(`/tasks/${task.id}/jira`, { key: "PLAT-123" }))) as unknown as Task;
    expect(linked.jira).toEqual({ key: "PLAT-123", url: `${SITE}/browse/PLAT-123`, issueType: "Bug", status: "In Progress", priority: "High", dueAt: "2026-10-31", syncedAt: NOW.toISOString(), blocked: null });
    expect(linked.sla).toEqual(sla);
    expect(seen).toHaveLength(1);
    expect((await pipeline.events(task.id)).map((e) => [e.kind, e.payload])).toContainEqual(["jira.linked", { key: "PLAT-123", url: `${SITE}/browse/PLAT-123` }]);

    const missing = await post(`/tasks/${task.id}/jira`, { key: "PLAT-999" });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: "no_issue" });
    const bad = await post(`/tasks/${task.id}/jira`, { key: "nope" });
    expect(bad.status).toBe(400);

    const unlinked = (await json(await app().request(`/tasks/${task.id}/jira`, { method: "DELETE" }))) as unknown as Task;
    expect(unlinked.jira).toBeNull();
    expect((await pipeline.events(task.id)).map((e) => e.kind)).toContain("jira.unlinked");
  });

  it("creates an issue from the ticket in the repo's project (or the one given), links it, and refuses a second one", async () => {
    const task = await pipeline.createTask({ title: "Login page", description: "Users sign in.", criteria: ["bad password errors", "/login renders"], repoPath: "/r/a" });
    const created = await post(`/tasks/${task.id}/jira/create`, {});
    expect(created.status).toBe(201);
    const body = (await json(created)) as unknown as Task;
    expect(body.jira).toMatchObject({ key: "PLAT-500", url: `${SITE}/browse/PLAT-500`, issueType: "Task" });
    expect(jira.writes).toEqual([["createIssue", "PLAT", "Task", "Login page", "Users sign in.\n\n## Criteria\n- [ ] bad password errors\n- [ ] /login renders"]]);
    const again = await post(`/tasks/${task.id}/jira/create`, {});
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: "already_linked" });

    const other = await pipeline.createTask({ title: "Other" });
    const chosen = await post(`/tasks/${other.id}/jira/create`, { project: "OPS", issueType: "Bug" });
    expect(chosen.status).toBe(201);
    expect(jira.writes.at(-1)).toEqual(["createIssue", "OPS", "Bug", "Other", ""]);
  });

  it("answers 409 no_project without a project, 409 no_token when Jira is unconfigured, and has no routes at all without the port", async () => {
    pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true });
    const task = await pipeline.createTask({ title: "x" });
    const none = await post(`/tasks/${task.id}/jira/create`, {});
    expect(none.status).toBe(409);
    expect(await json(none)).toMatchObject({ error: "no_project" });
    const noToken = await app({ token: false }).request(`/tasks/${task.id}/jira`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "PLAT-1" }) });
    expect(noToken.status).toBe(409);
    expect(await json(noToken)).toMatchObject({ error: "no_token" });
    expect((await app({ token: false }).request("/jira/status")).status).toBe(200);
    expect((await app({ jira: false }).request("/jira/status")).status).toBe(404);
    expect((await app({ jira: false }).request(`/tasks/${task.id}/jira`, { method: "DELETE" })).status).toBe(404);
  });

  it("serializes every task with the clocks the sla dependency computes", async () => {
    const task = await pipeline.createTask({ title: "x" });
    const list = (await (await app().request("/tasks")).json()) as Task[];
    expect(list[0]!.sla).toEqual(sla);
    const one = (await json(await app().request(`/tasks/${task.id}`))) as { task: Task };
    expect(one.task.sla).toEqual(sla);
    expect(one.task.jira).toBeNull();
    const bare = (await (await createApp({ db, pipeline, bus }).request("/tasks")).json()) as Task[];
    expect(bare[0]!.sla).toBeNull();
  });
});
