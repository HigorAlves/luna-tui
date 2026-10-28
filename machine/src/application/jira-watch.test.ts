import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { freshTestDatabase } from "../test/database.ts";
import type { TaskRow } from "../domain/task.ts";
import { fakeJira } from "../test/jira.ts";
import { JiraAuthError } from "./jira.ts";
import { TokenExpiry } from "./jira-tasks.ts";
import { JiraWatch, endedInJira } from "./jira-watch.ts";
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

const SITE = "https://acme.atlassian.net";
const NOW = new Date("2026-10-28T12:00:00Z");

function wire(
  jira = fakeJira({ issues: [{ key: "PLAT-123", status: "In Progress", statusCategory: "indeterminate", priority: "High", dueAt: "2026-10-31", issueType: "Bug" }] }),
  over: { expiresAt?: string | null; retryBlocked?: (task: TaskRow) => Promise<void> } = {},
) {
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: SITE });
  const published: string[] = [];
  const warnings: string[] = [];
  const expiry = new TokenExpiry(over.expiresAt ?? null);
  let now = NOW;
  const watch = new JiraWatch({
    pipeline,
    jira,
    intervalMs: 300_000,
    publish: (t) => published.push(t.jira?.status ?? "?"),
    expiry,
    now: () => now,
    warn: (m) => warnings.push(m),
    ...(over.retryBlocked ? { retryBlocked: over.retryBlocked } : {}),
  });
  return { pipeline, jira, watch, published, warnings, expiry, setNow: (d: Date) => (now = d) };
}

describe("JiraWatch", () => {
  it("mirrors the issue's status, priority, due date, type and the site's timezone (read once) onto the task, publishing when something the board shows changed", async () => {
    const { pipeline, jira, watch, published } = wire();
    const me = vi.spyOn(jira, "me");
    const task = await pipeline.createTask({ title: "PLAT-123 x" });
    await watch.pollOnce();
    const after = await pipeline.get(task.id);
    expect(after.jira).toEqual({ key: "PLAT-123", url: `${SITE}/browse/PLAT-123`, issueType: "Bug", status: "In Progress", priority: "High", dueAt: "2026-10-31", syncedAt: NOW.toISOString(), blocked: null, linkedAt: null, timeZone: "America/Sao_Paulo" });
    expect(published).toEqual(["In Progress"]);
    await watch.pollOnce();
    expect(published).toEqual(["In Progress"]);
    expect(me).toHaveBeenCalledTimes(1);
    expect((await pipeline.events(task.id)).filter((e) => e.kind === "jira.moved")).toEqual([]);
  });

  it("records jira.moved once when the issue reaches Done, Cancelled or Won't Do while the task is open; closed tasks are left alone", async () => {
    const { pipeline, jira, watch } = wire();
    const task = await pipeline.createTask({ title: "PLAT-123 x" });
    await watch.pollOnce();
    jira.issues.get("PLAT-123")!.status = "Done";
    jira.issues.get("PLAT-123")!.statusCategory = "done";
    await watch.pollOnce();
    await watch.pollOnce();
    const moved = (await pipeline.events(task.id)).filter((e) => e.kind === "jira.moved");
    expect(moved.map((e) => e.payload)).toEqual([{ status: "Done", key: "PLAT-123" }]);
    expect(endedInJira("Cancelled", "indeterminate")).toBe(true);
    expect(endedInJira("Won't Do", null)).toBe(true);
    expect(endedInJira("In Review", "indeterminate")).toBe(false);

    const closed = await pipeline.createTask({ title: "PLAT-123 y" });
    await pipeline.start(closed.id);
    for (let i = 0; i < 4; i++) await pipeline.decide(closed.id, "approved");
    jira.issues.get("PLAT-123")!.status = "Cancelled";
    await watch.pollOnce();
    expect((await pipeline.events(closed.id)).filter((e) => e.kind === "jira.moved")).toEqual([]);
    expect((await pipeline.get(closed.id)).jira?.status).toBeNull();
  });

  it("warns daily inside the last two weeks of MACHINE_JIRA_TOKEN_EXPIRES, and not at all without it", async () => {
    const quiet = wire();
    await quiet.pipeline.createTask({ title: "PLAT-123 x" });
    await quiet.watch.pollOnce();
    expect(quiet.warnings).toEqual([]);
    const { watch, warnings, setNow } = wire(undefined, { expiresAt: "2026-11-05" });
    await watch.pollOnce();
    expect(warnings).toEqual(["jira: the API token expires in 8 day(s) (2026-11-05); make a new one at id.atlassian.com and set MACHINE_JIRA_TOKEN (and MACHINE_JIRA_TOKEN_EXPIRES)"]);
    setNow(new Date("2026-10-28T18:00:00Z"));
    await watch.pollOnce();
    expect(warnings).toHaveLength(1);
    setNow(new Date("2026-10-29T13:00:00Z"));
    await watch.pollOnce();
    expect(warnings).toHaveLength(2);
    const far = wire(undefined, { expiresAt: "2027-06-01" });
    await far.watch.pollOnce();
    expect(far.warnings).toEqual([]);
  });

  it("tries a blocked transition again through the retry hook while the issue answers, publishing once the mark clears", async () => {
    const retried: string[] = [];
    const { pipeline, watch, published } = wire(undefined, {
      retryBlocked: async (task) => {
        retried.push(task.id);
        await pipeline.setJira(task.id, { ...task.jira!, blocked: null });
      },
    });
    const task = await pipeline.createTask({ title: "PLAT-123 x" });
    await pipeline.setJira(task.id, { ...task.jira!, blocked: { wanted: "Done", current: "In Progress", why: "no transition", at: NOW.toISOString() } });
    await watch.pollOnce();
    expect(retried).toEqual([task.id]);
    expect((await pipeline.get(task.id)).jira?.blocked).toBeNull();
    expect(published).toEqual(["In Progress", "In Progress"]);
    await watch.pollOnce();
    expect(retried).toHaveLength(1);
  });

  it("warns once on a rejected token and keeps the expiry a 401 names, over the configured one", async () => {
    const jira = fakeJira({ issues: [{ key: "PLAT-123" }], failing: { issue: new JiraAuthError("Jira rejected the token on GET issue/PLAT-123 (expired or revoked): HTTP 401", "2026-11-05T00:00:00Z") } });
    const { pipeline, watch, warnings, expiry, setNow } = wire(jira, { expiresAt: "2027-01-01" });
    await pipeline.createTask({ title: "PLAT-123 x" });
    await pipeline.createTask({ title: "PLAT-123 z" });
    await watch.pollOnce();
    expect(warnings.filter((w) => w.includes("rejected the token"))).toHaveLength(1);
    expect(expiry.at).toBe("2026-11-05T00:00:00Z");
    await watch.pollOnce();
    expect(warnings.filter((w) => w.includes("rejected the token"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("expires in 8 day(s)"))).toHaveLength(1);
    setNow(new Date("2026-10-28T18:00:00Z"));
    await watch.pollOnce();
    expect(warnings.filter((w) => w.includes("expires in"))).toHaveLength(1);
    setNow(new Date("2026-10-29T13:00:00Z"));
    await watch.pollOnce();
    expect(warnings.filter((w) => w.includes("expires in"))).toHaveLength(2);
  });
});
