import type { BrainClaim, BrainEdgeName, BrainRow, DecisionRecord } from "@hardness/contracts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Incident } from "../domain/incident.ts";
import type { TaskRow } from "../domain/task.ts";
import type { BrainPull, RetroFacts } from "../domain/brain/rows.ts";
import { brainJournal } from "../adapters/fs/brain-state.ts";
import { BrainError, noBrain, type Brain, type BrainAnswer } from "./brain.ts";
import { brainProjector, projectAfterClose, type BrainJournal, type BrainSources, type BrainState, type ProjectionResult } from "./brain-projector.ts";

const repo = { slug: "luna-ab12", name: "luna" };

function task(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    criteria: [],
    repoPath: "/work/luna",
    source: null,
    route: "feature",
    state: "implementing",
    retries: { verify: 0, e2e: 0, ci: 0, total: 0, stronger: 0 },
    diffAdded: null,
    diffRemoved: null,
    jira: null,
    stateSince: null,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    ...over,
  } as TaskRow;
}

const jira = (key: string) => ({ key, url: `https://jira.example/${key}` }) as TaskRow["jira"];

/** A brain that records what it is asked. `failLoad` makes the nth load throw. */
function fakeBrain(options: { failLoad?: number; failUnlink?: boolean; failRemove?: boolean; hygiene?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const loads: BrainRow[][] = [];
  const actors: Array<string | undefined> = [];
  const unlinks: Array<{ edge: BrainEdgeName; from: string; to?: string }> = [];
  const removed: Array<{ type: string; slug: string }> = [];
  let n = 0;
  const brain: Brain = {
    enabled: true,
    health: async () => ({ ok: true, version: "x", note: null }),
    load: async (rows, loadOptions) => {
      n += 1;
      if (n === options.failLoad) throw new BrainError("refused", "load_refused", 422);
      calls.push("load");
      loads.push(rows);
      actors.push(loadOptions?.actor);
      return { entities: rows.length, commit: "c" };
    },
    query: async (name): Promise<BrainAnswer> => ({ rows: Array.from({ length: options.hygiene?.[name] ?? 0 }, () => ({ x: 1 })), note: null }),
    unlink: async (edge, from, to) => {
      if (options.failUnlink) throw new BrainError("refused", "unlink_refused", 422);
      calls.push("unlink");
      unlinks.push({ edge, from, to });
      return 1;
    },
    remove: async (nodes) => {
      if (options.failRemove) throw new BrainError("refused", "remove_refused", 422);
      calls.push("remove");
      removed.push(...nodes);
      return nodes.length;
    },
    reset: async () => {
      calls.push("reset");
    },
  };
  return { brain, calls, loads, actors, unlinks, removed };
}

function memoryJournal(start?: BrainState) {
  const state = { current: start ?? { cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [] } as BrainState, writes: 0, dropped: 0 };
  const journal: BrainJournal = {
    read: async () => structuredClone(state.current),
    write: async (next, options) => {
      state.writes += 1;
      if (options?.dropPrevious) state.dropped += 1;
      state.current = structuredClone(next);
    },
  };
  return { journal, state };
}

function sources(tasks: TaskRow[], over: Partial<BrainSources> = {}): BrainSources {
  return {
    tasks: async () => tasks,
    repoOf: () => repo,
    retroOf: async () => null as RetroFacts | null,
    pullsOf: async () => [] as BrainPull[],
    componentsOf: async () => [],
    verdicts: async () => [] as DecisionRecord[],
    claims: async () => [] as BrainClaim[],
    owner: async () => null,
    principlesOf: async () => null,
    incidents: async () => [],
    regimesOf: async () => [],
    wikiPagesOf: async () => null,
    ...over,
  };
}

const slugsOf = (rows: BrainRow[]) => rows.filter((row) => "type" in row).map((row) => ("type" in row ? String(row.data.slug) : ""));

describe("brainProjector.run", () => {
  it("does nothing and reads nothing with the brain off", async () => {
    const failing = async () => {
      throw new Error("read");
    };
    const projector = brainProjector({ brain: noBrain(), sources: sources([], { tasks: failing }), journal: { read: failing, write: failing } });
    const result = await projector.run();
    expect(result.note).toBe("the brain is off");
    expect(result.loaded).toBe(0);
  });

  it("loads nothing on a second run over unchanged records, and counts the rows skipped", async () => {
    const { brain, loads, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    const projector = brainProjector({ brain, sources: sources([task("a", { jira: jira("LUN-1") })]), journal });
    const first = await projector.run();
    expect(first.loaded).toBeGreaterThan(0);
    const before = loads.length;
    const second = await projector.run();
    expect(loads.length).toBe(before);
    expect(unlinks).toEqual([]);
    expect(second.loaded).toBe(0);
    expect(second.skipped).toBe(first.loaded);
    expect(second.note).toBeNull();
  });

  it("loads only the card whose title changed", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    // The Ticket row carries the card's title too, so a card with no ticket isolates the Card row.
    let tasks = [task("a"), task("b")];
    const projector = brainProjector({ brain, sources: sources([], { tasks: async () => tasks }), journal });
    await projector.run();
    loads.length = 0;
    tasks = [task("a", { title: "A new title" }), task("b")];
    await projector.run();
    expect(loads.flat().map((row) => ("type" in row ? `${row.type}:${row.data.slug}` : row.edge))).toEqual(["Card:card:a"]);
  });

  it("removes the old ticket edge before the load that carries the new one", async () => {
    const { brain, calls, unlinks } = fakeBrain();
    const { journal, state } = memoryJournal();
    let tasks = [task("a", { jira: jira("LUN-1") })];
    const projector = brainProjector({ brain, sources: sources([], { tasks: async () => tasks }), journal });
    await projector.run();
    calls.length = 0;
    tasks = [task("a", { jira: jira("LUN-2") })];
    const result = await projector.run();
    expect(unlinks).toEqual([{ edge: "CardForTicket", from: "card:a", to: "ticket:jira/LUN-1" }]);
    expect(calls).toEqual(["unlink", "load"]);
    expect(result.unlinked).toBe(1);
    const forTicket = state.current.edges.filter((edge) => edge.edge === "CardForTicket");
    expect(forTicket).toEqual([{ edge: "CardForTicket", from: "card:a", to: "ticket:jira/LUN-2" }]);
  });

  it("keeps the first batch in the journal and holds the cursor when the second batch fails", async () => {
    const { brain, loads } = fakeBrain({ failLoad: 2 });
    const { journal, state } = memoryJournal();
    // A card with a ticket: Ticket loads before Card (the card's edge points at it), so two node types make two batches only when limits split them;
    // use enough cards to split on the per-key limit instead.
    const many = Array.from({ length: 8_193 }, (_, i) => task(`t${i}`));
    const projector = brainProjector({ brain, sources: sources(many), journal });
    const result = await projector.run();
    expect(result.note).toContain("load_refused");
    expect(result.note).not.toContain("tok");
    expect(state.current.cursor.tasks).toBeNull();
    expect(Object.keys(state.current.nodes).length).toBe(loads[0]!.filter((row) => "type" in row).length);
    expect(Object.keys(state.current.nodes).length).toBeGreaterThan(0);

    const healthy = fakeBrain();
    const again = await brainProjector({ brain: healthy.brain, sources: sources(many), journal }).run();
    const rowsAgain = healthy.loads.flat().filter((row) => "type" in row && row.type === "Card").length;
    expect(rowsAgain).toBe(8_193 - loads[0]!.filter((row) => "type" in row && row.type === "Card").length);
    expect(again.note).toBeNull();
    expect(state.current.cursor.tasks).not.toBeNull();
  });

  it("skips a task whose sources throw, logs it, lands the others and holds the cursor", async () => {
    const { brain, loads } = fakeBrain();
    const { journal, state } = memoryJournal();
    const lines: string[] = [];
    const projector = brainProjector({
      brain,
      sources: sources([task("a"), task("bad"), task("c")], {
        pullsOf: async (t) => {
          if (t.id === "bad") throw new Error("boom");
          return [];
        },
      }),
      journal,
      log: (line) => lines.push(line),
    });
    const result = await projector.run();
    expect(result.tasks).toBe(2);
    expect(slugsOf(loads.flat())).toEqual(expect.arrayContaining(["card:a", "card:c"]));
    expect(slugsOf(loads.flat())).not.toContain("card:bad");
    expect(lines.some((line) => line.includes("bad"))).toBe(true);
    expect(state.current.cursor.tasks).toBeNull();
  });

  it("moves the cursor to the newest task and verdict time when everything landed", async () => {
    const { brain } = fakeBrain();
    const { journal, state } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a"), task("b", { updatedAt: new Date("2026-02-01T00:00:00.000Z") })]), journal }).run();
    expect(state.current.cursor.tasks).toBe("2026-02-01T00:00:00.000Z");
  });

  it("never builds a card again once the brain holds it as ended: its history may be pruned by then", async () => {
    const { brain, loads, unlinks } = fakeBrain();
    const { journal, state } = memoryJournal();
    const closed = task("a", { state: "closed", diffAdded: 40, diffRemoved: 2, updatedAt: new Date("2026-02-01T00:00:00.000Z") });
    const retro = { predicted: { size: "M", risk: "low", estLoc: 300 }, actual: { added: 40, removed: 2, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 0, format: null, durationMin: null }, runs: 3 } as RetroFacts;
    await brainProjector({ brain, sources: sources([closed], { retroOf: async () => retro, componentsOf: async () => ["Stage Runner"] }), journal }).run();
    expect(state.current.nodes["card:a"]!.data).toMatchObject({ state: "closed", est_loc: 300, retries: 1 });
    const before = loads.length;
    // Later the task is touched again, and the pruned history gives no retro and no components.
    const touchedAgain = { ...closed, title: "renamed", updatedAt: new Date("2026-09-01T00:00:00.000Z") };
    const result = await brainProjector({ brain, sources: sources([touchedAgain]), journal }).run();
    expect(loads).toHaveLength(before);
    expect(unlinks).toEqual([]);
    expect(result.tasks).toBe(0);
    expect(state.current.nodes["card:a"]!.data).toMatchObject({ est_loc: 300, retries: 1 });
    expect(state.current.edges.some((edge) => edge.edge === "CardTouches")).toBe(true);
    // the cursor still moves past it, so it is not read every hour
    expect(state.current.cursor.tasks).toBe("2026-09-01T00:00:00.000Z");
  });

  it("builds a card again when it ended after the brain last saw it open", async () => {
    const { brain } = fakeBrain();
    const { journal, state } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")]), journal }).run();
    expect(state.current.nodes["card:a"]!.data.state).toBe("open");
    await brainProjector({ brain, sources: sources([task("a", { state: "closed", updatedAt: new Date("2026-02-01T00:00:00.000Z") })]), journal }).run();
    expect(state.current.nodes["card:a"]!.data.state).toBe("closed");
  });

  it("moves the verdict cursor to when a truth was learned, so a late truth is read once", async () => {
    const { brain } = fakeBrain();
    const { journal, state } = memoryJournal();
    const late = { id: "r1", pack: "worth_learning", at: "2026-01-01T00:00:00.000Z", answer: { worth: { value: true, p: 0.9 } }, verdicts: {}, truth: { label: { worth: { value: false } }, source: "retro", at: "2026-03-01T00:00:00.000Z" } } as unknown as DecisionRecord;
    await brainProjector({ brain, sources: sources([], { verdicts: async () => [late] }), journal }).run();
    expect(state.current.cursor.verdicts).toBe("2026-03-01T00:00:00.000Z");
  });

  it("runs the hygiene queries at the end of every run whose loads did not fail, so a dirty result is not replaced by an empty one", async () => {
    const { brain } = fakeBrain({ hygiene: { prs_without_card: 2 } });
    const { journal } = memoryJournal();
    const lines: string[] = [];
    const projector = brainProjector({ brain, sources: sources([task("a")]), journal, log: (line) => lines.push(line) });
    const first = await projector.run();
    expect(first.hygiene).toContainEqual({ query: "prs_without_card", rows: 2 });
    expect(lines.some((line) => line.includes("prs_without_card"))).toBe(true);
    const second = await projector.run();
    expect(second.loaded).toBe(0);
    expect(second.hygiene).toContainEqual({ query: "prs_without_card", rows: 2 });
  });

  it("runs no hygiene query when a load failed", async () => {
    const { brain } = fakeBrain({ failLoad: 1, hygiene: { prs_without_card: 2 } });
    const { journal } = memoryJournal();
    const result = await brainProjector({ brain, sources: sources([task("a")]), journal }).run();
    expect(result.note).toContain("load_refused");
    expect(result.hygiene).toEqual([]);
  });

  it("never throws: a source failure becomes the note", async () => {
    const { brain } = fakeBrain();
    const { journal } = memoryJournal();
    const projector = brainProjector({
      brain,
      sources: sources([], {
        tasks: async () => {
          throw new Error("db down");
        },
      }),
      journal,
    });
    await expect(projector.run()).resolves.toMatchObject({ note: expect.stringContaining("db down") });
  });

  it("serializes two runs", async () => {
    const order: string[] = [];
    const { brain } = fakeBrain();
    const { journal } = memoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const projector = brainProjector({
      brain,
      sources: sources([], {
        tasks: async () => {
          const mine = first;
          first = false;
          order.push(mine ? "start-1" : "start-2");
          if (mine) await gate;
          order.push(mine ? "end-1" : "end-2");
          return [];
        },
      }),
      journal,
    });
    const a = projector.run();
    const b = projector.run();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["start-1"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

function claim(id: string, over: Partial<BrainClaim> = {}): BrainClaim {
  return {
    id,
    repo: "luna-ab12",
    repoPath: "/work/luna",
    taskId: "a",
    statement: `The retro learned ${id} about the build`,
    quote: "the exact words of the source",
    kind: "fact",
    scope: "repo",
    source: { kind: "card", ref: "a", title: "Task a" },
    speaker: null,
    speakerTrust: "machine",
    extractor: "reviewing_memory",
    status: "unverified",
    refusal: null,
    tier: null,
    proposed: null,
    reasons: [],
    durable: null,
    contradicts: [],
    recordId: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...over,
  };
}

const typed = (rows: BrainRow[]) => rows.map((row) => ("type" in row ? `${row.type}:${row.data.slug}` : `${row.edge}:${row.from}>${row.to}`));

describe("brainProjector claims", () => {
  it("lands an unverified claim of a projected card as Source, SourceOfCard, Claim and ClaimFrom", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")], { claims: async () => [claim("c1")] }), journal }).run();
    const got = typed(loads.flat());
    expect(got).toEqual(expect.arrayContaining(["Source:source:card/a", "SourceOfCard:source:card/a>card:a", "Claim:claim:c1", "ClaimFrom:claim:c1>source:card/a"]));
    expect(got.some((row) => row.startsWith("Learning:"))).toBe(false);
  });

  it("loads the changed claim and the new lesson once the claim is verified and durable, and not the source again", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    let claims = [claim("c1")];
    const projector = brainProjector({ brain, sources: sources([task("a")], { claims: async () => claims }), journal });
    await projector.run();
    loads.length = 0;
    claims = [claim("c1", { status: "verified", durable: true, decidedBy: "jev", decidedAt: "2026-04-02T00:00:00.000Z" })];
    await projector.run();
    expect(typed(loads.flat()).sort()).toEqual(["BasedOn:learning:c1>claim:c1", "Claim:claim:c1", "LearningAboutRepo:learning:c1>repo:luna-ab12", "Learning:learning:c1"].sort());
  });

  it("lands a claim whose card is not in the graph without SourceOfCard", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([], { claims: async () => [claim("c1")] }), journal }).run();
    const got = typed(loads.flat());
    expect(got).toContain("Claim:claim:c1");
    expect(got.some((row) => row.startsWith("SourceOfCard:"))).toBe(false);
  });

  it("knows a claim it contradicts when that claim is in the journal or in the same run", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([], { claims: async () => [claim("c1"), claim("c2", { contradicts: ["c1", "ghost"] })] }), journal }).run();
    const got = typed(loads.flat());
    expect(got).toContain("Contradicts:claim:c2>claim:c1");
    expect(got.some((row) => row.includes("claim:ghost"))).toBe(false);
  });

  it("never loads a lesson again when the journal holds it, even when its title differs", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const lines: string[] = [];
    const verified = { status: "verified" as const, durable: true, decidedAt: "2026-04-02T00:00:00.000Z" };
    let claims = [claim("c1", verified)];
    const projector = brainProjector({ brain, sources: sources([task("a")], { claims: async () => claims }), journal, log: (line) => lines.push(line) });
    await projector.run();
    loads.length = 0;
    claims = [claim("c1", { ...verified, statement: "The statement was reworded after the lesson was written" })];
    const result = await projector.run();
    const got = typed(loads.flat());
    expect(got).toEqual(["Claim:claim:c1"]);
    expect(result.skipped).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("learning:c1"))).toHaveLength(1);
  });

  it("moves the claims cursor to the newest time seen, and only when everything landed", async () => {
    const { brain } = fakeBrain({ failLoad: 1 });
    const { journal, state } = memoryJournal();
    const claims = [claim("c1"), claim("c2", { createdAt: "2026-04-01T00:00:00.000Z", decidedAt: "2026-04-05T00:00:00.000Z", status: "rejected" })];
    await brainProjector({ brain, sources: sources([], { claims: async () => claims }), journal }).run();
    expect(state.current.cursor.claims).toBeNull();
    const healthy = fakeBrain();
    await brainProjector({ brain: healthy.brain, sources: sources([], { claims: async () => claims }), journal }).run();
    expect(state.current.cursor.claims).toBe("2026-04-05T00:00:00.000Z");
  });

  it("asks the claims source from its cursor", async () => {
    const { brain } = fakeBrain();
    const { journal } = memoryJournal({ cursor: { tasks: null, verdicts: null, claims: "2026-04-05T00:00:00.000Z", wiki: {} }, nodes: {}, edges: [] });
    const asked: Array<Date | null> = [];
    await brainProjector({ brain, sources: sources([], { claims: async (since) => (asked.push(since), []) }), journal }).run();
    expect(asked).toEqual([new Date("2026-04-05T00:00:00.000Z")]);
  });
});

