import { describe, expect, it } from "vitest";

import { DatadogAuthError, DatadogError } from "../../application/datadog.ts";
import errorTracking from "./fixtures/error-tracking.json" with { type: "json" };
import incidents from "./fixtures/incidents.json" with { type: "json" };
import aggregate from "./fixtures/logs-aggregate.json" with { type: "json" };
import search from "./fixtures/logs-search.json" with { type: "json" };
import groups from "./fixtures/monitor-groups.json" with { type: "json" };
import { createDatadog } from "./rest.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function fake(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next;
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}
const options = (f: ReturnType<typeof fake>, slept: number[] = []) => ({ apiKey: "k", appKey: "a", site: "datadoghq.eu", fetch: f.fetch, sleep: async (ms: number) => void slept.push(ms) });

describe("Datadog REST", () => {
  it("authenticates with both keys against the site's api host", async () => {
    const f = fake(json(200, incidents));
    await createDatadog(options(f)).incidents();
    expect(f.calls[0]!.url).toMatch(/^https:\/\/api\.datadoghq\.eu\/api\/v2\/incidents\?/);
    expect(f.calls[0]!.init.headers).toMatchObject({ "DD-API-KEY": "k", "DD-APPLICATION-KEY": "a" });
  });
  it("keeps unresolved incidents and reads either severity shape", async () => {
    const list = await createDatadog(options(fake(json(200, incidents)))).incidents();
    expect(list.map((i) => [i.publicId, i.state, i.severity])).toEqual([[812, "active", "SEV-2"], [813, "stable", "SEV-4"]]);
  });
  it("waits out one short 429, then gives up on the second", async () => {
    const slept: number[] = [];
    const f = fake(json(429, {}, { "X-RateLimit-Reset": "3" }), json(429, {}, { "X-RateLimit-Reset": "3" }));
    await expect(createDatadog(options(f, slept)).incidents()).rejects.toMatchObject({ status: 429 });
    expect(slept).toEqual([3000]);
  });
  it("does not sleep through a long 429 reset: it throws at once", async () => {
    const slept: number[] = [];
    const f = fake(json(429, {}, { "X-RateLimit-Reset": "540" }));
    await expect(createDatadog(options(f, slept)).incidents()).rejects.toMatchObject({ status: 429 });
    expect(slept).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });
  it("retries a 5xx twice", async () => {
    const f = fake(json(502, {}), json(503, {}), json(200, incidents));
    await createDatadog(options(f)).incidents();
    expect(f.calls).toHaveLength(3);
  });
  it("a 403 names the path and the scopes", async () => {
    const f = fake(json(403, { errors: ["Forbidden"] }));
    const error = await createDatadog(options(f)).incidents().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatadogAuthError);
    expect((error as Error).message).toMatch(/api\/v2\/incidents.*scope/);
  });
  it("searches alerting monitor groups inside the scope", async () => {
    const f = fake(json(200, groups));
    const list = await createDatadog(options(f)).alertingMonitors("env:prod");
    expect(new URL(f.calls[0]!.url).searchParams.get("query")).toBe('status:(alert OR warn OR "no data") env:prod');
    expect(list[0]).toMatchObject({ monitorId: 4411, group: "service:api-gateway,env:prod", status: "Alert" });
  });
  it("a non-JSON answer is a DatadogError", async () => {
    const f = fake(new Response("<html>", { status: 200 }));
    await expect(createDatadog(options(f)).incidents()).rejects.toBeInstanceOf(DatadogError);
  });
  it("clusters error logs by service and error kind, with samples", async () => {
    const f = fake(json(200, aggregate), json(200, search), json(200, search));
    const clusters = await createDatadog(options(f)).errorLogClusters("env:prod", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z", 2);
    const agg = JSON.parse(String(f.calls[0]!.init.body));
    expect(f.calls[0]!.url).toMatch(/api\/v2\/logs\/analytics\/aggregate$/);
    expect(agg.filter.query).toBe("status:error env:prod");
    expect(agg.group_by.map((g: { facet: string }) => g.facet)).toEqual(["service", "@error.kind"]);
    expect(clusters[0]).toMatchObject({ service: "billing", errorKind: "TimeoutError", count: 1200, env: "prod", repositoryUrl: "https://github.com/acme/billing" });
    expect(clusters[0]!.samples).toEqual(["request to ledger timed out", "upstream timed out after 30s", "request to ledger timed out"]);
    expect(clusters[0]).toMatchObject({ firstSeen: "2026-10-29T10:01:00.000Z", lastSeen: "2026-10-29T10:14:30.000Z" });
    const events = JSON.parse(String(f.calls[1]!.init.body));
    expect(f.calls[1]!.url).toMatch(/api\/v2\/logs\/events\/search$/);
    expect(events.filter.query).toBe('status:error env:prod service:billing @error.kind:"TimeoutError"');
    expect(events.page.limit).toBe(3);
    expect(f.calls).toHaveLength(3);
    expect(clusters).toHaveLength(2);
  });
  it("a log bucket without an error kind becomes '-'", async () => {
    const f = fake(json(200, aggregate), json(200, search), json(200, search), json(200, search));
    const clusters = await createDatadog(options(f)).errorLogClusters("", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z", 3);
    expect(clusters.find((c) => c.service === "worker")!.errorKind).toBe("-");
    const queries = f.calls.slice(1).map((c) => JSON.parse(String(c.init.body)).filter.query);
    expect(queries).toContain("status:error service:worker -@error.kind:*");
  });
  it("keeps the partial buckets of a timed-out aggregate", async () => {
    const f = fake(json(200, { ...aggregate, meta: { status: "timeout" } }), json(200, search), json(200, search));
    const clusters = await createDatadog(options(f)).errorLogClusters("", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z", 2);
    expect(clusters).toHaveLength(2);
  });
  it("searches Error Tracking with the documented request and joins counts to issues", async () => {
    const f = fake(json(200, errorTracking));
    await createDatadog(options(f)).errorTrackingIssues("env:prod", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z");
    expect(f.calls[0]!.url).toMatch(/api\/v2\/error-tracking\/issues\/search\?include=issue$/);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      data: {
        type: "search_request",
        attributes: { query: "env:prod", from: 1793268000000, to: 1793268900000, persona: "ALL", order_by: "TOTAL_COUNT", states: ["OPEN", "ACKNOWLEDGED"] },
      },
    });
  });
  it("Error Tracking falls back to * when the scope is empty", async () => {
    const f = fake(json(200, errorTracking));
    await createDatadog(options(f)).errorTrackingIssues("", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z");
    expect(JSON.parse(String(f.calls[0]!.init.body)).data.attributes.query).toBe("*");
  });
  it("keeps open Error Tracking issues, with the count of their own result", async () => {
    const f = fake(json(200, errorTracking));
    const issues = await createDatadog(options(f)).errorTrackingIssues("env:prod", "2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z");
    expect(issues.map((i) => [i.id, i.state, i.isRegression, i.count])).toEqual([["9f3", "OPEN", true, 340]]);
    expect(issues[0]).toMatchObject({
      errorType: "TypeError",
      errorMessage: "Cannot read properties of undefined (reading 'id')",
      service: "web",
      env: null,
      repositoryUrl: null,
      firstSeen: "2025-10-01T00:00:00.000Z",
      lastSeen: "2025-10-29T11:48:00.000Z",
    });
  });

  const incidentPage = (from: number, n: number, nextOffset: number | null, state = "active") =>
    json(200, {
      data: Array.from({ length: n }, (_, i) => ({ id: `id${from + i}`, attributes: { public_id: from + i, title: `t${from + i}`, state, severity: "SEV-3", customer_impacted: false, created: "2026-10-28T08:00:00.000Z", modified: "2026-10-28T09:00:00.000Z" } })),
      meta: { pagination: { offset: from, next_offset: nextOffset, size: n } },
    });

  it("follows next_offset through every incident page", async () => {
    const f = fake(incidentPage(0, 50, 50), incidentPage(50, 3, null));
    const list = await createDatadog(options(f)).incidents();
    expect(list).toHaveLength(53);
    expect(new URL(f.calls[1]!.url).searchParams.get("page[offset]")).toBe("50");
    expect(list.incomplete).toBeFalsy();
  });
  it("marks the incident list incomplete when the page cap is hit", async () => {
    const f = fake(...Array.from({ length: 10 }, (_, i) => incidentPage(i * 50, 50, (i + 1) * 50)));
    const list = await createDatadog(options(f)).incidents();
    expect(f.calls).toHaveLength(10);
    expect(list).toHaveLength(500);
    expect(list.incomplete).toBe(true);
  });
  it("pages monitor groups until page_count and marks the list incomplete at the cap", async () => {
    const group = (id: number) => ({ monitor_id: id, monitor_name: `m${id}`, group: "*", status: "Alert", last_triggered_ts: null });
    const f = fake(json(200, { groups: [group(1)], metadata: { page: 0, page_count: 2, per_page: 100 } }), json(200, { groups: [group(2)], metadata: { page: 1, page_count: 2, per_page: 100 } }));
    const list = await createDatadog(options(f)).alertingMonitors("");
    expect(list.map((g) => g.monitorId)).toEqual([1, 2]);
    expect(new URL(f.calls[1]!.url).searchParams.get("page")).toBe("1");
    expect(list.incomplete).toBeFalsy();
    const many = fake(...Array.from({ length: 10 }, (_, i) => json(200, { groups: [group(i)], metadata: { page: i, page_count: 40, per_page: 100 } })));
    const capped = await createDatadog(options(many)).alertingMonitors("");
    expect(many.calls).toHaveLength(10);
    expect(capped.incomplete).toBe(true);
  });

  const bigAggregate = (n: number) => ({ data: { buckets: Array.from({ length: n }, (_, i) => ({ by: { service: `svc${i}`, "@error.kind": "Boom" }, computes: { c0: 100 - i } })) } });
  const range = ["2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z"] as const;

  it("runs at most three sample searches at once", async () => {
    let live = 0;
    let peak = 0;
    const calls: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("aggregate")) return json(200, bigAggregate(8));
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return json(200, search);
    };
    const clusters = await createDatadog({ ...options(fake()), fetch: fetch as typeof globalThis.fetch }).errorLogClusters("", ...range, 8);
    expect(clusters).toHaveLength(8);
    expect(peak).toBe(3);
  });
  it("keeps a cluster whose sample search failed, with no samples", async () => {
    const answers = [json(200, bigAggregate(2)), json(400, {}), json(200, search)];
    const f = fake(...answers);
    const clusters = await createDatadog(options(f)).errorLogClusters("", ...range, 2);
    expect(clusters).toHaveLength(2);
    expect(clusters.filter((c) => c.samples.length === 0)).toHaveLength(1);
  });
  it("normalises string timestamps and falls back for an invalid one", async () => {
    const odd = JSON.parse(JSON.stringify(errorTracking));
    odd.included[0].attributes.first_seen = "2025-10-01T02:00:00+02:00";
    odd.included[0].attributes.last_seen = "not a date";
    const issues = await createDatadog(options(fake(json(200, odd)))).errorTrackingIssues("", ...range);
    expect(issues[0]!.firstSeen).toBe("2025-10-01T00:00:00.000Z");
    expect(issues[0]!.lastSeen).toBe("2026-10-29T10:15:00Z");
  });
});
