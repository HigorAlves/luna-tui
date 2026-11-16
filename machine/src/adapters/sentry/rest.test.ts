import { describe, expect, it } from "vitest";

import { SentryAuthError, SentryError } from "../../application/sentry.ts";
import issues from "./fixtures/issues.json" with { type: "json" };
import { createSentry } from "./rest.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const link = (next: string | null) =>
  `<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
  `<https://sentry.io/api/0/organizations/acme/issues/?cursor=${next ?? "0:100:0"}>; rel="next"; results="${next === null ? "false" : "true"}"; cursor="${next ?? "0:100:0"}"`;

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
const options = (f: ReturnType<typeof fake>) => ({ token: "t", org: "acme", fetch: f.fetch, now: () => new Date("2026-11-16T10:00:00Z") });
const SINCE = "2026-11-15T10:00:00Z";
const empty = () => json(200, [], { Link: link(null) });
const queriesOf = (f: ReturnType<typeof fake>) => f.calls.map((c) => new URL(c.url).searchParams.get("query"));

describe("Sentry REST", () => {
  it("asks the org's issues endpoint for unresolved issues new, and again for escalating, since the window, with the bearer token and no boolean OR", async () => {
    const f = fake(json(200, issues, { Link: link(null) }), empty());
    await createSentry(options(f)).newOrEscalatingIssues(SINCE);
    const url = new URL(f.calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://sentry.io/api/0/organizations/acme/issues/");
    expect(queriesOf(f)).toEqual([`is:unresolved firstSeen:>=${SINCE}`, "is:unresolved is:escalating"]);
    expect(url.searchParams.get("start")).toBe("2026-11-15T10:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-11-16T10:00:00.000Z");
    expect(url.searchParams.get("sort")).toBe("date");
    expect(f.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer t" });
  });
  it("maps each issue to the fields incidents need", async () => {
    const list = await createSentry(options(fake(json(200, issues, { Link: link(null) }), empty()))).newOrEscalatingIssues(SINCE);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      id: "4501234567",
      shortId: "API-GATEWAY-3F",
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      culprit: "POST /v2/checkout",
      level: "error",
      status: "unresolved",
      count: 1342,
      userCount: 87,
      firstSeen: "2026-11-15T22:04:11.000Z",
      lastSeen: "2026-11-16T09:41:50.000Z",
      permalink: "https://sentry.io/organizations/acme/issues/4501234567/",
      project: "api-gateway",
    });
    expect(list[1]).toMatchObject({ level: "fatal", count: 12, project: "web" });
  });
  it("narrows to the configured projects by repeating each query per project", async () => {
    const f = fake(empty(), empty(), empty(), empty());
    await createSentry({ ...options(f), projects: ["web", "api-gateway"] }).newOrEscalatingIssues(SINCE);
    expect(queriesOf(f)).toEqual([
      `is:unresolved firstSeen:>=${SINCE} project:web`,
      `is:unresolved is:escalating project:web`,
      `is:unresolved firstSeen:>=${SINCE} project:api-gateway`,
      `is:unresolved is:escalating project:api-gateway`,
    ]);
  });
  it("merges the two queries by issue id: an issue both new and escalating appears once", async () => {
    const f = fake(json(200, [issues[0]], { Link: link(null) }), json(200, [issues[0], issues[1]], { Link: link(null) }));
    const list = await createSentry(options(f)).newOrEscalatingIssues(SINCE);
    expect(list.map((i) => i.shortId)).toEqual(["API-GATEWAY-3F", "WEB-9Z"]);
  });
  it("calls a self-hosted base url", async () => {
    const f = fake(empty(), empty());
    await createSentry({ ...options(f), url: "https://sentry.acme.internal/" }).newOrEscalatingIssues(SINCE);
    expect(f.calls[0]!.url).toMatch(/^https:\/\/sentry\.acme\.internal\/api\/0\/organizations\/acme\/issues\/\?/);
  });
  it("follows the Link header's next cursor while it has results", async () => {
    const f = fake(json(200, [issues[0]], { Link: link("0:100:0") }), json(200, [issues[1]], { Link: link(null) }), empty());
    const list = await createSentry(options(f)).newOrEscalatingIssues(SINCE);
    expect(list.map((i) => i.shortId)).toEqual(["API-GATEWAY-3F", "WEB-9Z"]);
    expect(f.calls).toHaveLength(3);
    expect(new URL(f.calls[1]!.url).searchParams.get("cursor")).toBe("0:100:0");
    expect(list.incomplete).toBeFalsy();
  });
  it("marks the list incomplete at the page cap", async () => {
    const f = fake(...Array.from({ length: 10 }, () => json(200, [issues[0]], { Link: link("0:100:0") })), empty());
    const list = await createSentry(options(f)).newOrEscalatingIssues(SINCE);
    expect(f.calls).toHaveLength(11);
    expect(list.incomplete).toBe(true);
  });
  it("a 401 says the token is wrong, a 403 that it lacks the scope", async () => {
    const e401 = await createSentry(options(fake(json(401, { detail: "Invalid token" })))).newOrEscalatingIssues(SINCE).catch((e: unknown) => e);
    expect(e401).toBeInstanceOf(SentryAuthError);
    expect((e401 as Error).message).toMatch(/rejected the token/);
    const e403 = await createSentry(options(fake(json(403, {})))).newOrEscalatingIssues(SINCE).catch((e: unknown) => e);
    expect(e403).toBeInstanceOf(SentryAuthError);
    expect((e403 as Error).message).toMatch(/event:read/);
  });
  it("a 429 says it is rate limited and when to retry", async () => {
    const error = await createSentry(options(fake(json(429, {}, { "Retry-After": "42" })))).newOrEscalatingIssues(SINCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SentryError);
    expect((error as SentryError).status).toBe(429);
    expect((error as Error).message).toMatch(/rate limited.*42s/);
  });
  it("other failures and non-JSON answers are SentryErrors", async () => {
    await expect(createSentry(options(fake(json(500, {})))).newOrEscalatingIssues(SINCE)).rejects.toMatchObject({ status: 500 });
    await expect(createSentry(options(fake(new Response("<html>", { status: 200 })))).newOrEscalatingIssues(SINCE)).rejects.toBeInstanceOf(SentryError);
  });
  it("a network failure is a SentryError naming the call", async () => {
    const fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof globalThis.fetch;
    await expect(createSentry({ token: "t", org: "acme", fetch }).newOrEscalatingIssues(SINCE)).rejects.toThrow(/ECONNRESET/);
  });
});