describe("brainProjector.rebuild", () => {
  it("resets, then loads the journal's rows without recomputing them", async () => {
    const first = fakeBrain();
    const { journal, state } = memoryJournal();
    await brainProjector({ brain: first.brain, sources: sources([task("a", { jira: jira("LUN-1") })]), journal }).run();
    const held = Object.keys(state.current.nodes).sort();

    const second = fakeBrain();
    const result = await brainProjector({ brain: second.brain, sources: sources([], { tasks: async () => [] }), journal }).rebuild();
    expect(second.calls[0]).toBe("reset");
    expect(slugsOf(second.loads.flat()).sort()).toEqual(held);
    expect(second.loads.flat().filter((row) => "edge" in row).length).toBe(state.current.edges.length);
    expect(result.note).toBeNull();
  });

  it("is a run after a reset with an empty journal", async () => {
    const { brain, calls, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")]), journal }).rebuild();
    expect(calls[0]).toBe("reset");
    expect(slugsOf(loads.flat())).toContain("card:a");
  });

  it("does nothing with the brain off", async () => {
    const { journal } = memoryJournal();
    expect((await brainProjector({ brain: noBrain(), sources: sources([]), journal }).rebuild()).note).toBe("the brain is off");
  });

  it("leaves the graph alone when the journal cannot be read, and says why", async () => {
    const { brain, calls } = fakeBrain();
    const journal: BrainJournal = {
      read: async () => {
        throw new Error("the brain's journal is not JSON");
      },
      write: async () => {},
    };
    const result = await brainProjector({ brain, sources: sources([task("a")]), journal }).rebuild();
    expect(calls).not.toContain("reset");
    expect(result.note).toContain("not JSON");
  });

  describe("a rebuild that stops half way", () => {
    // Enough cards to split the journal's rows into more than one batch.
    const many = Array.from({ length: 8_193 }, (_, i) => task(`t${i}`));

    async function filled() {
      const memory = memoryJournal();
      await brainProjector({ brain: fakeBrain().brain, sources: sources(many), journal: memory.journal }).run();
      return memory;
    }

    it("leaves the flag set in the journal", async () => {
      const { journal, state } = await filled();
      const broken = fakeBrain({ failLoad: 2 });
      const result = await brainProjector({ brain: broken.brain, sources: sources([], { tasks: async () => [] }), journal }).rebuild();
      expect(result.note).toContain("load_refused");
      expect(broken.calls[0]).toBe("reset");
      expect(state.current.rebuild).toBe(true);
    });

    it("is finished by the next run: reset, every journal row loaded, the flag gone", async () => {
      const { journal, state } = await filled();
      const held = Object.keys(state.current.nodes).length;
      const heldEdges = state.current.edges.length;
      await brainProjector({ brain: fakeBrain({ failLoad: 2 }).brain, sources: sources([], { tasks: async () => [] }), journal }).rebuild();
      const healthy = fakeBrain();
      const result = await brainProjector({ brain: healthy.brain, sources: sources([], { tasks: async () => [] }), journal }).run();
      expect(healthy.calls[0]).toBe("reset");
      expect(slugsOf(healthy.loads.flat())).toHaveLength(held);
      expect(healthy.loads.flat().filter((row) => "edge" in row)).toHaveLength(heldEdges);
      expect(result.note).toBeNull();
      expect(state.current.rebuild).toBeFalsy();
    });

    it("does not reset again on the run after that", async () => {
      const { journal } = await filled();
      await brainProjector({ brain: fakeBrain({ failLoad: 2 }).brain, sources: sources([], { tasks: async () => [] }), journal }).rebuild();
      await brainProjector({ brain: fakeBrain().brain, sources: sources([], { tasks: async () => [] }), journal }).run();
      const later = fakeBrain();
      await brainProjector({ brain: later.brain, sources: sources([], { tasks: async () => [] }), journal }).run();
      expect(later.calls).not.toContain("reset");
    });
  });
});

describe("projectAfterClose", () => {
  it("returns at once while the projection hangs", () => {
    const logged: string[] = [];
    const after = projectAfterClose({ run: () => new Promise<ProjectionResult>(() => {}) }, (line) => logged.push(line));
    expect(after()).toBeUndefined();
  });

  it("swallows a projection that rejects, and logs it", async () => {
    const logged: string[] = [];
    const after = projectAfterClose({ run: async () => Promise.reject(new Error("down")) }, (line) => logged.push(line));
    expect(() => after()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logged.join("\n")).toContain("down");
  });

  it("swallows a run that throws before it returns a promise", () => {
    const after = projectAfterClose(
      {
        run: () => {
          throw new Error("sync");
        },
      },
      () => {},
    );
    expect(() => after()).not.toThrow();
  });
});

describe("brainProjector.run, principles", () => {
  const FILE = "## Testing\n- Test first.\n- Run the real database.\n\n## Style\n- Match the idioms.\n";
  const principles = (rows: BrainRow[]) => rows.filter((row) => "type" in row && row.type === "Principle").map((row) => ("type" in row ? row.data : {}));

  it("loads a repository's rules with their edges, and nothing on a second run over the same file", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const projector = brainProjector({ brain, sources: sources([task("a"), task("b")], { principlesOf: async () => FILE }), journal });
    await projector.run();
    const rows = loads.flat();
    expect(principles(rows).map((data) => data.statement)).toEqual(["Test first.", "Run the real database.", "Match the idioms."]);
    expect(rows.filter((row) => "edge" in row && row.edge === "PrincipleOfRepo")).toHaveLength(3);
    loads.length = 0;
    const second = await projector.run();
    expect(loads).toEqual([]);
    expect(second.loaded).toBe(0);
  });

  it("asks the file once per repository of the run", async () => {
    const { brain } = fakeBrain();
    const { journal } = memoryJournal();
    const asked: string[] = [];
    await brainProjector({ brain, sources: sources([task("a"), task("b")], { principlesOf: async (path) => (asked.push(path), FILE) }), journal }).run();
    expect(asked).toEqual(["/work/luna"]);
  });

  it("loads a rule that left the file again, retired", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    let text: string | null = FILE;
    const projector = brainProjector({ brain, sources: sources([task("a")], { principlesOf: async () => text }), journal });
    await projector.run();
    loads.length = 0;
    text = "## Style\n- Match the idioms.\n";
    await projector.run();
    expect(principles(loads.flat()).map((data) => [data.statement, data.status])).toEqual([["Test first.", "retired"], ["Run the real database.", "retired"]]);
  });

  it("retires nothing when the file could not be read", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    let text: string | null = FILE;
    const projector = brainProjector({ brain, sources: sources([task("a")], { principlesOf: async () => text }), journal });
    await projector.run();
    loads.length = 0;
    text = null;
    await projector.run();
    expect(principles(loads.flat())).toEqual([]);
  });

  it("lands the tasks when the source throws, and logs it", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const lines: string[] = [];
    const projector = brainProjector({
      brain,
      journal,
      log: (line) => lines.push(line),
      sources: sources([task("a")], {
        principlesOf: async () => {
          throw new Error("git is down");
        },
      }),
    });
    const result = await projector.run();
    expect(slugsOf(loads.flat())).toContain("card:a");
    expect(result.note).toBeNull();
    expect(lines.join("\n")).toContain("git is down");
  });
});

