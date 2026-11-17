import type { BrainClaim, BrainEdgeName, BrainRow, DecisionRecord } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import type { TaskRow } from "../domain/task.ts";
import type { BrainPull, RetroFacts } from "../domain/brain/rows.ts";
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
function fakeBrain(options: { failLoad?: number; hygiene?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const loads: BrainRow[][] = [];
  const unlinks: Array<{ edge: BrainEdgeName; from: string; to?: string }> = [];
  let n = 0;
  const brain: Brain = {
    enabled: true,
    health: async () => ({ ok: true, version: "x", note: null }),
    load: async (rows) => {
      n += 1;
      if (n === options.failLoad) throw new BrainError("refused", "load_refused", 422);
      calls.push("load");
      loads.push(rows);
      return { entities: rows.length, commit: "c" };
    },
    query: async (name): Promise<BrainAnswer> => ({ rows: Array.from({ length: options.hygiene?.[name] ?? 0 }, () => ({ x: 1 })), note: null }),
    unlink: async (edge, from, to) => {
      calls.push("unlink");
      unlinks.push({ edge, from, to });
      return 1;
    },
    reset: async () => {
      calls.push("reset");
    },
  };
  return { brain, calls, loads, unlinks };
}

function memoryJournal(start?: BrainState) {
  const state = { current: start ?? { cursor: { tasks: null, verdicts: null, claims: null }, nodes: {}, edges: [] } as BrainState, writes: 0 };
  const journal: BrainJournal = {
    read: async () => structuredClone(state.current),
    write: async (next) => {
      state.writes += 1;
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

  it("reports a hygiene query that returned rows, in the result and the log, only after a change", async () => {
    const { brain } = fakeBrain({ hygiene: { prs_without_card: 2 } });
    const { journal } = memoryJournal();
    const lines: string[] = [];
    const projector = brainProjector({ brain, sources: sources([task("a")]), journal, log: (line) => lines.push(line) });
    const first = await projector.run();
    expect(first.hygiene).toContainEqual({ query: "prs_without_card", rows: 2 });
    expect(lines.some((line) => line.includes("prs_without_card"))).toBe(true);
    const second = await projector.run();
    expect(second.hygiene).toEqual([]);
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
    const { journal } = memoryJournal({ cursor: { tasks: null, verdicts: null, claims: "2026-04-05T00:00:00.000Z" }, nodes: {}, edges: [] });
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
