import { describe, expect, it } from "vitest";

import { DatadogAuthError, DatadogError } from "../../application/datadog.ts";
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
    expect(f.calls[0]!.url).toMatch(/^https:\/\/api\.datadoghq\.eu\/api\/v2\/incidents\?/);
    expect(f.calls[0]!.init.headers).toMatchObject({ "DD-API-KEY": "k", "DD-APPLICATION-KEY": "a" });
  });
  it("keeps unresolved incidents and reads either severity shape", async () => {
    const list = await createDatadog(options(fake(json(200, incidents)))).incidents();
    expect(list.map((i) => [i.publicId, i.state, i.severity])).toEqual([[812, "active", "SEV-2"], [813, "stable", "SEV-4"]]);
  });
  it("waits out one 429, then gives up on the second", async () => {
    const slept: number[] = [];
    const f = fake(json(429, {}, { "X-RateLimit-Reset": "3" }), json(429, {}, { "X-RateLimit-Reset": "3" }));
    await expect(createDatadog(options(f, slept)).incidents()).rejects.toMatchObject({ status: 429 });
    expect(slept).toEqual([3000]);
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
});