describe("brainProjector.run, compliance", () => {
  const incident = (over: Partial<Incident> = {}): Incident => ({ id: "jira:OPS-9", title: "Bucket public", severity: "high", status: "open", startedAt: "2026-11-10T09:00:00.000Z", resolvedAt: null, service: null, signals: [], timeline: [], ...over });
  const types = (rows: BrainRow[], type: string) => rows.filter((row) => "type" in row && row.type === type).map((row) => ("type" in row ? row.data : {}));
  const PAGES = [{ path: "Compliance/Controls/Access.md", text: "# Access control" }];

  it("loads incidents, and nothing on a second run over the same ones", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const projector = brainProjector({ brain, sources: sources([], { incidents: async () => [incident()] }), journal });
    await projector.run();
    expect(types(loads.flat(), "Incident").map((data) => [data.slug, data.status])).toEqual([["incident:jira:OPS-9", "open"]]);
    loads.length = 0;
    expect((await projector.run()).loaded).toBe(0);
    expect(loads).toEqual([]);
  });

  it("loads a resolved incident again as resolved", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    let current = incident();
    const projector = brainProjector({ brain, sources: sources([], { incidents: async () => [current] }), journal });
    await projector.run();
    loads.length = 0;
    current = incident({ status: "resolved", resolvedAt: "2026-11-10T12:00:00.000Z" });
    await projector.run();
    expect(types(loads.flat(), "Incident").map((data) => [data.status, data.resolved_at])).toEqual([["resolved", "2026-11-10T12:00:00.000Z"]]);
  });

  it("lands the tasks when the incidents source throws, and logs it", async () => {
    const { brain, loads } = fakeBrain();
    const { journal, state } = memoryJournal();
    const lines: string[] = [];
    const incidents = async (): Promise<Incident[]> => {
      throw new Error("disk gone");
    };
    const result = await brainProjector({ brain, journal, log: (line) => lines.push(line), sources: sources([task("a")], { incidents }) }).run();
    expect(slugsOf(loads.flat())).toContain("card:a");
    expect(result.note).toBeNull();
    expect(lines.join("\n")).toContain("disk gone");
    expect(state.current.cursor.tasks).not.toBeNull();
  });

  it("loads the regimes of a task's repository once, with their edges", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const asked: string[] = [];
    await brainProjector({ brain, journal, sources: sources([task("a"), task("b")], { regimesOf: async (path) => (asked.push(path), ["soc2", "gdpr"]) }) }).run();
    expect(asked).toEqual(["/work/luna"]);
    expect(types(loads.flat(), "Regime").map((data) => data.slug)).toEqual(["regime:soc2", "regime:gdpr"]);
    expect(loads.flat().filter((row) => "edge" in row && row.edge === "RepoUnderRegime")).toHaveLength(2);
  });

  it("unlinks a regime the repository no longer declares", async () => {
    const { brain, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    let regimes = ["soc2", "gdpr"];
    const projector = brainProjector({ brain, journal, sources: sources([task("a")], { regimesOf: async () => regimes }) });
    await projector.run();
    regimes = ["soc2"];
    await projector.run();
    expect(unlinks).toEqual([{ edge: "RepoUnderRegime", from: "repo:luna-ab12", to: "regime:gdpr" }]);
  });

  it("keeps the regimes when the source could not read them: null is not an empty list", async () => {
    const { brain, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    let regimes: string[] | null = ["soc2"];
    const projector = brainProjector({ brain, journal, sources: sources([task("a")], { regimesOf: async () => regimes }) });
    await projector.run();
    regimes = null;
    await projector.run();
    expect(unlinks).toEqual([]);
  });

  it("keeps the regimes when the source throws", async () => {
    const { brain, unlinks, loads } = fakeBrain();
    const { journal } = memoryJournal();
    let fail = false;
    const projector = brainProjector({
      brain,
      journal,
      log: () => {},
      sources: sources([task("a")], {
        regimesOf: async () => {
          if (fail) throw new Error("yaml");
          return ["soc2"];
        },
      }),
    });
    await projector.run();
    fail = true;
    loads.length = 0;
    await projector.run();
    expect(unlinks).toEqual([]);
  });

  describe("the wiki", () => {
    function run(start: Date, over: Partial<BrainSources> = {}) {
      const fake = fakeBrain();
      const memory = memoryJournal();
      const clock = { at: start };
      const asked: string[] = [];
      const wikiPagesOf = async (path: string) => (asked.push(path), PAGES);
      const projector = brainProjector({ brain: fake.brain, journal: memory.journal, now: () => clock.at, sources: sources([task("a")], { wikiPagesOf, ...over }) });
      return { ...fake, ...memory, projector, clock, asked };
    }
    const hours = (from: Date, h: number) => new Date(from.getTime() + h * 3_600_000);
    const T0 = new Date("2026-11-10T09:00:00.000Z");

    it("reads the pages on the first run, not an hour later, and again after 25 hours", async () => {
      const { projector, clock, asked, loads, state } = run(T0);
      await projector.run();
      expect(asked).toEqual(["/work/luna"]);
      expect(types(loads.flat(), "Control").map((data) => [data.slug, data.title, data.kind])).toEqual([["control:luna-ab12/Compliance/Controls/Access.md", "Access control", "control"]]);
      expect(state.current.cursor.wiki).toEqual({ "luna-ab12": T0.toISOString() });
      clock.at = hours(T0, 1);
      await projector.run();
      expect(asked).toHaveLength(1);
      expect(state.current.cursor.wiki).toEqual({ "luna-ab12": T0.toISOString() });
      clock.at = hours(T0, 25);
      await projector.run();
      expect(asked).toHaveLength(2);
      expect(state.current.cursor.wiki).toEqual({ "luna-ab12": hours(T0, 25).toISOString() });
    });

    it("keeps the time per repository: one repository's pass does not put off another's", async () => {
      const fake = fakeBrain();
      const memory = memoryJournal();
      const clock = { at: T0 };
      const asked: string[] = [];
      let tasks = [task("a")];
      const projector = brainProjector({
        brain: fake.brain,
        journal: memory.journal,
        now: () => clock.at,
        sources: {
          ...sources([], { wikiPagesOf: async (path) => (asked.push(path), PAGES) }),
          tasks: async () => tasks,
          repoOf: (path) => (path === "/work/shop" ? { ...repo, slug: "shop-cd34", name: "shop" } : repo),
        },
      });
      await projector.run();
      clock.at = hours(T0, 1);
      tasks = [task("b", { repoPath: "/work/shop" })];
      await projector.run();
      expect(asked).toEqual(["/work/luna", "/work/shop"]);
      expect(memory.state.current.cursor.wiki).toEqual({ "luna-ab12": T0.toISOString(), "shop-cd34": hours(T0, 1).toISOString() });
    });

    it("loads no page and still lands the tasks when the source throws or answers null", async () => {
      for (const wikiPagesOf of [
        async (): Promise<null> => null,
        async (): Promise<never> => {
          throw new Error("no network");
        },
      ]) {
        const { projector, loads, state } = run(T0, { wikiPagesOf });
        const result = await projector.run();
        expect(types(loads.flat(), "Control")).toEqual([]);
        expect(slugsOf(loads.flat())).toContain("card:a");
        expect(result.note).toBeNull();
        expect(state.current.cursor.tasks).not.toBeNull();
      }
    });
  });
});

