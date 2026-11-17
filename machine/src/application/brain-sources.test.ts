import type { BrainClaim, DecisionRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { EventRow, TaskRow } from "../domain/task.ts";
import { type BrainSourceDeps, brainSources } from "./brain-sources.ts";

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return { id, title: `Task ${id}`, repoPath: "/work/luna", source: null, state: "implementing", updatedAt: new Date("2026-01-03T00:00:00.000Z"), ...over } as TaskRow;
}
const event = (kind: string, payload: Record<string, unknown>, at: string): EventRow => ({ id: "1", taskId: "t", stageRunId: null, kind, payload, at: new Date(at) });

function deps(over: Partial<BrainSourceDeps> = {}): BrainSourceDeps {
  return {
    tasks: async () => [],
    events: async () => [],
    planDetail: async () => undefined,
    retro: async () => null,
    repoSlug: (path) => `slug-of-${path.split("/").pop()}`,
    decisions: async () => [],
    claims: async () => [],
    viewerLogin: async () => null,
    context: async () => null,
    incidents: async () => [],
    regimes: async () => [],
    wikiPages: async () => null,
    ...over,
  };
}

const record = (id: string, at: string, truthAt?: string, over: Partial<DecisionRecord> = {}): DecisionRecord =>
  ({ schema: 1, id, pack: "ci_failure_class", at, answer: {}, context: {}, ...(truthAt ? { truth: { label: {}, source: "x", at: truthAt } } : {}), ...over }) as DecisionRecord;

describe("pullsOf", () => {
  const opened = event("stage.pr.opened", { url: "https://github.com/acme/shop/pull/7", number: 7 }, "2026-01-02T00:00:00Z");

  it("gives a merged pull request with the ship.merged time for a card that opened one and shipped it", async () => {
    const merged = event("ship.merged", { prUrl: "https://github.com/acme/shop/pull/7", number: 7 }, "2026-01-04T10:00:00Z");
    const pulls = await brainSources(deps({ events: async () => [opened, merged] })).pullsOf(task("a", { state: "closed" }));
    expect(pulls).toEqual([{ repo: "acme/shop", number: 7, title: "Task a", state: "merged", url: "https://github.com/acme/shop/pull/7", mergedAt: new Date("2026-01-04T10:00:00Z"), author: null, opened: true }]);
  });

  it("is open for a card still going, closed for a closed or archived card that never merged", async () => {
    const source = (state: TaskRow["state"]) => brainSources(deps({ events: async () => [opened] })).pullsOf(task("a", { state }));
    expect((await source("implementing"))[0]).toMatchObject({ state: "open", mergedAt: null });
    expect((await source("archived"))[0]).toMatchObject({ state: "closed" });
    expect((await source("closed"))[0]).toMatchObject({ state: "closed" });
  });

  it("still accepts the bare kind", async () => {
    const bare = event("pr.opened", { url: "https://github.com/acme/shop/pull/7", number: 7 }, "2026-01-02T00:00:00Z");
    expect((await brainSources(deps({ events: async () => [bare] })).pullsOf(task("a"))).map((p) => p.number)).toEqual([7]);
  });

  it("gives nothing for a card with neither event", async () => {
    expect(await brainSources(deps()).pullsOf(task("a"))).toEqual([]);
  });

  it("counts one pull request once when it was opened twice, and adds a PR task's own", async () => {
    const pr = task("p", { source: { kind: "github_pr", repo: "acme/shop", number: 9, url: "https://github.com/acme/shop/pull/9", headRef: "h", baseRef: "main" } });
    const both = await brainSources(deps({ events: async () => [opened, opened] })).pullsOf({ ...pr, source: pr.source });
    expect(both.map((p) => p.number).sort()).toEqual([7, 9]);
  });

  it("marks a pull the card opened, and one it only came from", async () => {
    const source = { kind: "github_pr" as const, repo: "acme/shop", number: 9, url: "https://github.com/acme/shop/pull/9", headRef: "h", baseRef: "main" };
    const pulls = await brainSources(deps({ events: async () => [opened] })).pullsOf(task("p", { source }));
    expect(pulls.map((p) => [p.number, p.opened]).sort()).toEqual([[7, true], [9, false]]);
    // a card that opened the very pull it came from owns it
    const same = event("stage.pr.opened", { url: source.url, number: 9 }, "2026-01-02T00:00:00Z");
    expect((await brainSources(deps({ events: async () => [same] })).pullsOf(task("p", { source })))[0]).toMatchObject({ number: 9, opened: true });
  });

  it("skips a pull request url it cannot read", async () => {
    const bad = event("stage.pr.opened", { url: "not a url", number: 1 }, "2026-01-02T00:00:00Z");
    expect(await brainSources(deps({ events: async () => [bad] })).pullsOf(task("a"))).toEqual([]);
  });
});

describe("componentsOf", () => {
  it("is empty when no code map was stored", async () => {
    expect(await brainSources(deps()).componentsOf(task("a"))).toEqual([]);
    expect(await brainSources(deps({ planDetail: async () => ({ map: "nonsense" }) })).componentsOf(task("a"))).toEqual([]);
  });
  it("gives the components of the stored map", async () => {
    expect(await brainSources(deps({ planDetail: async () => ({ map: { components: ["api", "board", 3] } }) })).componentsOf(task("a"))).toEqual(["api", "board"]);
  });
});

