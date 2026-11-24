import { type EconomyConfig, type EconomyStatus, type Metrics, type PackId } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Economy, noEconomy } from "../../application/economy.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;
beforeAll(async () => {
  db = await freshTestDatabase();
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, hasConfig: () => true, maxConcurrentTasks: 2 });
});
afterAll(async () => {
  await db.destroy();
});

const config = { guard: { envelope_min_samples: 3 } } as EconomyConfig;
const status = (over: Partial<EconomyStatus> = {}): EconomyStatus => ({ envelopes: {}, guard: [], cost: { exec: 0, overhead: 0, overheadShare: 0, overheadUnpriced: 0 }, ...over });

/** An economy that remembers what it was asked. */
function spy(shown: EconomyStatus = status()) {
  const calls: unknown[][] = [];
  const port: Economy = {
    ...noEconomy(),
    status: async (...args) => (calls.push(["status", ...args]), shown),
    dropFact: async (...args) => (calls.push(["drop", ...args]), args[1] === "f1"),
    approveMask: async (...args) => (calls.push(["approve", ...args]), args[1] === "triage"),
    restore: async (...args) => (calls.push(["restore", ...args]), args[2] === "web"),
    importRuns: async (...args) => (calls.push(["import", args[0]]), 7),
  };
  return { calls, port };
}
const appOf = (port: Economy, known = ["/a/shop", "/a/api"]) => createApp({ db, pipeline, bus: new Bus(), economy: { port, knownRepos: async () => known, configOf: async () => config } });
const post = (app: ReturnType<typeof appOf>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /economy", () => {
  it("gives the repository's status, counting envelopes from its own guard minimum", async () => {
    const { calls, port } = spy(status({ envelopes: { implementing: { samples: 4, envelope: 12 } } }));
    const res = await appOf(port).request("/economy?repo=/a/shop");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status({ envelopes: { implementing: { samples: 4, envelope: 12 } } }));
    expect(calls).toEqual([["status", "/a/shop", 3]]);
  });

  it("is a 400 for a repository the machine does not know, a relative path, and no repo", async () => {
    const app = appOf(spy().port);
    for (const query of ["?repo=/b/other", "?repo=shop", ""]) expect((await app.request(`/economy${query}`)).status).toBe(400);
  });
});