describe("brainProjector, the journal's wiki cursor", () => {
  it("reads a journal without the key as no pass yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    await mkdir(join(dir, "brain"));
    await writeFile(join(dir, "brain", "journal.json"), JSON.stringify({ cursor: { tasks: "2026-01-01T00:00:00.000Z", verdicts: null }, nodes: {}, edges: [] }));
    expect((await brainJournal(dir).read()).cursor).toEqual({ tasks: "2026-01-01T00:00:00.000Z", verdicts: null, claims: null, wiki: {} });
  });
});

const verdictRecord = (id: string, taskId: string | undefined, at: string): DecisionRecord =>
  ({ id, pack: "worth_learning", at, taskId, answer: { worth: { value: true, p: 0.9 } }, verdicts: {}, truth: { label: { worth: { value: false } }, source: "retro", at } }) as unknown as DecisionRecord;

describe("brainProjector.run, verdicts", () => {
  const edgesOf = (rows: BrainRow[], name: string) => rows.filter((row) => "edge" in row && row.edge === name);

  it("loads a verdict whose card the graph never held without its VerdictOn edge", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")], { verdicts: async () => [verdictRecord("v1", "ghost", "2026-03-01T00:00:00.000Z"), verdictRecord("v2", "a", "2026-03-02T00:00:00.000Z")] }), journal }).run();
    const rows = loads.flat();
    expect(slugsOf(rows)).toEqual(expect.arrayContaining(["verdict:worth_learning/v1/worth", "verdict:worth_learning/v2/worth"]));
    expect(edgesOf(rows, "VerdictOn")).toEqual([{ edge: "VerdictOn", from: "verdict:worth_learning/v2/worth", to: "card:a" }]);
  });

  it("gives the edge to a card only the journal holds", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")]), journal }).run();
    loads.length = 0;
    await brainProjector({ brain, sources: sources([], { verdicts: async () => [verdictRecord("v1", "a", "2026-03-01T00:00:00.000Z")] }), journal }).run();
    expect(edgesOf(loads.flat(), "VerdictOn")).toHaveLength(1);
  });

  describe("with a task that always fails", () => {
    const failing = (id: string) => async (t: TaskRow): Promise<BrainPull[]> => {
      if (t.id === id) throw new Error("boom");
      return [];
    };

    it("builds the verdicts about other cards and moves their cursor, and holds back the one about the skipped card", async () => {
      const { brain, loads } = fakeBrain();
      const { journal, state } = memoryJournal();
      const records = [verdictRecord("v1", "a", "2026-03-01T00:00:00.000Z"), verdictRecord("v2", "a", "2026-03-02T00:00:00.000Z"), verdictRecord("v3", "a", "2026-03-03T00:00:00.000Z"), verdictRecord("v4", "bad", "2026-03-04T00:00:00.000Z")];
      await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing("bad"), verdicts: async () => records }), journal, log: () => {}, now: () => new Date("2026-03-04T06:00:00.000Z") }).run();
      const got = slugsOf(loads.flat());
      expect(got).toEqual(expect.arrayContaining(["verdict:worth_learning/v1/worth", "verdict:worth_learning/v2/worth", "verdict:worth_learning/v3/worth"]));
      expect(got).not.toContain("verdict:worth_learning/v4/worth");
      expect(state.current.cursor.verdicts).toBe("2026-03-03T00:00:00.000Z");
      expect(state.current.cursor.tasks).toBeNull();
    });

    it("stops the cursor before the held-back record, though newer ones are built", async () => {
      const { brain, loads } = fakeBrain();
      const { journal, state } = memoryJournal();
      const records = [verdictRecord("v1", "a", "2026-03-01T00:00:00.000Z"), verdictRecord("v2", "bad", "2026-03-02T00:00:00.000Z"), verdictRecord("v3", "a", "2026-03-03T00:00:00.000Z")];
      await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing("bad"), verdicts: async () => records }), journal, log: () => {}, now: () => new Date("2026-03-02T06:00:00.000Z") }).run();
      expect(slugsOf(loads.flat())).toContain("verdict:worth_learning/v3/worth");
      expect(state.current.cursor.verdicts).toBe("2026-03-01T00:00:00.000Z");
    });

    // A task that never stops failing must not hold its verdicts, and the cursor behind them, for ever.
    it("waits a day at most: then the verdict goes in without its card and the cursor moves on", async () => {
      const { brain, loads } = fakeBrain();
      const { journal, state } = memoryJournal();
      const records = [verdictRecord("v1", "a", "2026-03-01T00:00:00.000Z"), verdictRecord("v2", "bad", "2026-03-02T00:00:00.000Z"), verdictRecord("v3", "a", "2026-03-03T00:00:00.000Z")];
      await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing("bad"), verdicts: async () => records }), journal, log: () => {}, now: () => new Date("2026-03-03T00:00:01.000Z") }).run();
      expect(slugsOf(loads.flat())).toContain("verdict:worth_learning/v2/worth");
      expect(edgesOf(loads.flat(), "VerdictOn").map((edge) => ("to" in edge ? edge.to : ""))).not.toContain("card:bad");
      expect(state.current.cursor.verdicts).toBe("2026-03-03T00:00:00.000Z");
    });

    it("does not wait for a card the journal already holds: its verdict keeps its edge", async () => {
      const { brain, loads } = fakeBrain();
      const { journal, state } = memoryJournal();
      await brainProjector({ brain, sources: sources([task("bad")]), journal }).run();
      loads.length = 0;
      const records = [verdictRecord("v1", "bad", "2026-03-02T00:00:00.000Z")];
      await brainProjector({ brain, sources: sources([task("bad", { updatedAt: new Date("2026-03-02T00:00:00.000Z") })], { pullsOf: failing("bad"), verdicts: async () => records }), journal, log: () => {}, now: () => new Date("2026-03-02T06:00:00.000Z") }).run();
      expect(edgesOf(loads.flat(), "VerdictOn")).toEqual([{ edge: "VerdictOn", from: "verdict:worth_learning/v1/worth", to: "card:bad" }]);
      expect(state.current.cursor.verdicts).toBe("2026-03-02T00:00:00.000Z");
    });
  });
});