describe("tasks and repoOf", () => {
  it("keeps tasks updated at or after since, oldest first, and every task for null", async () => {
    const all = [task("new", { updatedAt: new Date("2026-03-01T00:00:00Z") }), task("old", { updatedAt: new Date("2026-01-01T00:00:00Z") })];
    const sources = brainSources(deps({ tasks: async () => all }));
    expect((await sources.tasks(null)).map((t) => t.id)).toEqual(["old", "new"]);
    expect((await sources.tasks(new Date("2026-03-01T00:00:00Z"))).map((t) => t.id)).toEqual(["new"]);
  });
  it("names a repository by the machine's slug and the folder's name", () => {
    expect(brainSources(deps()).repoOf("/work/luna")).toEqual({ slug: "slug-of-luna", name: "luna" });
  });
});

describe("verdicts", () => {
  it("skips a record with no truth and a private one, and takes those decided or learned since", async () => {
    const records = [record("none", "2026-02-01T00:00:00Z"), record("old", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"), record("late", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"), record("priv", "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z", { private: true })];
    const sources = brainSources(deps({ decisions: async () => records }));
    expect((await sources.verdicts(null)).map((r) => r.id)).toEqual(["old", "late"]);
    expect((await sources.verdicts(new Date("2026-02-01T00:00:00Z"))).map((r) => r.id)).toEqual(["late"]);
  });
  it("opens only the day folders of the last 45 days before its cursor, and every folder on a first run", async () => {
    const asked: Array<string | null> = [];
    const sources = brainSources(deps({ decisions: async (fromDay) => (asked.push(fromDay), []) }));
    await sources.verdicts(null);
    await sources.verdicts(new Date("2026-03-01T10:00:00Z"));
    expect(asked).toEqual([null, "2026-01-15"]);
  });
  it("caps one run at 2,000 records, oldest first", async () => {
    const many = Array.from({ length: 2_500 }, (_, i) => record(`r${i}`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()));
    const got = await brainSources(deps({ decisions: async () => many })).verdicts(null);
    expect(got).toHaveLength(2_000);
    expect(got[0]!.id).toBe("r0");
  });
});

describe("claims", () => {
  it("hands the cursor to the store and leaves out a refused claim", async () => {
    const asked: Array<Date | null> = [];
    const held = [{ id: "a", status: "unverified" }, { id: "b", status: "refused" }, { id: "c", status: "verified" }] as BrainClaim[];
    const sources = brainSources(deps({ claims: async (since) => (asked.push(since), held) }));
    const since = new Date("2026-02-01T00:00:00Z");
    expect((await sources.claims(since)).map((claim) => claim.id)).toEqual(["a", "c"]);
    expect(asked).toEqual([since]);
  });
});

describe("owner", () => {
  it("is the machine's GitHub login as the actor owner, and null when it is not known", async () => {
    expect(await brainSources(deps({ viewerLogin: async () => "higor" })).owner()).toEqual({ actor: "owner", login: "higor" });
    expect(await brainSources(deps({ viewerLogin: async () => null })).owner()).toBeNull();
    expect(await brainSources(deps({ viewerLogin: async () => { throw new Error("no token"); } })).owner()).toBeNull();
  });
});

describe("retroOf", () => {
  it("is null when the facts cannot be computed", async () => {
    const sources = brainSources(deps({ retro: async () => { throw new Error("x"); } }));
    expect(await sources.retroOf(task("a"))).toBeNull();
  });
});

describe("principlesOf", () => {
  it("is the project context's text, and null when there is none or the read fails", async () => {
    expect(await brainSources(deps({ context: async () => "## A\n- x\n" })).principlesOf("/work/luna")).toBe("## A\n- x\n");
    expect(await brainSources(deps({ context: async () => null })).principlesOf("/work/luna")).toBeNull();
    expect(await brainSources(deps({ context: async () => { throw new Error("git"); } })).principlesOf("/work/luna")).toBeNull();
  });
});

describe("regimesOf", () => {
  it("gives the repository's list, and null for a failure: a file that could not be read declares nothing either way", async () => {
    expect(await brainSources(deps({ regimes: async () => ["soc2"] })).regimesOf("/work/luna")).toEqual(["soc2"]);
    expect(await brainSources(deps({ regimes: async () => { throw new Error("yaml"); } })).regimesOf("/work/luna")).toBeNull();
  });
});

describe("wikiPagesOf", () => {
  it("reads the wiki once under Compliance/ and keeps the pages of the three folders it wants", async () => {
    const asked: string[] = [];
    const all = ["Compliance/Controls/x.md", "Compliance/Policies/x.md", "Compliance/Answers/x.md", "Compliance/Other/x.md", "Home.md"].map((path) => ({ path, text: "t" }));
    const pages = await brainSources(deps({ wikiPages: async (_path, prefix) => (asked.push(prefix), all) })).wikiPagesOf("/work/luna");
    expect(asked).toEqual(["Compliance/"]);
    expect(pages?.map((page) => page.path)).toEqual(["Compliance/Controls/x.md", "Compliance/Policies/x.md", "Compliance/Answers/x.md"]);
  });

  it("is null when the repository has no known slug, or the read throws", async () => {
    expect(await brainSources(deps({ wikiPages: async () => null })).wikiPagesOf("/work/luna")).toBeNull();
    expect(await brainSources(deps({ wikiPages: async () => Promise.reject(new Error("net")) })).wikiPagesOf("/work/luna")).toBeNull();
  });
});

describe("incidents", () => {
  it("passes the stored incidents through", async () => {
    expect(await brainSources(deps({ incidents: async () => [] })).incidents()).toEqual([]);
  });
});
