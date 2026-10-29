import type { DatadogSnapshot } from "@hardness/contracts";
import { describe, expect, it, vi } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import { type Datadog, DatadogError, NoDatadogTokenError, noTokenDatadog } from "./datadog.ts";
import { DatadogInbox, NoDatadogItemError } from "./datadog-inbox.ts";
import { InMemoryDatadogStore } from "./datadog-store.ts";
import type { DatadogTriageVerdict, DatadogTriager } from "./datadog-triage.ts";
import type { NewTask } from "./pipeline.ts";
import { AlreadyTaskError } from "./slack-inbox.ts";
import { TriageRunError } from "./slack-triage.ts";

const T0 = new Date("2026-10-28T12:00:00.000Z");

const incident = { id: "i", publicId: 812, title: "Checkout down", state: "active", severity: "SEV-1", customerImpacted: true, created: "2026-10-28T11:00:00.000Z", modified: "2026-10-28T11:50:00.000Z" };
const monitor = { monitorId: 7, monitorName: "p99 latency", group: "service:api,env:prod", status: "Alert", priority: 2, lastTriggered: "2026-10-28T11:40:00.000Z" };
const issue = { id: "9f3", errorType: "TypeError", errorMessage: "x is undefined", service: "web", env: "prod", state: "OPEN", isRegression: false, count: 120, firstSeen: "2026-10-28T10:00:00.000Z", lastSeen: "2026-10-28T11:55:00.000Z", repositoryUrl: "https://github.com/acme/web" };
const cluster = { service: "api", errorKind: "TimeoutError", env: "prod", count: 30, firstSeen: "2026-10-28T11:00:00.000Z", lastSeen: "2026-10-28T11:58:00.000Z", samples: ["a", "b", "c"], repositoryUrl: null };

function fakeDatadog(over: Partial<Datadog> = {}): Datadog & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { incidents: [], alertingMonitors: [], errorTrackingIssues: [], errorLogClusters: [] };
  return {
    calls,
    incidents: async (...a) => (calls.incidents!.push(a), [incident]),
    alertingMonitors: async (...a) => (calls.alertingMonitors!.push(a), [monitor]),
    errorTrackingIssues: async (...a) => (calls.errorTrackingIssues!.push(a), [issue]),
    errorLogClusters: async (...a) => (calls.errorLogClusters!.push(a), [cluster]),
    webUrl: (path) => `https://app.datadoghq.com/${path}`,
    ...over,
  };
}

const verdict = (priority: DatadogTriageVerdict["priority"], summary = "s"): DatadogTriageVerdict => ({ priority, category: "outage", summary, why: "w", suspectedCause: null, nextStep: "look", refs: [] });