describe("brainProjector.run, a task that always fails, and claims", () => {
  const failing = async (t: TaskRow): Promise<BrainPull[]> => {
    if (t.id === "bad") throw new Error("boom");
    return [];
  };
  const about = (id: string, card: string, createdAt: string) => claim(id, { createdAt, source: { kind: "card", ref: card, title: `Task ${card}` } });

  it("builds the claims about other cards and moves their cursor, and holds back the one about the skipped card", async () => {
    const { brain, loads } = fakeBrain();
    const { journal, state } = memoryJournal();
    const claims = [about("c1", "a", "2026-04-01T00:00:00.000Z"), about("c2", "a", "2026-04-02T00:00:00.000Z"), about("c3", "a", "2026-04-03T00:00:00.000Z"), about("c4", "bad", "2026-04-04T00:00:00.000Z")];
    await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing, claims: async () => claims }), journal, log: () => {}, now: () => new Date("2026-04-04T06:00:00.000Z") }).run();
    const got = slugsOf(loads.flat());
    expect(got).toEqual(expect.arrayContaining(["claim:c1", "claim:c2", "claim:c3"]));
    expect(got).not.toContain("claim:c4");
    expect(state.current.cursor.claims).toBe("2026-04-03T00:00:00.000Z");
    expect(state.current.cursor.tasks).toBeNull();
  });

  it("stops the cursor before the held-back claim, though newer ones are built", async () => {
    const { brain, loads } = fakeBrain();
    const { journal, state } = memoryJournal();
    const claims = [about("c1", "a", "2026-04-01T00:00:00.000Z"), about("c2", "bad", "2026-04-02T00:00:00.000Z"), about("c3", "a", "2026-04-03T00:00:00.000Z")];
    await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing, claims: async () => claims }), journal, log: () => {}, now: () => new Date("2026-04-02T06:00:00.000Z") }).run();
    expect(slugsOf(loads.flat())).toContain("claim:c3");
    expect(state.current.cursor.claims).toBe("2026-04-01T00:00:00.000Z");
  });

  it("waits a day at most: then the claim goes in without its card and the cursor moves on", async () => {
    const { brain, loads } = fakeBrain();
    const { journal, state } = memoryJournal();
    const claims = [about("c1", "a", "2026-04-01T00:00:00.000Z"), about("c2", "bad", "2026-04-02T00:00:00.000Z"), about("c3", "a", "2026-04-03T00:00:00.000Z")];
    await brainProjector({ brain, sources: sources([task("a"), task("bad")], { pullsOf: failing, claims: async () => claims }), journal, log: () => {}, now: () => new Date("2026-04-03T00:00:01.000Z") }).run();
    expect(slugsOf(loads.flat())).toContain("claim:c2");
    expect(loads.flat().filter((row) => "edge" in row && row.edge === "SourceOfCard" && row.to === "card:bad")).toEqual([]);
    expect(state.current.cursor.claims).toBe("2026-04-03T00:00:00.000Z");
  });
});

