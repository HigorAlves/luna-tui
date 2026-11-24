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
/** A whole draft, as the store answers it: what a job's fake returns, so the answer fits the route's documented schema. */
const draftOf = (over: Partial<ComplianceDraft> = {}): ComplianceDraft => ({ ...fields(), status: "waiting", hash: "0123456789abcdef", history: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", ...over });

let incidentList: Incident[] = [];
let wrote: unknown[][];
let wikiFails: string | null;
const mk = (wired = true, questionnaires?: { rerun: (id: string, repo: string) => Promise<ComplianceDraft> }, vulns?: { list(): Promise<unknown[]> }, releaseNotes?: { draft(input: unknown): Promise<unknown> }, status?: { build(week: string): Promise<unknown> }) => {
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
  const compliance = wired ? { drafts, publisher: publisher({ drafts, wiki }), evidence, repos: async () => ["acme/web"], access, incidents: { list: async () => incidentList }, ...(questionnaires ? { questionnaires } : {}), ...(vulns ? { vulns: vulns as never } : {}), ...(releaseNotes ? { releaseNotes: releaseNotes as never } : {}), ...(status ? { status: status as never } : {}) } : undefined;
  const app = createApp({ db, pipeline: new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true }), bus: new Bus(), ...(compliance ? { compliance } : {}), access: { host: "127.0.0.1", port: 1, token: "tok" } });
  return { app, drafts };
};
const post = (app: ReturnType<typeof mk>["app"], id: string, action: string, body: unknown) => app.request(`/compliance/drafts/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

describe("the questionnaire routes", () => {
  const repoPost = (app: ReturnType<typeof mk>["app"], id: string, body: unknown) => app.request(`/compliance/drafts/${encodeURIComponent(id)}/repo`, { method: "POST", headers: auth, body: JSON.stringify(body) });

  it("list the repositories the machine knows", async () => {
    const { app } = mk();
    expect(await (await app.request("/compliance/repos", { headers: auth })).json()).toEqual({ repos: ["acme/web"] });
    expect((await mk(false).app.request("/compliance/repos", { headers: auth })).status).toBe(503);
  });

  it("re-run a questionnaire draft against another known repository and answer with the reopened draft", async () => {
    const rerun = vi.fn(async (id: string, repo: string) => draftOf({ id, kind: "questionnaire", repo, period: null }));
    const { app } = mk(true, { rerun });
    const res = await repoPost(app, "questionnaire:slack:C0123ABCD:1.0", { repo: "acme/web" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "questionnaire:slack:C0123ABCD:1.0", repo: "acme/web" });
    expect(rerun).toHaveBeenCalledWith("questionnaire:slack:C0123ABCD:1.0", "acme/web");
  });

  it("refuse an unknown repository with 400, a posting or posted draft with 409, and a missing draft with 404", async () => {
    const { DraftNotFoundError, DraftStatusError } = await import("../../application/compliance-drafts.ts");
    const rerun = vi.fn(async (id: string) => {
      if (id === "posted") throw new DraftStatusError(id, "posted");
      throw new DraftNotFoundError(id);
    });
    const { app } = mk(true, { rerun });
    expect((await repoPost(app, "x", { repo: "acme/other" })).status).toBe(400);
    expect((await repoPost(app, "posted", { repo: "acme/web" })).status).toBe(409);
    expect((await repoPost(app, "gone", { repo: "acme/web" })).status).toBe(404);
    expect((await repoPost(app, "x", { repo: "nope" })).status).toBe(400);
    expect((await mk(true).app.request("/compliance/drafts/x/repo", { method: "POST", headers: auth, body: JSON.stringify({ repo: "acme/web" }) })).status).toBe(503);
  });
});

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

  it("answers a stale hash with stale_draft and a draft that is not waiting with draft_not_waiting, so a board can tell them apart", async () => {
    const { app, drafts } = mk();
    const d = await drafts.open(fields());
    const stale = await post(app, ID, "ignore", { hash: "0123456789abcdef" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_draft" });
    await drafts.claim(ID, d.hash);
    const busy = await post(app, ID, "ignore", { hash: d.hash });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "draft_not_waiting" });
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

  it("list the vulnerability alerts the cards stand for, behind the token, and answer 503 without the job", async () => {
    const rows = [{ repo: "acme/web", key: "dependabot:7", severity: "high", lane: "fast", deadline: "2026-12-01", cardId: "c1", overdue: false }];
    const { app } = mk(true, undefined, { list: async () => rows });
    expect((await app.request("/compliance/vulns")).status).toBe(401);
    const res = await app.request("/compliance/vulns", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alerts: rows });
    expect((await mk().app.request("/compliance/vulns", { headers: auth })).status).toBe(503);
    expect((await mk(false).app.request("/compliance/vulns", { headers: auth })).status).toBe(503);
  });

  it("draft release notes for a known repo and tag, and refuse an unknown repo, a bad tag or a missing job", async () => {
    const draft = vi.fn(async (_input: unknown) => draftOf({ id: "release_notes:acme/web:v1.4.0", kind: "release_notes" }));
    const { app } = mk(true, undefined, undefined, { draft });
    const run = (body: unknown, target = app) => target.request("/compliance/release-notes", { method: "POST", headers: auth, body: JSON.stringify(body) });
    expect((await app.request("/compliance/release-notes", { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await run({ repo: "acme/web", tag: "v1.4.0", since: "2026-10-01T00:00:00Z" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(draftOf({ id: "release_notes:acme/web:v1.4.0", kind: "release_notes" }));
    expect(draft).toHaveBeenCalledWith({ repo: "acme/web", tag: "v1.4.0", since: "2026-10-01T00:00:00Z" });
    await run({ repo: "acme/web", tag: "v1.5.0" });
    expect(draft).toHaveBeenLastCalledWith({ repo: "acme/web", tag: "v1.5.0" });
    expect((await run({ repo: "acme/other", tag: "v1" })).status).toBe(400);
    expect((await run({ repo: "acme/web", tag: "v 1" })).status).toBe(400);
    expect((await run({ repo: "acme/web", tag: "v1", since: "last week" })).status).toBe(400);
    expect(draft).toHaveBeenCalledTimes(2);
    expect((await run({ repo: "acme/web", tag: "v1" }, mk().app)).status).toBe(503);
  });
});

describe("the status report route", () => {
  const run = (app: ReturnType<typeof mk>["app"], body: unknown) => app.request("/compliance/status/run", { method: "POST", headers: auth, body: JSON.stringify(body) });

  it("builds the named week on demand, and the previous week when none is named", async () => {
    const build = vi.fn(async (week: string) => draftOf({ id: `status_report:${week}`, kind: "status_report", period: week }));
    const { app } = mk(true, undefined, undefined, undefined, { build });
    const res = await run(app, { week: "2026-W46" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "status_report:2026-W46" });
    expect(build).toHaveBeenCalledWith("2026-W46");
    expect((await run(app, {})).status).toBe(200);
    expect(build).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-W\d{2}$/));
  });

  it("refuses a week that is not an ISO week, and answers 503 without the job", async () => {
    const { app } = mk(true, undefined, undefined, undefined, { build: async (week: string) => draftOf({ id: `status_report:${week}`, kind: "status_report", period: week }) });
    expect((await run(app, { week: "2026-46" })).status).toBe(400);
    expect((await run(app, { week: "2026-W54" })).status).toBe(400);
    expect((await run(mk().app, {})).status).toBe(503);
    expect((await run(mk(false).app, {})).status).toBe(503);
  });
});
