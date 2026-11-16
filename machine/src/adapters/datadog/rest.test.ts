import { describe, expect, it } from "vitest";

import { DatadogAuthError, DatadogError } from "../../application/datadog.ts";
import errorTracking from "./fixtures/error-tracking.json" with { type: "json" };
import incidents from "./fixtures/incidents.json" with { type: "json" };
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
    expect(f.calls[0]!.url).toMatch(/^https:\/\/api\.datadoghq\.eu\/api\/v2\/incidents\/search\?/);
    const params = new URL(f.calls[0]!.url).searchParams;
    expect(params.get("query")).toBe("state:(active OR stable)");
    expect(params.get("sort")).toBe("-created");
    expect(params.get("page[size]")).toBe("100");
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
  it("links to the web app host of each site", () => {
    const link = (site: string) => createDatadog({ ...options(fake()), site }).webUrl("monitors/1");
    expect(link("datadoghq.com")).toBe("https://app.datadoghq.com/monitors/1");
    expect(link("datadoghq.eu")).toBe("https://app.datadoghq.eu/monitors/1");
    for (const regional of ["us3", "us5", "ap1", "ap2", "uk1"]) expect(link(`${regional}.datadoghq.com`)).toBe(`https://${regional}.datadoghq.com/monitors/1`);
    expect(link("ddog-gov.com")).toBe("https://app.ddog-gov.com/monitors/1");
    expect(link("https://api.datadoghq.eu/")).toBe("https://app.datadoghq.eu/monitors/1");
  });
  it("calls the api host whatever prefix the site was given with", async () => {
    const f = fake(json(200, incidents));
    await createDatadog({ ...options(f), site: "app.us5.datadoghq.com" }).incidents();
    expect(f.calls[0]!.url).toMatch(/^https:\/\/api\.us5\.datadoghq\.com\//);
  });
  it("a non-JSON answer is a DatadogError", async () => {
    const f = fake(new Response("<html>", { status: 200 }));
    await expect(createDatadog(options(f)).incidents()).rejects.toBeInstanceOf(DatadogError);
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
      data: {
        type: "incidents_search_results",
        attributes: { total: 9999, incidents: Array.from({ length: n }, (_, i) => ({ data: { id: `id${from + i}`, attributes: { public_id: from + i, title: `t${from + i}`, state, severity: "SEV-3", customer_impacted: false, created: "2026-10-28T08:00:00.000Z", modified: "2026-10-28T09:00:00.000Z" } } })) },
      },
      meta: { pagination: { offset: from, next_offset: nextOffset, size: n } },
    });

  it("follows next_offset through every incident page", async () => {
    const f = fake(incidentPage(0, 100, 100), incidentPage(100, 3, null));
    const list = await createDatadog(options(f)).incidents();
    expect(list).toHaveLength(103);
    expect(new URL(f.calls[1]!.url).searchParams.get("page[offset]")).toBe("100");
    expect(list.incomplete).toBeFalsy();
  });
  it("marks the incident list incomplete when the page cap is hit", async () => {
    const f = fake(...Array.from({ length: 10 }, (_, i) => incidentPage(i * 100, 100, (i + 1) * 100)));
    const list = await createDatadog(options(f)).incidents();
    expect(f.calls).toHaveLength(10);
    expect(list).toHaveLength(1000);
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

  const range = ["2026-10-29T10:00:00Z", "2026-10-29T10:15:00Z"] as const;

  it("normalises string timestamps and falls back for an invalid one", async () => {
    const odd = JSON.parse(JSON.stringify(errorTracking));
    odd.included[0].attributes.first_seen = "2025-10-01T02:00:00+02:00";
    odd.included[0].attributes.last_seen = "not a date";
    const issues = await createDatadog(options(fake(json(200, odd)))).errorTrackingIssues("", ...range);
    expect(issues[0]!.firstSeen).toBe("2025-10-01T00:00:00.000Z");
    expect(issues[0]!.lastSeen).toBe("2026-10-29T10:15:00Z");
  });
});