describe("brainProjector.run, pull requests", () => {
  const pull = (title: string, opened: boolean): BrainPull => ({ repo: "acme/shop", number: 7, title, state: "open", url: "https://github.com/acme/shop/pull/7", mergedAt: null, author: null, opened });
  const prs = (rows: BrainRow[]) => rows.filter((row) => "type" in row && row.type === "PR").map((row) => ("type" in row ? row.data : {}));
  const forCard = (rows: BrainRow[]) => rows.filter((row) => "edge" in row && row.edge === "PrForCard");

  for (const order of [["opener", "address"], ["address", "opener"]]) {
    it(`gives the card that opened a pull request the PR and its one PrForCard edge, tasks in order ${order.join(", ")}`, async () => {
      const { brain, loads } = fakeBrain();
      const { journal } = memoryJournal();
      const pullsOf = async (t: TaskRow) => [pull(t.id === "opener" ? "opener title" : "source title", t.id === "opener")];
      await brainProjector({ brain, sources: sources(order.map((id) => task(id)), { pullsOf }), journal }).run();
      expect(prs(loads.flat())).toMatchObject([{ slug: "pr:acme/shop#7", title: "opener title" }]);
      expect(forCard(loads.flat())).toEqual([{ edge: "PrForCard", from: "pr:acme/shop#7", to: "card:opener" }]);
    });
  }

  it("builds a source-only pull request once when no card opened it", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("x"), task("y")], { pullsOf: async () => [pull("from a source", false)] }), journal }).run();
    expect(prs(loads.flat())).toHaveLength(1);
    expect(forCard(loads.flat())).toHaveLength(1);
  });

  it("loads nothing and unlinks nothing for a source-only pull request the journal already holds", async () => {
    const { brain, loads, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("opener")], { pullsOf: async () => [pull("opener title", true)] }), journal }).run();
    loads.length = 0;
    const result = await brainProjector({ brain, sources: sources([task("address", { updatedAt: new Date("2026-02-01T00:00:00.000Z") })], { pullsOf: async () => [pull("source title", false)] }), journal }).run();
    expect(prs(loads.flat())).toEqual([]);
    expect(forCard(loads.flat())).toEqual([]);
    expect(unlinks).toEqual([]);
    expect(result.note).toBeNull();
  });

  // A person opened the pull request and a card was made from it: that card is its only one, so it keeps it up to date.
  it("keeps building a source-only pull request for the card that already owns it", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("address")], { pullsOf: async () => [pull("from a source", false)] }), journal }).run();
    loads.length = 0;
    const merged = { ...pull("from a source", false), state: "merged" as const, mergedAt: new Date("2026-02-01T00:00:00.000Z") };
    await brainProjector({ brain, sources: sources([task("address", { updatedAt: new Date("2026-02-01T00:00:00.000Z") })], { pullsOf: async () => [merged] }), journal }).run();
    expect(prs(loads.flat())).toMatchObject([{ slug: "pr:acme/shop#7", state: "merged" }]);
  });

  it("leaves a pull request with the source-only card that owns it when another source-only card comes first in a run", async () => {
    const { brain, loads, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("second")], { pullsOf: async () => [pull("from a source", false)] }), journal }).run();
    loads.length = 0;
    const later = new Date("2026-02-01T00:00:00.000Z");
    await brainProjector({ brain, sources: sources([task("first", { updatedAt: later }), task("second", { updatedAt: later })], { pullsOf: async () => [{ ...pull("from a source", false), state: "closed" as const }] }), journal }).run();
    expect(forCard(loads.flat())).toEqual([]);
    expect(unlinks).toEqual([]);
    expect(prs(loads.flat())).toMatchObject([{ state: "closed" }]);
  });
});

describe("brainProjector.run, a card's Source", () => {
  const sourceRows = (rows: BrainRow[]) => rows.filter((row) => "type" in row && row.type === "Source").map((row) => ("type" in row ? row.data : {}));

  it("takes the earliest claim's time, and a later run with only the later claim loads no Source", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const first = claim("c1", { createdAt: "2026-04-01T10:00:00.000Z" });
    const second = claim("c2", { createdAt: "2026-04-01T10:05:00.000Z" });
    let claims = [second, first];
    const projector = brainProjector({ brain, sources: sources([task("a")], { claims: async () => claims }), journal });
    await projector.run();
    expect(sourceRows(loads.flat())).toMatchObject([{ slug: "source:card/a", occurred_at: "2026-04-01T10:00:00.000Z" }]);
    loads.length = 0;
    claims = [claim("c3", { createdAt: "2026-04-01T10:07:00.000Z" })];
    await projector.run();
    expect(sourceRows(loads.flat())).toEqual([]);
  });
});

