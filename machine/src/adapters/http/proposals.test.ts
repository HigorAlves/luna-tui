import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Pipeline } from "../../application/pipeline.ts";
import type { RepoSignals } from "../../application/repo-signals.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

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

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as const;
const row = (engine: string, effort: string, quality: number, costPerCase: number) => ({ engine, effort, n: 5, quality, costPerCase, at: "2026-11-01" });
const candidates = { plan: [row("claude:opus", "high", 0.67, 1), row("codex:sol", "high", 0.83, 1.2)] };

describe("POST /repos/proposals", () => {
  const pipeline = () => new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn });
  const known: string[] = [];
  const knownRepos = async () => known;
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "proposals-"));
    writeFileSync(join(dir, "luna.yaml"), "engines:\n  plan: claude:opus\n");
    known.push(dir);
    return dir;
  };

  it("reads a repo given with a trailing slash as the repo without it", async () => {
    const p = pipeline();
    const asked: string[] = [];
    const repoSignals: RepoSignals = {
      forRepo: async (r) => {
        asked.push(r);
        return { plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } };
      },
    };
    const app = createApp({ db, pipeline: p, bus: new Bus(), repoSignals, knownRepos });
    const dir = repo();
    const res = await app.request("/repos/proposals", post({ repo: `${dir}/`, candidates }));
    const out = (await res.json()) as { taskId: string | null };
    expect(asked).toEqual([dir]);
    expect(out.taskId).toEqual(expect.any(String));
    expect(await p.get(out.taskId!)).toMatchObject({ repoPath: dir });
  });

  it("answers 404 unknown_repo to a repo the machine does not know, and makes no card", async () => {
    const p = pipeline();
    const repoSignals: RepoSignals = { forRepo: async () => ({ plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } }) };
    const app = createApp({ db, pipeline: p, bus: new Bus(), repoSignals, knownRepos });
    const stranger = mkdtempSync(join(tmpdir(), "stranger-"));
    const res = await app.request("/repos/proposals", post({ repo: stranger, candidates }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_repo" });
    expect((await p.list()).filter((t) => t.route === "config")).toEqual([]);
  });

  it("proposes nothing while no signals are backed (the no-op port), and creates no card", async () => {
    const p = pipeline();
    const app = createApp({ db, pipeline: p, bus: new Bus(), knownRepos });
    const res = await app.request("/repos/proposals", post({ repo: repo(), candidates }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changes: [], taskId: null });
    expect((await p.list()).filter((t) => t.route === "config")).toEqual([]);
  });

  it("runs the rule over the repo's signals and puts a non-empty result on a card", async () => {
    const p = pipeline();
    const asked: Array<[string, Date]> = [];
    const repoSignals: RepoSignals = {
      forRepo: async (repo, since) => {
        asked.push([repo, since]);
        return { plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } };
      },
    };
    const app = createApp({ db, pipeline: p, bus: new Bus(), repoSignals, knownRepos });
    const dir = repo();
    const res = await app.request("/repos/proposals", post({ repo: dir, candidates, now: "2026-11-16T12:00:00.000Z" }));
    const out = (await res.json()) as { changes: Array<{ pack: string; engine: { to: string } }>; taskId: string | null };
    expect(out.changes).toMatchObject([{ pack: "plan", engine: { from: "claude:opus", to: "codex:sol" } }]);
    expect(out.taskId).toEqual(expect.any(String));
    expect(asked).toEqual([[dir, new Date("2026-10-17T12:00:00.000Z")]]);
    const task = await p.get(out.taskId!);
    expect(task).toMatchObject({ route: "config", state: "awaiting_setup" });
  });

  it("says which pack it skipped because no engine ran most of its runs", async () => {
    const repoSignals: RepoSignals = { forRepo: async () => ({ plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3, engines: { "claude:opus": 7, "codex:sol": 5 } } }) };
    const app = createApp({ db, pipeline: pipeline(), bus: new Bus(), repoSignals, knownRepos });
    const res = await app.request("/repos/proposals", post({ repo: repo(), candidates }));
    expect(await res.json()).toEqual({ changes: [], taskId: null, skipped: [{ pack: "plan", reason: "plan ran on mixed engines: claude:opus 7 of 12 runs, under 80%" }] });
  });

  it("does not propose again what the person declined", async () => {
    const p = pipeline();
    const repoSignals: RepoSignals = { forRepo: async () => ({ plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } }) };
    const app = createApp({ db, pipeline: p, bus: new Bus(), repoSignals, knownRepos });
    const dir = repo();
    const first = (await (await app.request("/repos/proposals", post({ repo: dir, candidates }))).json()) as { taskId: string };
    await p.decide(first.taskId, "rejected");
    expect(await (await app.request("/repos/proposals", post({ repo: dir, candidates }))).json()).toEqual({ changes: [], taskId: null });
  });

  it("answers 409 config_changed when approving a card whose file was edited into something the changes do not fit", async () => {
    const p = pipeline();
    const repoSignals: RepoSignals = { forRepo: async () => ({ plan: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } }) };
    const app = createApp({ db, pipeline: p, bus: new Bus(), repoSignals, knownRepos });
    const dir = repo();
    const made = (await (await app.request("/repos/proposals", post({ repo: dir, candidates }))).json()) as { taskId: string };
    writeFileSync(join(dir, "luna.yaml"), "engines: [broken\n");
    const res = await app.request(`/tasks/${made.taskId}/decision`, post({ decision: "approved" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "config_changed" });
  });

  it("answers 400 to a body without a repo or with a bad candidate", async () => {
    const app = createApp({ db, pipeline: pipeline(), bus: new Bus(), knownRepos });
    expect((await app.request("/repos/proposals", post({ candidates }))).status).toBe(400);
    expect((await app.request("/repos/proposals", post({ repo: "/r", candidates: { plan: [{ engine: "nope" }] } }))).status).toBe(400);
  });
});
