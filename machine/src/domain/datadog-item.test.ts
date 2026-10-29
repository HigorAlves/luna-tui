import { describe, expect, it } from "vitest";
import { applyFloor, fromCluster, fromIncident, fromIssue, fromMonitor, merge, splitOf, triageOrder } from "./datadog-item.ts";

const web = (p: string) => `https://app.datadoghq.com/${p}`;
const now = new Date("2026-10-29T12:00:00Z");
const incident = { id: "x", publicId: 812, title: "Checkout failing", state: "active", severity: "SEV-2", customerImpacted: false, created: "2026-10-29T11:00:00Z", modified: "2026-10-29T11:30:00Z" };
const monitor = { monitorId: 4411, monitorName: "5xx rate", group: "service:api-gateway,env:prod", status: "Alert", priority: null, lastTriggered: "2026-10-29T11:50:00Z" };
const issue = { id: "9f3", errorType: "TypeError", errorMessage: "Cannot read 'id'", service: "web", env: "prod", state: "OPEN", isRegression: true, count: 340, firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-29T11:58:00Z", repositoryUrl: "https://github.com/acme/web" };
const cluster = { service: "billing", errorKind: "TimeoutError", env: "prod", count: 1200, firstSeen: "2026-10-29T11:45:00Z", lastSeen: "2026-10-29T11:59:00Z", samples: ["upstream stripe timed out"], repositoryUrl: null };

describe("datadog items", () => {
  it("fingerprints each source", () => {
    expect(fromIncident(incident, web).id).toBe("inc:812");
    expect(fromMonitor(monitor, web).id).toBe("mon:4411:service:api-gateway,env:prod");
    expect(fromIssue(issue, web).id).toBe("et:9f3");
    expect(fromCluster(cluster, web).id).toBe("log:billing:TimeoutError");
  });
  it("sets floors from rules", () => {
    expect(fromIncident(incident, web).floor).toBe("P0");
    expect(fromIncident({ ...incident, severity: "SEV-4" }, web).floor).toBe("P1");
    expect(fromMonitor(monitor, web).floor).toBe("P1");
    expect(fromMonitor({ ...monitor, status: "Warn" }, web).floor).toBeNull();
    expect(fromIssue(issue, web).floor).toBe("P1");
    expect(fromCluster(cluster, web).floor).toBeNull();
  });
  it("builds the log link for a cluster without an error kind and quotes the service", () => {
    const query = (c: typeof cluster) => decodeURIComponent(new URL(fromCluster(c, web).url).searchParams.get("query")!);
    expect(query({ ...cluster, errorKind: "-" })).toBe('status:error service:"billing" -@error.kind:*');
    expect(query({ ...cluster, service: 'my svc"x' })).toBe('status:error service:"my svc\\"x" @error.kind:"TimeoutError"');
  });
  it("takes the repository from a GitHub url", () => {
    expect(fromIssue(issue, web).repository).toBe("acme/web");
  });
  it("orders incidents, monitors, Error Tracking, then logs", () => {
    const items = [fromCluster(cluster, web), fromIssue(issue, web), fromMonitor(monitor, web), fromIncident(incident, web)];
    expect(triageOrder(items).map((i) => i.source)).toEqual(["incident", "monitor", "error_tracking", "error_logs"]);
  });
  it("reopens a done item that fired again", () => {
    const done = { ...fromCluster(cluster, web), doneAt: "2026-10-29T11:00:00Z", triage: { priority: "P2" } as never };
    const merged = merge(done, fromCluster(cluster, web), now);
    expect(merged).toMatchObject({ doneAt: null, reopenedAt: now.toISOString(), triage: null });
  });
  it("keeps triage and done when nothing new happened", () => {
    const done = { ...fromCluster(cluster, web), doneAt: "2026-10-29T11:59:30Z", triage: { priority: "P2" } as never };
    expect(merge(done, fromCluster(cluster, web), now)).toMatchObject({ doneAt: "2026-10-29T11:59:30Z", triage: { priority: "P2" } });
  });
  it("re-triages a triaged item whose floor rose above its verdict, but not one you set by hand", () => {
    const stored = { ...fromIncident({ ...incident, severity: "SEV-4" }, web), triage: { priority: "P2", overridden: false } as never };
    const risen = fromIncident({ ...incident, severity: "SEV-1" }, web);
    const merged = merge(stored, risen, now);
    expect(merged.triage).toBeNull();
    expect(merged.split).toBe("act_now");
    const byHand = merge({ ...stored, triage: { priority: "P2", overridden: true } as never }, risen, now);
    expect(byHand.triage).toMatchObject({ priority: "P2" });
    const sameFloor = merge({ ...stored, triage: { priority: "P1", overridden: false } as never }, fromIncident({ ...incident, severity: "SEV-4" }, web), now);
    expect(sameFloor.triage).toMatchObject({ priority: "P1" });
  });
  it("an edit alone does not reopen a done incident; a new state or severity does", () => {
    const done = { ...fromIncident(incident, web), doneAt: "2026-10-29T11:40:00Z", triage: { priority: "P0", overridden: false } as never };
    const edited = fromIncident({ ...incident, modified: "2026-10-29T11:59:00Z" }, web);
    expect(merge(done, edited, now)).toMatchObject({ doneAt: "2026-10-29T11:40:00Z", lastSeen: "2026-10-29T11:59:00Z", reopenedAt: null });
    expect(merge(done, fromIncident({ ...incident, modified: "2026-10-29T11:59:00Z", state: "stable" }, web), now).doneAt).toBeNull();
    expect(merge(done, fromIncident({ ...incident, modified: "2026-10-29T11:59:00Z", severity: "SEV-1" }, web), now).doneAt).toBeNull();
    expect(merge({ ...done, resolvedAt: "2026-10-29T11:45:00Z" }, edited, now).doneAt).toBeNull();
  });
  it("never lets the model go below the floor", () => {
    expect(applyFloor("P2", "P1")).toBe("P1");
    expect(applyFloor("P0", "P1")).toBe("P0");
    expect(applyFloor("P3", null)).toBe("P3");
  });
  it("splits by priority, snoozed and done first", () => {
    const item = fromCluster(cluster, web);
    expect(splitOf({ ...item, triage: { priority: "P0" } as never }, now)).toBe("act_now");
    expect(splitOf({ ...item, triage: { priority: "P3" } as never }, now)).toBe("noise");
    expect(splitOf({ ...item, snoozedUntil: "2026-10-29T13:00:00Z" }, now)).toBe("snoozed");
    expect(splitOf({ ...item, doneAt: "2026-10-29T11:00:00Z" }, now)).toBe("done");
    expect(splitOf(fromIncident(incident, web), now)).toBe("act_now");
  });
});