describe("brainProjector.run, two cards that opened one pull request", () => {
  const pull = (title: string): BrainPull => ({ repo: "acme/shop", number: 7, title, state: "open", url: "https://github.com/acme/shop/pull/7", mergedAt: null, author: null, opened: true });
  const prs = (rows: BrainRow[]) => rows.filter((row) => "type" in row && row.type === "PR").map((row) => ("type" in row ? row.data : {}));
  const forCard = (rows: BrainRow[]) => rows.filter((row) => "edge" in row && row.edge === "PrForCard");
  const pullsOf = async (t: TaskRow) => [pull(`${t.id} title`)];

  it("builds the PR once, for the first card in task order", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a"), task("b")], { pullsOf }), journal }).run();
    expect(prs(loads.flat())).toMatchObject([{ slug: "pr:acme/shop#7", title: "a title" }]);
    expect(forCard(loads.flat())).toEqual([{ edge: "PrForCard", from: "pr:acme/shop#7", to: "card:a" }]);
  });

  it("keeps the PR with the card the journal names, and unlinks nothing", async () => {
    const { brain, loads, unlinks } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("b")], { pullsOf }), journal }).run();
    loads.length = 0;
    const later = new Date("2026-02-01T00:00:00.000Z");
    await brainProjector({ brain, sources: sources([task("a", { updatedAt: later }), task("b", { updatedAt: later })], { pullsOf }), journal }).run();
    expect(forCard(loads.flat())).toEqual([]);
    expect(unlinks).toEqual([]);
    expect(prs(loads.flat())).toEqual([]);
  });

  it("skips a source-only pull when any card of the run opened it", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const sourceOnly = async (t: TaskRow) => [{ ...pull(`${t.id} title`), opened: t.id === "b" }];
    await brainProjector({ brain, sources: sources([task("a"), task("b")], { pullsOf: sourceOnly }), journal }).run();
    expect(forCard(loads.flat())).toEqual([{ edge: "PrForCard", from: "pr:acme/shop#7", to: "card:b" }]);
  });
});

describe("brainProjector.run, a record the graph already has", () => {
  const failing = async (t: TaskRow): Promise<BrainPull[]> => {
    if (t.id === "bad") throw new Error("boom");
    return [];
  };

  it("loads a changed claim about a skipped card the graph does not hold, when the journal holds the claim", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const about = (over: Partial<BrainClaim>) => claim("c1", { source: { kind: "card", ref: "bad", title: "Task bad" }, ...over });
    // It went in earlier without its card, a day after it was made.
    await brainProjector({ brain, sources: sources([task("bad")], { pullsOf: failing, claims: async () => [about({})] }), journal, log: () => {}, now: () => new Date("2026-05-01T00:00:00.000Z") }).run();
    loads.length = 0;
    const decided = "2026-05-02T10:00:00.000Z";
    const changed = about({ status: "rejected", decidedBy: "person", decidedAt: decided });
    await brainProjector({ brain, sources: sources([task("bad")], { pullsOf: failing, claims: async () => [changed] }), journal, log: () => {}, now: () => new Date("2026-05-02T10:01:00.000Z") }).run();
    expect(loads.flat().filter((row) => "type" in row).map((row) => ("type" in row ? [row.type, row.data.status] : []))).toContainEqual(["Claim", "rejected"]);
  });

  it("loads a verdict the journal holds about a skipped card the graph does not hold", async () => {
    const { brain, loads } = fakeBrain();
    const { journal } = memoryJournal();
    const record = (at: string) => verdictRecord("v1", "bad", at);
    await brainProjector({ brain, sources: sources([task("bad")], { pullsOf: failing, verdicts: async () => [record("2026-05-01T00:00:00.000Z")] }), journal, log: () => {}, now: () => new Date("2026-05-03T00:00:00.000Z") }).run();
    loads.length = 0;
    const corrected = { ...record("2026-05-01T00:00:00.000Z"), truth: { label: { worth: { value: true } }, source: "person", at: "2026-05-03T10:00:00.000Z" } } as unknown as DecisionRecord;
    await brainProjector({ brain, sources: sources([task("bad")], { pullsOf: failing, verdicts: async () => [corrected] }), journal, log: () => {}, now: () => new Date("2026-05-03T10:01:00.000Z") }).run();
    expect(slugsOf(loads.flat())).toContain("verdict:worth_learning/v1/worth");
  });
});

describe("brainProjector.run, the wiki time when a load fails", () => {
  const PAGES = [{ path: "Compliance/Controls/Access.md", text: "# Access control" }];

  it("is in the journal though the run failed, and the next run an hour later does not read the wiki", async () => {
    const T0 = new Date("2026-11-10T09:00:00.000Z");
    const clock = { at: T0 };
    const asked: string[] = [];
    const { journal, state } = memoryJournal();
    const wikiPagesOf = async (path: string) => (asked.push(path), PAGES);
    const broken = brainProjector({ brain: fakeBrain({ failLoad: 1 }).brain, journal, now: () => clock.at, sources: sources([task("a")], { wikiPagesOf }) });
    expect((await broken.run()).note).toContain("load_refused");
    expect(state.current.cursor.wiki).toEqual({ "luna-ab12": T0.toISOString() });
    clock.at = new Date(T0.getTime() + 3_600_000);
    await brainProjector({ brain: fakeBrain().brain, journal, now: () => clock.at, sources: sources([task("a")], { wikiPagesOf }) }).run();
    expect(asked).toEqual(["/work/luna"]);
  });
});

describe("brainProjector.run, the actor of a load", () => {
  it("loads the card's batch as the facts actor and the claim's after it as the memories actor", async () => {
    const { brain, loads, actors } = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain, sources: sources([task("a")], { claims: async () => [claim("c1", { speaker: "Octo" })] }), journal }).run();
    expect(actors).toEqual([undefined, "memories"]);
    expect(typed(loads[0]!).some((row) => row.startsWith("Card:card:a"))).toBe(true);
    expect(typed(loads[0]!).some((row) => row.startsWith("Person:person:octo"))).toBe(true);
    expect(typed(loads[0]!).some((row) => row.startsWith("Claim:") || row.startsWith("Source:") || row.startsWith("ClaimFrom:"))).toBe(false);
    expect(typed(loads[1]!)).toEqual(expect.arrayContaining(["Source:source:card/a", "Claim:claim:c1", "ClaimFrom:claim:c1>source:card/a", "SourceOfCard:source:card/a>card:a", "ClaimedBy:claim:c1>person:octo"]));
    expect(typed(loads[1]!).some((row) => row.startsWith("Card:") || row.startsWith("Person:") || row.startsWith("Repo:"))).toBe(false);
  });

  it("restores the claim layer as the memories actor too", async () => {
    const first = fakeBrain();
    const { journal } = memoryJournal();
    await brainProjector({ brain: first.brain, sources: sources([task("a")], { claims: async () => [claim("c1")] }), journal }).run();
    const second = fakeBrain();
    await brainProjector({ brain: second.brain, sources: sources([]), journal }).rebuild();
    expect(second.actors).toEqual([undefined, "memories"]);
  });
});

