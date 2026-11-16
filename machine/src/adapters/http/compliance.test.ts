// The tap routes of the manager's drafts: /compliance/drafts, /compliance/drafts/:id/approve|edit|ignore, /compliance/evidence/run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ComplianceDraft } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChangeEvidence } from "../../application/change-evidence.ts";
import { ComplianceDrafts, publisher } from "../../application/compliance-drafts.ts";
import type { GitHub } from "../../application/github.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { WikiError, type Wiki } from "../../application/wiki.ts";
import type { Incident } from "../../domain/incident.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

const auth = { authorization: "Bearer tok", "content-type": "application/json" };
const ID = "change_evidence:acme/web:2026-10";
const fields = (over: Partial<ComplianceDraft> = {}) => ({
  id: ID,
  kind: "change_evidence" as const,
  repo: "acme/web",
  title: "Change management, acme/web, 2026-10",
  period: "2026-10",
  summary: "0 PRs, 0 with exceptions",
  text: "# Page\n\nbody\n",
  targets: [{ kind: "wiki" as const, repo: "acme/web", path: "Compliance/Change-Management/2026-10.md" }],
  ...over,
});

let incidentList: Incident[] = [];
let wrote: unknown[][];
let wikiFails: string | null;
const mk = (wired = true) => {
  wrote = [];
  wikiFails = null;
  const stateDir = mkdtempSync(join(tmpdir(), "compliance-http-"));
  const drafts = new ComplianceDrafts({ stateDir });
  const wiki: Wiki = {
    readPages: async () => [],
    writePages: async (...args) => {
      if (wikiFails) throw new WikiError(wikiFails);
      wrote.push(args);
      return { sha: "s" };
    },
  };
  const github = { mergedPrs: vi.fn(async () => []), ruleBypasses: vi.fn(async () => []), prChecks: vi.fn(async () => []) } as unknown as GitHub;
  const evidence = new ChangeEvidence({ github, drafts, explain: async () => ({ explanations: [] }), repos: async () => ["acme/web"], stateDir });
  const access = {
    orgs: async () => ["acme"],
    buildQuarter: vi.fn(async (org: string) => drafts.open(fields({ id: `access_review:${org}:2026-Q4`, kind: "access_review", title: `Access review, ${org}, 2026-Q4`, period: "2026-Q4", targets: [{ kind: "access_slices", org, period: "2026-Q4" }] }))),
  };
  const compliance = wired ? { drafts, publisher: publisher({ drafts, wiki }), evidence, repos: async () => ["acme/web"], access, incidents: { list: async () => incidentList } } : undefined;
  const app = createApp({ db, pipeline: new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true }), bus: new Bus(), ...(compliance ? { compliance } : {}), access: { host: "127.0.0.1", port: 1, token: "tok" } });
  return { app, drafts };
};
const post = (app: ReturnType<typeof mk>["app"], id: string, action: string, body: unknown) => app.request(`/compliance/drafts/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

describe("the compliance routes", () => {
  it("sit behind the API token, and answer 503 when compliance is not wired", async () => {
    const { app } = mk();
    expect((await app.request("/compliance/drafts")).status).toBe(401);
    const off = mk(false).app;
    expect((await off.request("/compliance/drafts", { headers: auth })).status).toBe(503);
    expect((await post(off, ID, "approve", { hash: "0123456789abcdef" })).status).toBe(503);
    expect((await off.request("/compliance/evidence/run", { method: "POST", headers: auth, body: JSON.stringify({ repo: "acme/web", period: "2026-10" }) })).status).toBe(503);
  });

  it("list the incidents with their breach assessment and clocks, 503 when compliance is off", async () => {
    const { app } = mk();
    const incident: Incident = {
      id: "jira:OPS-9",
      title: "Export bucket public",
      severity: "high",
      status: "open",
      startedAt: "2026-11-10T09:00:00.000Z",
      resolvedAt: null,
      service: null,
      signals: [],
      timeline: [],
      breach: { error: "agents are off" },
    };
    incidentList = [incident];
    expect((await app.request("/compliance/incidents")).status).toBe(401);
    expect(await (await app.request("/compliance/incidents", { headers: auth })).json()).toEqual({ incidents: [incident] });
    expect((await mk(false).app.request("/compliance/incidents", { headers: auth })).status).toBe(503);
    incidentList = [];
  });

  it("list the drafts with the hash to send back with a tap", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    const body = (await (await app.request("/compliance/drafts", { headers: auth })).json()) as { drafts: ComplianceDraft[] };
    expect(body.drafts.map((x) => [x.id, x.hash])).toEqual([[ID, d.hash]]);
  });

  it("approve writes the page with the current hash, from an id with ':' and '/' percent-encoded", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    expect((await post(app, ID, "approve", { hash: "0123456789abcdef" })).status).toBe(409);
    expect(wrote).toEqual([]);
    const res = await post(app, ID, "approve", { hash: d.hash });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ComplianceDraft).status).toBe("posted");
    expect(wrote).toEqual([["acme/web", [{ path: "Compliance/Change-Management/2026-10.md", text: d.text }], "Change management evidence 2026-10"]]);
  });

  it("answers 200 with the error on the draft when the wiki refuses", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    wikiFails = "the wiki is disabled";
    const res = await post(app, ID, "approve", { hash: d.hash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "waiting", error: "the wiki is disabled" });
  });

  it("answers 404 for an unknown id and 400 for a bad body", async () => {
    const { app } = mk();
    expect((await post(app, "nope:x/y:z", "approve", { hash: "0123456789abcdef" })).status).toBe(404);
    expect((await post(app, ID, "approve", { hash: "short" })).status).toBe(400);
  });

  it("edit keeps the machine's text, and refuses a secret with a 422", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    expect((await post(app, ID, "edit", { hash: d.hash, text: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).status).toBe(422);
    const res = await post(app, ID, "edit", { hash: d.hash, text: "mine" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "edited", text: "mine", original: d.text });
  });

  it("ignore keeps the draft and refuses a stale hash", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    expect((await post(app, ID, "ignore", { hash: "0123456789abcdef" })).status).toBe(409);
    expect(await (await post(app, ID, "ignore", { hash: d.hash })).json()).toMatchObject({ status: "ignored" });
  });

  it("rebuild the current quarter's access review on demand for a known org only", async () => {
    const { app } = mk();
    const run = (body: unknown) => app.request("/compliance/access/run", { method: "POST", headers: auth, body: JSON.stringify(body) });
    const res = await run({ org: "acme" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "access_review:acme:2026-Q4", kind: "access_review", status: "waiting" });
    expect((await run({ org: "other" })).status).toBe(400);
    expect((await run({})).status).toBe(400);
    expect((await mk(false).app.request("/compliance/access/run", { method: "POST", headers: auth, body: JSON.stringify({ org: "acme" }) })).status).toBe(503);
  });

  it("rebuild a past month on demand for a known repo only", async () => {
    const { app } = mk();
    const run = (body: unknown) => app.request("/compliance/evidence/run", { method: "POST", headers: auth, body: JSON.stringify(body) });
    const res = await run({ repo: "acme/web", period: "2026-09" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "change_evidence:acme/web:2026-09", status: "waiting" });
    expect((await run({ repo: "acme/other", period: "2026-09" })).status).toBe(400);
    expect((await run({ repo: "acme/web", period: "2026-13" })).status).toBe(400);
  });
});