function make(over: { datadog?: Datadog; triager?: DatadogTriager | null; store?: InMemoryDatadogStore; retentionDays?: number } = {}) {
  let now = new Date(T0);
  const store = over.store ?? new InMemoryDatadogStore();
  const published: DatadogSnapshot[] = [];
  const created: NewTask[] = [];
  const datadog = over.datadog ?? fakeDatadog();
  const inbox = new DatadogInbox({
    datadog,
    store,
    triager: over.triager === undefined ? null : over.triager,
    scope: "env:prod",
    intervalMs: 60_000,
    retentionDays: over.retentionDays,
    publish: (s) => void published.push(s),
    createTask: async (input) => (created.push(input), { id: "t1" } as TaskRow),
    findTask: async (id) => (created.length > 0 && id === "t1" ? ({ id } as TaskRow) : null),
    resolveRepo: async (slug) => (slug === "acme/web" ? "/repos/web" : null),
    now: () => now,
  });
  return { inbox, store, published, created, datadog: datadog as ReturnType<typeof fakeDatadog>, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("DatadogInbox.pollOnce", () => {
  it("asks the four sources in parallel and lists their items", async () => {
    let open!: () => void;
    const gate = { promise: new Promise<void>((resolve) => (open = resolve)), resolve: () => open() };
    const started: string[] = [];
    const slow = <T,>(name: string, value: T) => async () => (started.push(name), await gate.promise, value);
    const { inbox } = make({
      datadog: { ...fakeDatadog(), incidents: slow("incidents", [incident]), alertingMonitors: slow("monitors", [monitor]), errorTrackingIssues: slow("et", [issue]), errorLogClusters: slow("logs", [cluster]) },
    });
    const poll = inbox.pollOnce(true);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    gate.resolve();
    const snapshot = await poll;
    expect(snapshot.items.map((i) => i.id)).toEqual(["inc:812", "mon:7:service:api,env:prod", "et:9f3", "log:api:TimeoutError"]);
    expect(snapshot.sources).toEqual({ incident: { ok: true, error: null, count: 1 }, monitor: { ok: true, error: null, count: 1 }, error_tracking: { ok: true, error: null, count: 1 }, error_logs: { ok: true, error: null, count: 1 } });
    expect(snapshot.polledAt).toBe(T0.toISOString());
  });

  it("one failing source sets its error and leaves the others' items", async () => {
    const { inbox } = make({ datadog: fakeDatadog({ errorTrackingIssues: async () => { throw new DatadogError("boom", 500); } }) });
    const snapshot = await inbox.pollOnce(true);
    expect(snapshot.sources.error_tracking).toEqual({ ok: false, error: "boom", count: 0 });
    expect(snapshot.sources.incident.ok).toBe(true);
    expect(snapshot.items.some((i) => i.source === "incident")).toBe(true);
    expect(snapshot.error).toBeNull();
  });

  it("looks back one hour on the first poll, then to the previous poll's end minus a minute", async () => {
    const { inbox, datadog, advance } = make();
    await inbox.pollOnce(true);
    expect(datadog.calls.errorTrackingIssues![0]).toEqual(["env:prod", "2026-10-28T11:00:00.000Z", "2026-10-28T12:00:00.000Z"]);
    expect(datadog.calls.errorLogClusters![0]).toEqual(["env:prod", "2026-10-28T11:00:00.000Z", "2026-10-28T12:00:00.000Z", 10]);
    expect(datadog.calls.alertingMonitors![0]).toEqual(["env:prod"]);
    advance(5 * 60_000);
    await inbox.pollOnce(true);
    expect(datadog.calls.errorTrackingIssues![1]).toEqual(["env:prod", "2026-10-28T11:59:00.000Z", "2026-10-28T12:05:00.000Z"]);
  });

  it("does not move a failing source's window forward", async () => {
    let fail = true;
    const { inbox, datadog, advance } = make({ datadog: fakeDatadog({ errorTrackingIssues: async (...a) => { datadog.calls.errorTrackingIssues!.push(a); if (fail) throw new DatadogError("boom", 500); return [issue]; } }) });
    await inbox.pollOnce(true);
    fail = false;
    advance(5 * 60_000);
    await inbox.pollOnce(true);
    expect(datadog.calls.errorTrackingIssues![1]![1]).toBe("2026-10-28T11:00:00.000Z");
  });

  it("merges by fingerprint: a done item that fires again reopens and loses its triage, your snooze stays", async () => {
    let lastSeen = issue.lastSeen;
    const { inbox, store, advance } = make({ datadog: fakeDatadog({ errorTrackingIssues: async () => [{ ...issue, lastSeen }] }), triager: { triage: async () => new Map([["et:9f3", verdict("P2")]]) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    await inbox.patch("et:9f3", { done: true });
    await inbox.patch("log:api:TimeoutError", { snoozedUntil: "2026-11-30T00:00:00.000Z" });
    advance(60_000);
    lastSeen = "2026-10-28T12:00:30.000Z";
    await inbox.pollOnce(true);
    expect(store.rows.size).toBe(4);
    const again = store.rows.get("et:9f3")!;
    expect(again.doneAt).toBeNull();
    expect(again.reopenedAt).toBe("2026-10-28T12:01:00.000Z");
    expect(again.triage).toBeNull();
    expect(store.rows.get("log:api:TimeoutError")!.snoozedUntil).toBe("2026-11-30T00:00:00.000Z");
  });

  it("publishes the saved items first, triages open untriaged ones in triageOrder, then publishes again with triaging false", async () => {
    const seen: string[] = [];
    const { inbox, published } = make({ triager: { triage: async (items, scope) => (seen.push(scope, ...items.map((i) => i.source)), new Map([["inc:812", verdict("P0", "down")]])) } });
    await inbox.pollOnce(true);
    expect(published.at(-1)!.items.every((i) => i.triage === null)).toBe(true);
    await inbox.idle();
    expect(seen).toEqual(["env:prod", "incident", "monitor", "error_tracking", "error_logs"]);
    const last = published.at(-1)!;
    expect(last.triaging).toBe(false);
    expect(last.items.find((i) => i.id === "inc:812")!.triage).toMatchObject({ summary: "down", by: "model", overridden: false });
    expect(published.some((s) => s.triaging)).toBe(true);
  });

  it("does not triage done or snoozed items, nor ones that already have a verdict", async () => {
    const batches: string[][] = [];
    const { inbox, advance } = make({ triager: { triage: async (items) => (batches.push(items.map((i) => i.id)), new Map(items.filter((i) => i.id === "inc:812").map((i) => [i.id, verdict("P0")]))) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    await inbox.patch("et:9f3", { done: true });
    await inbox.patch("mon:7:service:api,env:prod", { snoozedUntil: "2026-11-30T00:00:00.000Z" });
    advance(60_000);
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(batches[1]).toEqual(["log:api:TimeoutError"]);
  });

  it("raises a verdict below the item's floor to the floor", async () => {
    const { inbox } = make({ triager: { triage: async () => new Map([["inc:812", verdict("P2")]]) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(inbox.snapshot.items.find((i) => i.id === "inc:812")!.triage!.priority).toBe("P0");
    expect(inbox.snapshot.items.find((i) => i.id === "inc:812")!.split).toBe("act_now");
  });

  it("keeps the answers of a failed run and leaves the rest untriaged", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { inbox } = make({ triager: { triage: async () => { throw new TriageRunError("docker: down", new Map([["inc:812", verdict("P1")]])); } } });
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(inbox.snapshot.items.find((i) => i.id === "inc:812")!.triage).not.toBeNull();
    expect(inbox.snapshot.items.find((i) => i.id === "et:9f3")!.triage).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("docker: down"));
    log.mockRestore();
  });

  it("backs a failed item off (1m, 5m, 15m) and gives up after that, while the others keep going", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[][] = [];
    const { inbox, advance } = make({ triager: { triage: async (items) => (calls.push(items.map((i) => i.id)), new Map(items.filter((i) => i.id !== "et:9f3").map((i) => [i.id, verdict("P2")]))) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(calls).toEqual([["inc:812", "mon:7:service:api,env:prod", "et:9f3", "log:api:TimeoutError"]]);
    // The skipped item waits out a minute before it is asked again.
    advance(30_000);
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(calls).toHaveLength(1);
    for (const wait of [31_000, 5 * 60_000 + 1, 15 * 60_000 + 1]) {
      advance(wait);
      await inbox.pollOnce(true);
      await inbox.idle();
    }
    expect(calls.slice(1)).toEqual([["et:9f3"], ["et:9f3"], ["et:9f3"]]);
    advance(60 * 60_000);
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(calls).toHaveLength(4);
    const stuck = inbox.snapshot.items.find((i) => i.id === "et:9f3")!;
    expect(stuck.triage).toBeNull();
    expect(stuck.split).toBe("investigate");
    log.mockRestore();
  });

  it("a thrown run counts as a failure for every item it left without an answer", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const { inbox, advance } = make({ triager: { triage: async () => (calls++, Promise.reject(new TriageRunError("docker: down", new Map()))) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(calls).toBe(1);
    advance(61_000);
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(calls).toBe(2);
    log.mockRestore();
  });

  it("answers no_token with an empty snapshot when the keys are unset", async () => {
    const { inbox, store } = make({ datadog: noTokenDatadog() });
    const snapshot = await inbox.pollOnce(true);
    expect(snapshot.error).toBe("no_token");
    expect(snapshot.items).toEqual([]);
    expect(store.rows.size).toBe(0);
    const direct = make({ datadog: fakeDatadog({ incidents: async () => { throw new NoDatadogTokenError(); } }) });
    expect((await direct.inbox.pollOnce(true)).error).toBe("no_token");
  });

  it("backs the next scheduled poll off to five minutes after a 429", async () => {
    let limited = true;
    const { inbox, datadog, advance } = make({ datadog: fakeDatadog({ incidents: async () => { if (limited) throw new DatadogError("rate limited", 429); return [incident]; } }) });
    await inbox.pollOnce(true);
    expect(inbox.nextDelayMs).toBe(5 * 60_000);
    limited = false;
    advance(60_000);
    await inbox.pollOnce();
    expect(datadog.calls.alertingMonitors).toHaveLength(1);
    await inbox.pollOnce(true);
    expect(inbox.nextDelayMs).toBe(60_000);
  });

  it("prunes done items and old runs past the retention", async () => {
    const store = new InMemoryDatadogStore();
    const spy = vi.spyOn(store, "prune");
    const { inbox } = make({ store, retentionDays: 90 });
    await inbox.pollOnce(true);
    expect(spy).toHaveBeenCalledWith(new Date("2026-09-28T12:00:00.000Z"), new Date("2026-07-30T12:00:00.000Z"));
  });
});

describe("DatadogInbox resolved marking", () => {
  it("marks a monitor that is gone on the next successful poll resolved, keeps it listed and open, and clears it when it is back", async () => {
    let alerting = [monitor];
    const { inbox, store, advance } = make({ datadog: fakeDatadog({ alertingMonitors: async () => alerting }) });
    await inbox.pollOnce(true);
    expect(store.rows.get("mon:7:service:api,env:prod")!.resolvedAt).toBeNull();
    alerting = [];
    advance(60_000);
    await inbox.pollOnce(true);
    const gone = inbox.snapshot.items.find((i) => i.id === "mon:7:service:api,env:prod")!;
    expect(gone).toMatchObject({ resolvedAt: "2026-10-28T12:01:00.000Z", doneAt: null });
    advance(60_000);
    await inbox.pollOnce(true);
    expect(store.rows.get("mon:7:service:api,env:prod")!.resolvedAt).toBe("2026-10-28T12:01:00.000Z");
    alerting = [monitor];
    advance(60_000);
    await inbox.pollOnce(true);
    expect(inbox.snapshot.items.find((i) => i.id === "mon:7:service:api,env:prod")!.resolvedAt).toBeNull();
  });

  it("marks a gone incident resolved, but never when the incidents call failed", async () => {
    let mode: "ok" | "gone" | "fail" = "ok";
    const { inbox, advance } = make({ datadog: fakeDatadog({ incidents: async () => { if (mode === "fail") throw new DatadogError("boom", 500); return mode === "ok" ? [incident] : []; } }) });
    await inbox.pollOnce(true);
    mode = "fail";
    advance(60_000);
    await inbox.pollOnce(true);
    expect(inbox.snapshot.items.find((i) => i.id === "inc:812")!.resolvedAt).toBeNull();
    mode = "gone";
    advance(60_000);
    await inbox.pollOnce(true);
    expect(inbox.snapshot.items.find((i) => i.id === "inc:812")!.resolvedAt).toBe("2026-10-28T12:02:00.000Z");
  });

  it("does not mark incidents or monitors resolved when their list came back incomplete", async () => {
    let list: unknown[] = [incident];
    let partial = false;
    const tagged = <T,>(items: T[]) => Object.assign([...items], { incomplete: partial });
    const { inbox, store, advance } = make({ datadog: fakeDatadog({ incidents: async () => tagged(list as (typeof incident)[]), alertingMonitors: async () => tagged(list.length ? [monitor] : []) }) });
    await inbox.pollOnce(true);
    list = [];
    partial = true;
    advance(60_000);
    await inbox.pollOnce(true);
    expect(store.rows.get("inc:812")!.resolvedAt).toBeNull();
    expect(store.rows.get("mon:7:service:api,env:prod")!.resolvedAt).toBeNull();
    partial = false;
    advance(60_000);
    await inbox.pollOnce(true);
    expect(store.rows.get("inc:812")!.resolvedAt).not.toBeNull();
    expect(store.rows.get("mon:7:service:api,env:prod")!.resolvedAt).not.toBeNull();
  });

  it("asks for the ten largest error-log clusters", async () => {
    const { inbox, datadog } = make();
    await inbox.pollOnce(true);
    expect(datadog.calls.errorLogClusters![0]![3]).toBe(10);
  });

  it("resolve-marks a done incident, and reopens it when Datadog reports it again", async () => {
    let present = true;
    const { inbox, advance } = make({ datadog: fakeDatadog({ incidents: async () => (present ? [incident] : []) }) });
    await inbox.pollOnce(true);
    await inbox.patch("inc:812", { done: true });
    present = false;
    advance(60_000);
    await inbox.pollOnce(true);
    const byId = (id: string) => inbox.snapshot.items.find((i) => i.id === id)!;
    expect(byId("inc:812")).toMatchObject({ split: "done" });
    expect(byId("inc:812").resolvedAt).not.toBeNull();
    present = true;
    advance(60_000);
    await inbox.pollOnce(true);
    expect(byId("inc:812")).toMatchObject({ doneAt: null, resolvedAt: null });
    expect(byId("inc:812").reopenedAt).not.toBeNull();
  });

  it("a still-firing item the pack keeps skipping does not get its retries back whenever lastSeen moves", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    let calls = 0;
    const { inbox, advance } = make({
      datadog: fakeDatadog({ errorLogClusters: async () => [{ ...cluster, lastSeen: new Date(T0.getTime() + ++n * 1000).toISOString() }] }),
      triager: { triage: async (items) => (items.some((i) => i.id === "log:api:TimeoutError") && calls++, new Map(items.filter((i) => i.source !== "error_logs").map((i) => [i.id, verdict("P2")]))) },
    });
    for (const wait of [0, 61_000, 5 * 60_000 + 1, 15 * 60_000 + 1, 60_000, 60_000, 3_600_000]) {
      advance(wait);
      await inbox.pollOnce(true);
      await inbox.idle();
    }
    expect(calls).toBe(4);
    log.mockRestore();
  });

  it("does not mark Error Tracking issues or error-log clusters resolved just for being absent", async () => {
    let present = true;
    const { inbox, advance } = make({ datadog: fakeDatadog({ errorTrackingIssues: async () => (present ? [issue] : []), errorLogClusters: async () => (present ? [cluster] : []), incidents: async () => (present ? [incident] : []) }) });
    await inbox.pollOnce(true);
    await inbox.patch("inc:812", { done: true });
    present = false;
    advance(60_000);
    await inbox.pollOnce(true);
    const byId = (id: string) => inbox.snapshot.items.find((i) => i.id === id)!;
    expect(byId("et:9f3").resolvedAt).toBeNull();
    expect(byId("log:api:TimeoutError").resolvedAt).toBeNull();
  });

  it("resolves Error Tracking issues and error-log clusters that were quiet for a day, on a successful poll of their source, and clears it when they fire again", async () => {
    let issues: (typeof issue)[] = [issue];
    let clusters: (typeof cluster)[] = [cluster];
    let etDown = false;
    const { inbox, advance } = make({
      datadog: fakeDatadog({
        errorTrackingIssues: async () => {
          if (etDown) throw new DatadogError("boom", 500);
          return issues;
        },
        errorLogClusters: async () => clusters,
      }),
    });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await inbox.pollOnce(true);
    issues = [];
    clusters = [];
    advance(23 * 3_600_000);
    await inbox.pollOnce(true);
    const byId = (id: string) => inbox.snapshot.items.find((i) => i.id === id)!;
    expect(byId("et:9f3").resolvedAt).toBeNull();
    etDown = true;
    advance(2 * 3_600_000);
    await inbox.pollOnce(true);
    expect(byId("et:9f3").resolvedAt).toBeNull();
    expect(byId("log:api:TimeoutError").resolvedAt).toBe("2026-10-29T13:00:00.000Z");
    etDown = false;
    advance(60_000);
    await inbox.pollOnce(true);
    expect(byId("et:9f3").resolvedAt).toBe("2026-10-29T13:01:00.000Z");
    expect(inbox.snapshot.items.some((i) => i.id === "et:9f3")).toBe(true);
    issues = [{ ...issue, lastSeen: "2026-10-29T13:00:30.000Z" }];
    advance(60_000);
    await inbox.pollOnce(true);
    expect(byId("et:9f3").resolvedAt).toBeNull();
    log.mockRestore();
  });

  it("does not send a resolved item to the triager", async () => {
    let alerting = [monitor];
    const batches: string[][] = [];
    const { inbox, advance } = make({ datadog: fakeDatadog({ alertingMonitors: async () => alerting }), triager: { triage: async (items) => (batches.push(items.map((i) => i.id)), new Map()) } });
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(batches[0]).toContain("mon:7:service:api,env:prod");
    alerting = [];
    advance(60_000);
    await inbox.pollOnce(true);
    await inbox.idle();
    expect(batches[1]).not.toContain("mon:7:service:api,env:prod");
    expect(batches[1]).toContain("inc:812");
  });
});

describe("DatadogInbox concurrent actions", () => {
  /** A store whose first `items` read after `arm()` returns only once `release()` is called (so the caller holds a stale list). */
  function gatedStore() {
    const store = new InMemoryDatadogStore();
    const read = store.items.bind(store);
    let gate: Promise<void> | null = null;
    let release!: () => void;
    let reached!: () => void;
    let hit: Promise<void> = new Promise((r) => (reached = r));
    store.items = async (since) => {
      const rows = await read(since);
      const wait = gate;
      if (wait) {
        gate = null;
        reached();
        await wait;
      }
      return rows;
    };
    return {
      store,
      arm: () => {
        gate = new Promise<void>((r) => (release = r));
        hit = new Promise((r) => (reached = r));
      },
      hit: () => hit,
      release: () => release(),
    };
  }

  it("a done click made while a poll is in flight is not overwritten by the poll's save", async () => {
    const g = gatedStore();
    const { inbox, store } = make({ store: g.store });
    await inbox.pollOnce(true);
    g.arm();
    const poll = inbox.pollOnce(true);
    await g.hit();
    const click = inbox.patch("et:9f3", { done: true });
    await new Promise((r) => setTimeout(r, 5));
    g.release();
    await Promise.all([poll, click]);
    expect(store.rows.get("et:9f3")!.doneAt).not.toBeNull();
  });

  it("a ticket made while you mark the item done keeps both", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const store = new InMemoryDatadogStore();
    const created: NewTask[] = [];
    const inbox = new DatadogInbox({
      datadog: fakeDatadog(),
      store,
      triager: null,
      scope: "",
      intervalMs: 60_000,
      publish: () => {},
      createTask: async (input) => (created.push(input), await gate, { id: "t1" } as TaskRow),
      findTask: async () => null,
      resolveRepo: async () => null,
      now: () => T0,
    });
    await inbox.pollOnce(true);
    const ticket = inbox.toTask("et:9f3", {});
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const click = inbox.patch("et:9f3", { done: true });
    await new Promise((r) => setTimeout(r, 5));
    open();
    await Promise.all([ticket, click]);
    expect(store.rows.get("et:9f3")).toMatchObject({ taskId: "t1" });
    expect(store.rows.get("et:9f3")!.doneAt).not.toBeNull();
  });
});

describe("DatadogInbox.patch", () => {
  it("marks done, snoozes and sets a priority by hand, republishing each time", async () => {
    const { inbox, published } = make();
    await inbox.pollOnce(true);
    const before = published.length;
    expect((await inbox.patch("et:9f3", { done: true })).split).toBe("done");
    expect(inbox.snapshot.items.find((i) => i.id === "et:9f3")!.doneAt).not.toBeNull();
    expect((await inbox.patch("et:9f3", { done: false })).doneAt).toBeNull();
    expect((await inbox.patch("et:9f3", { snoozedUntil: "2026-10-29T00:00:00.000Z" })).split).toBe("snoozed");
    const hand = await inbox.patch("log:api:TimeoutError", { priority: "P0" });
    expect(hand.triage).toMatchObject({ priority: "P0", overridden: true });
    expect(hand.split).toBe("act_now");
    expect(published.length).toBeGreaterThan(before);
  });

  it("rejects an unknown id", async () => {
    const { inbox } = make();
    await expect(inbox.patch("nope", { done: true })).rejects.toBeInstanceOf(NoDatadogItemError);
  });
});

describe("DatadogInbox.toTask", () => {
  it("makes a ticket carrying the samples, the link and the repo, once", async () => {
    const { inbox, created } = make();
    await inbox.pollOnce(true);
    const task = await inbox.toTask("et:9f3", {});
    expect(task.id).toBe("t1");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "TypeError: x is undefined",
      repoPath: "/repos/web",
      source: { kind: "datadog", source: "error_tracking", id: "et:9f3", url: "https://app.datadoghq.com/error-tracking/issue/9f3" },
    });
    const text = created[0]!.description!;
    for (const part of ["TypeError: x is undefined", "web", "prod", "OPEN", "120", "x is undefined", "https://app.datadoghq.com/error-tracking/issue/9f3"]) expect(text).toContain(part);
    expect(inbox.snapshot.items.find((i) => i.id === "et:9f3")!.taskId).toBe("t1");
    await expect(inbox.toTask("et:9f3", {})).rejects.toBeInstanceOf(AlreadyTaskError);
  });

  it("lets the caller pick the title and repo, and leaves repoPath null for an unknown repository", async () => {
    const { inbox, created } = make();
    await inbox.pollOnce(true);
    await inbox.toTask("log:api:TimeoutError", { title: "Fix timeouts" });
    expect(created[0]).toMatchObject({ title: "Fix timeouts", repoPath: null });
    await inbox.toTask("et:9f3", { repoPath: "/elsewhere" });
    expect(created[1]!.repoPath).toBe("/elsewhere");
  });
});