describe("POST /economy/facts/:id/drop", () => {
  it("drops a fact and says whether the repository held it", async () => {
    const { calls, port } = spy();
    const app = appOf(port);
    const res = await post(app, "/economy/facts/f1/drop", { repo: "/a/shop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dropped: true });
    expect(await (await post(app, "/economy/facts/nope/drop", { repo: "/a/shop" })).json()).toEqual({ dropped: false });
    expect(calls[0]).toEqual(["drop", "/a/shop", "f1"]);
  });

  it("is a 400 for an unknown repository, a relative path, and a body that is not JSON", async () => {
    const app = appOf(spy().port);
    expect((await post(app, "/economy/facts/f1/drop", { repo: "/b/other" })).status).toBe(400);
    expect((await post(app, "/economy/facts/f1/drop", { repo: "shop" })).status).toBe(400);
    expect((await post(app, "/economy/facts/f1/drop", {})).status).toBe(400);
  });
});

describe("POST /economy/mask/approve and /restore", () => {
  it("approves the tools proposed for a pack", async () => {
    const { calls, port } = spy();
    const app = appOf(port);
    expect(await (await post(app, "/economy/mask/approve", { repo: "/a/shop", pack: "triage" })).json()).toEqual({ approved: true });
    expect(await (await post(app, "/economy/mask/approve", { repo: "/a/shop", pack: "verifying" })).json()).toEqual({ approved: false });
    expect(calls[0]).toEqual(["approve", "/a/shop", "triage"]);
  });

  it("brings a unit back", async () => {
    const { calls, port } = spy();
    const app = appOf(port);
    expect(await (await post(app, "/economy/mask/restore", { repo: "/a/shop", pack: "triage", unit: "web" })).json()).toEqual({ restored: true });
    expect(await (await post(app, "/economy/mask/restore", { repo: "/a/shop", pack: "triage", unit: "agent" })).json()).toEqual({ restored: false });
    expect(calls[0]).toEqual(["restore", "/a/shop", "triage", "web"]);
  });

  it("is a 400 for a pack that does not exist, a missing unit, and an unknown repository", async () => {
    const app = appOf(spy().port);
    const bad = "not_a_pack" as PackId;
    expect((await post(app, "/economy/mask/approve", { repo: "/a/shop", pack: bad })).status).toBe(400);
    expect((await post(app, "/economy/mask/restore", { repo: "/a/shop", pack: "triage" })).status).toBe(400);
    expect((await post(app, "/economy/mask/approve", { repo: "/b/other", pack: "triage" })).status).toBe(400);
  });
});

describe("POST /economy/import", () => {
  it("folds the repository's past runs and says how many", async () => {
    const { calls, port } = spy();
    const res = await post(appOf(port), "/economy/import", { repo: "/a/shop" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: 7 });
    expect(calls).toEqual([["import", "/a/shop"]]);
  });

  it("is a 400 for an unknown repository", async () => {
    expect((await post(appOf(spy().port), "/economy/import", { repo: "/b/other" })).status).toBe(400);
  });
});

describe("the routes without an economy", () => {
  it("are absent", async () => {
    const app = createApp({ db, pipeline, bus: new Bus() });
    expect((await app.request("/economy?repo=/a/shop")).status).toBe(404);
    expect((await post(app as never, "/economy/import", { repo: "/a/shop" })).status).toBe(404);
    expect((await post(app as never, "/economy/mask/approve", { repo: "/a/shop", pack: "triage" })).status).toBe(404);
  });
});

describe("GET /metrics economy", () => {
  const shown = status({
    cost: { exec: 900, overhead: 100, overheadShare: 0.1, overheadUnpriced: 2 },
    guard: [
      { action: "redirect", calls: 3, at: "t", runId: "r1", pack: "implementing" },
      { action: "stop", calls: 9, at: "t", runId: "r2", pack: "implementing" },
      { action: "gate", calls: 1, at: "t", runId: "r3", pack: "implementing" },
    ],
    facts: [
      { id: "a", family: "f", source: "free", state: "active", text: "t", confirmations: 3, contradictions: 0, exercised: 1, fired: 1 },
      { id: "b", family: "f", source: "free", state: "promoted", text: "t", confirmations: 3, contradictions: 0, exercised: 1, fired: 1 },
      { id: "c", family: "f", source: "free", state: "candidate", text: "t", confirmations: 1, contradictions: 0, exercised: 0, fired: 0 },
    ],
    tools: { triage: { mask: ["web", "agent"], proposal: [] } },
  });

  it("is the selected repository's economy", async () => {
    const res = await appOf(spy(shown).port).request("/metrics?repo=/a/shop");
    const metrics = (await res.json()) as Metrics;
    expect(metrics.economy).toEqual({ effective: { exec: 900, overhead: 100 }, overheadShare: 0.1, overheadUnpriced: 2, guard: { redirects: 1, stops: 1 }, facts: { active: 1, promoted: 1 }, masked: 2 });
  });

  it("is the sum over the known repositories when none is selected", async () => {
    const metrics = (await (await appOf(spy(shown).port).request("/metrics")).json()) as Metrics;
    expect(metrics.economy).toEqual({ effective: { exec: 1800, overhead: 200 }, overheadShare: 0.1, overheadUnpriced: 4, guard: { redirects: 2, stops: 2 }, facts: { active: 2, promoted: 2 }, masked: 4 });
  });

  it("leaves the economy out for a repository the machine does not know, and reads nothing for it", async () => {
    const { calls, port } = spy(shown);
    const configured: string[] = [];
    const app = createApp({ db, pipeline, bus: new Bus(), economy: { port, knownRepos: async () => ["/a/shop"], configOf: async (repo) => (configured.push(repo), config) } });
    const res = await app.request("/metrics?repo=/etc/somewhere");
    expect(res.status).toBe(200);
    const metrics = (await res.json()) as Metrics;
    expect(metrics.economy).toBeUndefined();
    expect(metrics.budget).toBeDefined();
    expect(calls).toEqual([]);
    expect(configured).toEqual([]);
    expect(((await (await app.request("/metrics?repo=/a/shop")).json()) as Metrics).economy).toBeDefined();
  });

  it("is absent without an economy, and for the tasks with no repository", async () => {
    const without = (await (await createApp({ db, pipeline, bus: new Bus() }).request("/metrics")).json()) as Metrics;
    expect(without.economy).toBeUndefined();
    const none = (await (await appOf(spy(shown).port).request("/metrics?repo=")).json()) as Metrics;
    expect(none.economy).toBeUndefined();
  });
});
