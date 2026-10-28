import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../test/database.ts";
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

function wire(jira = fakeJira({ issues: [{ key: "PLAT-123", status: "In Progress", statusCategory: "indeterminate", priority: "High", dueAt: "2026-10-31", issueType: "Bug" }] })) {
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, jiraSite: SITE });
  const published: string[] = [];
  const warnings: string[] = [];
  const expiry = new TokenExpiry();
  let now = NOW;
  const watch = new JiraWatch({ pipeline, jira, intervalMs: 300_000, publish: (t) => published.push(t.jira?.status ?? "?"), expiry, now: () => now, warn: (m) => warnings.push(m) });
  return { pipeline, jira, watch, published, warnings, expiry, setNow: (d: Date) => (now = d) };
}

describe("JiraWatch", () => {
  it("mirrors the issue's status, priority, due date and type onto the task and publishes when something the board shows changed", async () => {
    const { pipeline, watch, published } = wire();
    const task = await pipeline.createTask({ title: "PLAT-123 x" });
    await watch.pollOnce();
    const after = await pipeline.get(task.id);
    expect(after.jira).toEqual({ key: "PLAT-123", url: `${SITE}/browse/PLAT-123`, issueType: "Bug", status: "In Progress", priority: "High", dueAt: "2026-10-31", syncedAt: NOW.toISOString(), blocked: null });
    expect(published).toEqual(["In Progress"]);
    await watch.pollOnce();
    expect(published).toEqual(["In Progress"]);
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

  it("warns once on a rejected token, keeps the expiry Jira named, and warns daily inside the last two weeks", async () => {
    const jira = fakeJira({ issues: [{ key: "PLAT-123" }], failing: { issue: new JiraAuthError("Jira rejected the token on GET issue/PLAT-123 (expired or revoked): HTTP 401", "2026-11-05T00:00:00Z") } });
    const { pipeline, watch, warnings, expiry, setNow } = wire(jira);
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