describe("brainProjector.run, the claims cursor", () => {
  it("follows the store's updatedAt when the claim has one", async () => {
    const { brain } = fakeBrain();
    const { journal, state } = memoryJournal();
    // `updatedAt` is the store's own clock; the cast goes when BrainClaim carries the field.
    const stored = { ...claim("c1"), updatedAt: "2026-06-01T00:00:00.000Z" } as BrainClaim;
    await brainProjector({ brain, sources: sources([], { claims: async () => [stored] }), journal }).run();
    expect(state.current.cursor.claims).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("brainProjector.forget", () => {
  const speaking = [task("a")];
  const said = (id: string) => claim(id, { speaker: "Octo", createdAt: `2026-04-0${id.slice(1)}T00:00:00.000Z` });
  const withSpeaker = (claims: BrainClaim[]) => sources(speaking, { claims: async () => claims });
  const mentions = (rows: BrainRow[]) => typed(rows).filter((row) => row.includes("person:octo"));

  async function filled() {
    const graph = fakeBrain();
    const held = memoryJournal();
    await brainProjector({ brain: graph.brain, sources: withSpeaker([said("c1")]), journal: held.journal }).run();
    expect(mentions(Object.values(held.state.current.nodes))).toEqual(["Person:person:octo"]);
    return { held };
  }

  it("unlinks the edges that touch the slugs, then removes the nodes, then edits the journal and drops its previous generation", async () => {
    const { held } = await filled();
    const graph = fakeBrain();
    const writes = held.state.writes;
    const result = await brainProjector({ brain: graph.brain, sources: sources([]), journal: held.journal }).forget(["person:octo"]);
    expect(result).toEqual({ nodes: 1, edges: 1, note: null });
    expect(graph.unlinks).toEqual([{ edge: "ClaimedBy", from: "claim:c1", to: "person:octo" }]);
    expect(graph.removed).toEqual([{ type: "Person", slug: "person:octo" }]);
    expect(graph.calls).toEqual(["unlink", "remove"]);
    expect(held.state.current.nodes["person:octo"]).toBeUndefined();
    expect(held.state.current.nodes["claim:c1"]).toBeDefined();
    expect(held.state.current.edges.some((edge) => edge.from === "person:octo" || edge.to === "person:octo")).toBe(false);
    expect(held.state.current.forgotten).toEqual(["person:octo"]);
    expect(held.state.writes).toBe(writes + 1);
    expect(held.state.dropped).toBe(1);
  });

  it("is not undone by a run over sources that still produce those rows", async () => {
    const { held } = await filled();
    await brainProjector({ brain: fakeBrain().brain, sources: sources([]), journal: held.journal }).forget(["person:octo"]);
    const graph = fakeBrain();
    const result = await brainProjector({ brain: graph.brain, sources: withSpeaker([said("c1"), said("c2")]), journal: held.journal }).run();
    expect(result.note).toBeNull();
    expect(mentions(graph.loads.flat())).toEqual([]);
    expect(typed(graph.loads.flat())).toEqual(expect.arrayContaining(["Claim:claim:c2", "ClaimFrom:claim:c2>source:card/a"]));
    expect(held.state.current.nodes["person:octo"]).toBeUndefined();
    expect(held.state.current.edges.some((edge) => edge.edge === "ClaimedBy")).toBe(false);
  });

  it("is not undone by a rebuild", async () => {
    const { held } = await filled();
    await brainProjector({ brain: fakeBrain().brain, sources: sources([]), journal: held.journal }).forget(["person:octo"]);
    const graph = fakeBrain();
    await brainProjector({ brain: graph.brain, sources: withSpeaker([said("c1")]), journal: held.journal }).rebuild();
    expect(graph.calls[0]).toBe("reset");
    expect(mentions(graph.loads.flat())).toEqual([]);
    expect(typed(graph.loads.flat())).toContain("Claim:claim:c1");
  });

  it("forgets a claim with its source note and lesson, and leaves the rest", async () => {
    const graph = fakeBrain();
    const held = memoryJournal();
    const verified = { status: "verified", durable: true, decidedBy: "jev", decidedAt: "2026-04-02T00:00:00.000Z" } as const;
    await brainProjector({ brain: graph.brain, sources: withSpeaker([claim("c1", verified), claim("c2")]), journal: held.journal }).run();
    expect(Object.keys(held.state.current.nodes)).toEqual(expect.arrayContaining(["claim:c1", "learning:c1"]));
    const result = await brainProjector({ brain: graph.brain, sources: sources([]), journal: held.journal }).forget(["claim:c1", "learning:c1", "source:note/c1"]);
    expect(result.note).toBeNull();
    expect(result.nodes).toBe(2);
    expect(graph.removed.map((node) => node.slug).sort()).toEqual(["claim:c1", "learning:c1"]);
    expect(Object.keys(held.state.current.nodes)).toEqual(expect.arrayContaining(["claim:c2", "source:card/a"]));
    expect(held.state.current.forgotten).toEqual(["claim:c1", "learning:c1", "source:note/c1"]);
  });

  it("leaves the journal untouched and reports the code when the graph refuses, so the caller can try again", async () => {
    const { held } = await filled();
    const before = structuredClone(held.state.current);
    const writes = held.state.writes;
    const lines: string[] = [];
    for (const refuse of [{ failUnlink: true }, { failRemove: true }]) {
      const result = await brainProjector({ brain: fakeBrain(refuse).brain, sources: sources([]), journal: held.journal, log: (line) => lines.push(line) }).forget(["person:octo"]);
      expect(result.note).toBe(refuse.failUnlink ? "unlink_refused" : "remove_refused");
      expect(held.state.current).toEqual(before);
      expect(held.state.writes).toBe(writes);
    }
    expect(lines.length).toBe(2);
    const again = await brainProjector({ brain: fakeBrain().brain, sources: sources([]), journal: held.journal }).forget(["person:octo"]);
    expect(again).toEqual({ nodes: 1, edges: 1, note: null });
  });

  it("still edits the journal with the brain off, so a later rebuild does not bring the rows back", async () => {
    const { held } = await filled();
    const result = await brainProjector({ brain: noBrain(), sources: sources([]), journal: held.journal }).forget(["person:octo"]);
    expect(result).toEqual({ nodes: 1, edges: 1, note: null });
    expect(held.state.current.nodes["person:octo"]).toBeUndefined();
    expect(held.state.current.forgotten).toEqual(["person:octo"]);
    expect(held.state.dropped).toBe(1);
  });

  it("adds a slug the journal does not hold, once", async () => {
    const held = memoryJournal();
    const graph = fakeBrain();
    const projector = brainProjector({ brain: graph.brain, sources: sources([]), journal: held.journal });
    expect(await projector.forget(["person:nobody", "person:nobody"])).toEqual({ nodes: 0, edges: 0, note: null });
    await projector.forget(["person:nobody", "person:other"]);
    expect(held.state.current.forgotten).toEqual(["person:nobody", "person:other"]);
    expect(graph.removed).toEqual([]);
  });

  it("is served in the same queue as a run", async () => {
    const order: string[] = [];
    const { held } = await filled();
    const slow: BrainJournal = {
      read: async () => {
        order.push("read");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return held.journal.read();
      },
      write: async (next, options) => {
        order.push("write");
        await held.journal.write(next, options);
      },
    };
    const projector = brainProjector({ brain: fakeBrain().brain, sources: sources([]), journal: slow });
    await Promise.all([projector.forget(["person:octo"]), projector.run()]);
    expect(order.slice(0, 3)).toEqual(["read", "write", "read"]);
  });

  // The two cases forget is for (a person, a claim) hold no minimum; this is the general case.
  it("drops a built node whose required edge pointed at a forgotten slug, and what rests on it, and logs it", async () => {
    const graph = fakeBrain();
    const held = memoryJournal({ cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [], forgotten: ["repo:luna-ab12"] });
    const lines: string[] = [];
    await brainProjector({ brain: graph.brain, sources: sources([task("a")], { componentsOf: async () => ["api"] }), journal: held.journal, log: (line) => lines.push(line) }).run();
    const rows = typed(graph.loads.flat());
    expect(rows).toContain("Card:card:a");
    expect(rows.filter((row) => row.includes("component:") || row.includes("repo:luna-ab12"))).toEqual([]);
    expect(lines.some((line) => line.includes("component:luna-ab12/api"))).toBe(true);
  });

  it("drops a lesson whose only claim was forgotten", async () => {
    const graph = fakeBrain();
    const held = memoryJournal({ cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [], forgotten: ["claim:c1"] });
    const verified = { status: "verified", durable: true, decidedBy: "jev", decidedAt: "2026-04-02T00:00:00.000Z" } as const;
    await brainProjector({ brain: graph.brain, sources: withSpeaker([claim("c1", verified)]), journal: held.journal }).run();
    expect(typed(graph.loads.flat()).filter((row) => row.includes("c1"))).toEqual([]);
  });
});
