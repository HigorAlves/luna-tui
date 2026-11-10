import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type FactRecord } from "../../domain/economy/lifecycle.ts";
import { ledgerRecord } from "../../domain/economy/ledger.ts";
import { type Digest } from "../../domain/economy/observe-run.ts";
import { repoSlug } from "../graph/slug.ts";
import { fileStore } from "./store.ts";

let dir: string;
const repo = "/work/api";
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "economy-store-"))));
afterEach(() => rm(dir, { recursive: true, force: true }));
const folder = () => join(dir, "economy", repoSlug(repo));
const row = (n: number) => ({ action: "gate" as const, calls: n, at: "t", runId: `r${n}`, pack: "implementing" });

const fact = (over: Partial<FactRecord> = {}): FactRecord => ({ id: "a1b2c3d4e5f6", family: "form_repair", source: "free", key: "test:pytest", text: "t", state: "active", confirmations: 3, contradictions: 0, score: 2, exercised: 4, fired: 4, cards: ["c1"], firstRun: "r1", lastRun: "r4", streak: 0, ...over });
const digest = (n: number): Digest => ({ at: "t", runId: `r${n}`, pack: "implementing", cardId: "c1", outcome: "pass", calls: 1, lines: ["test | pytest | ok"] });

describe("fileStore: facts and digests", () => {
  it("reads no facts and no digests before anything is written", async () => {
    const store = fileStore(dir);
    expect(await store.facts(repo)).toEqual({ facts: [], injected: {} });
    expect(await store.digests(repo)).toEqual([]);
  });

  it("round-trips the facts and what each pack was told, privately, and keeps every update when writes arrive together", async () => {
    const store = fileStore(dir);
    await store.updateFacts(repo, (file) => ({ ...file, facts: [fact()], injected: { implementing: ["a1b2c3d4e5f6"] } }));
    expect(await store.facts(repo)).toEqual({ facts: [fact()], injected: { implementing: ["a1b2c3d4e5f6"] } });
    expect((await stat(join(folder(), "facts.json"))).mode & 0o777).toBe(0o600);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.updateFacts(repo, (file) => ({ ...file, facts: [...file.facts, fact({ id: `id${i}` })] }))));
    expect((await store.facts(repo)).facts).toHaveLength(21);
    expect((await readdir(folder())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("reads a corrupt facts file as empty and drops a record that is not a fact", async () => {
    const store = fileStore(dir);
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "facts.json"), "{not json");
    expect(await store.facts(repo)).toEqual({ facts: [], injected: {} });
    await writeFile(join(folder(), "facts.json"), JSON.stringify({ facts: [fact(), { id: "x" }, fact({ id: "b" }), { ...fact({ id: "c" }), state: "bogus" }], injected: { a: ["i"], b: "no", c: [1] } }));
    expect((await store.facts(repo)).facts.map((f) => f.id)).toEqual(["a1b2c3d4e5f6", "b"]);
    expect((await store.facts(repo)).injected).toEqual({ a: ["i"] });
  });

  it("appends digests privately and keeps the last eight runs", async () => {
    const store = fileStore(dir);
    for (let i = 1; i <= 11; i++) await store.appendDigest(repo, digest(i));
    expect((await store.digests(repo)).map((d) => d.runId)).toEqual(["r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11"]);
    expect((await stat(join(folder(), "digests.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("skips a digest line that is not a digest", async () => {
    const store = fileStore(dir);
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "digests.jsonl"), `garbage\n${JSON.stringify(digest(1))}\n${JSON.stringify({ runId: "x" })}\n`);
    expect((await store.digests(repo)).map((d) => d.runId)).toEqual(["r1"]);
  });
});

describe("fileStore: the proposer's state", () => {
  const calls = [{ intent: "test" as const, form: "python -m pytest", testsRan: true, ok: true }];

  it("keeps the calls of the kept digests' runs only, privately", async () => {
    const store = fileStore(dir);
    for (let i = 1; i <= 10; i++) await store.appendDigest(repo, digest(i), calls);
    expect(Object.keys(await store.calls(repo)).sort()).toEqual(["r10", "r3", "r4", "r5", "r6", "r7", "r8", "r9"].sort());
    expect((await store.calls(repo)).r10).toEqual(calls);
    expect((await stat(join(folder(), "calls.json"))).mode & 0o777).toBe(0o600);
  });

  it("reads no calls before any, and skips a run whose calls are not observations", async () => {
    const store = fileStore(dir);
    expect(await store.calls(repo)).toEqual({});
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "calls.json"), JSON.stringify({ good: calls, bad: [{ output: "text" }], worse: "x" }));
    expect(await store.calls(repo)).toEqual({ good: calls });
  });

  it("round-trips a proposed fact with its detector, files and section, and drops one whose detector is not valid", async () => {
    const store = fileStore(dir);
    const detector = { scope: { all: [{ intent: "test" as const }] }, confirm: { all: [{ commandIncludes: "pytest -q" }] }, contradict: { all: [{ errorClass: "command_missing" as const }] } };
    const proposed = fact({ id: "p1", family: "proposed", source: "proposed", detector, files: ["a.ts"], section: "Commands" });
    const bad = fact({ id: "p2", family: "proposed", source: "proposed", detector: { ...detector, scope: { all: [{ predicate: "nonsense" }] } } as never });
    await store.updateFacts(repo, (file) => ({ ...file, facts: [proposed, bad] }));
    expect((await store.facts(repo)).facts).toEqual([proposed]);
  });

  it("counts closed cards across reads, and starts again from zero on a corrupt file", async () => {
    const store = fileStore(dir);
    await store.updateProposer(repo, (s) => ({ closed: s.closed + 1, counted: [...s.counted, "c1"] }));
    await store.updateProposer(repo, (s) => ({ closed: s.closed + 1, counted: [...s.counted, "c2"] }));
    let seen = { closed: -1, counted: [] as string[] };
    await store.updateProposer(repo, (s) => ((seen = s), s));
    expect(seen).toEqual({ closed: 2, counted: ["c1", "c2"] });
    await writeFile(join(folder(), "proposer.json"), "{ not json");
    await store.updateProposer(repo, (s) => ((seen = s), s));
    expect(seen).toEqual({ closed: 0, counted: [] });
  });
});

describe("fileStore", () => {
  it("reads empty before anything is written", async () => {
    const store = fileStore(dir);
    expect(await store.envelopes(repo)).toEqual({});
    expect(await store.ledger(repo)).toEqual([]);
    expect(await store.guard(repo)).toEqual([]);
    expect(await store.events("nope")).toEqual([]);
  });

  it("round-trips envelopes, the ledger and the guard log, privately", async () => {
    const store = fileStore(dir);
    await store.updateEnvelopes(repo, (all) => ({ ...all, implementing: [3, 4] }));
    const record = ledgerRecord({ at: "t", runId: "r1", pack: "implementing", cardId: "c1", tokens: null });
    await store.appendLedger(repo, record);
    await store.appendGuard(repo, [row(1)]);
    expect(await store.envelopes(repo)).toEqual({ implementing: [3, 4] });
    expect(await store.ledger(repo)).toEqual([record]);
    expect(await store.guard(repo)).toEqual([row(1)]);
    expect((await stat(folder())).mode & 0o777).toBe(0o700);
    for (const file of ["envelope.json", "ledger.jsonl", "guard.jsonl"]) expect((await stat(join(folder(), file))).mode & 0o777).toBe(0o600);
    expect((await readdir(folder())).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every update when writes arrive together", async () => {
    const store = fileStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.updateEnvelopes(repo, (all) => ({ ...all, p: [...(all.p ?? []), i] }))));
    expect((await store.envelopes(repo)).p).toHaveLength(20);
  });

  it("keeps the newest 200 guard events", async () => {
    const store = fileStore(dir);
    for (let i = 0; i < 205; i++) await store.appendGuard(repo, [row(i)]);
    const kept = await store.guard(repo);
    expect(kept).toHaveLength(200);
    expect(kept[0]!.calls).toBe(5);
    expect(kept.at(-1)!.calls).toBe(204);
  });

  it("reads a corrupt file as empty and skips a bad line", async () => {
    const store = fileStore(dir);
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "envelope.json"), "{not json");
    await writeFile(join(folder(), "ledger.jsonl"), `garbage\n${JSON.stringify({ runId: "ok" })}\n[1]\n`);
    expect(await store.envelopes(repo)).toEqual({});
    expect(await store.ledger(repo)).toEqual([{ runId: "ok" }]);
    await store.updateEnvelopes(repo, () => ({ p: [1] }));
    expect(await store.envelopes(repo)).toEqual({ p: [1] });
  });

  it("reads a run's events, skipping garbled lines", async () => {
    const store = fileStore(dir);
    await mkdir(join(dir, "runs", "r9", "out"), { recursive: true });
    await writeFile(join(dir, "runs", "r9", "out", "events.jsonl"), `{"kind":"text"}\n{bad\n`);
    expect(await store.events("r9")).toEqual([{ kind: "text" }]);
  });
});

describe("fileStore: tool pruning", () => {
  it("reads nothing before anything is written, and round-trips a pack's state privately", async () => {
    const store = fileStore(dir);
    expect(await store.tools(repo)).toEqual({});
    const state = { units: { web: { unusedRuns: 3, unusedCards: ["c1", "c2"], everUsed: false, kept: false } }, mask: ["agent"], proposal: ["web"] };
    await store.updateTools(repo, (all) => ({ ...all, triage: state }));
    expect(await store.tools(repo)).toEqual({ triage: state });
    expect((await stat(join(folder(), "tools.json"))).mode & 0o777).toBe(0o600);
  });

  it("drops the skill units a file written before skills left the pruning still holds", async () => {
    const store = fileStore(dir);
    await mkdir(folder(), { recursive: true });
    const unit = { unusedRuns: 3, unusedCards: ["c1"], everUsed: false, kept: false };
    await writeFile(join(folder(), "tools.json"), JSON.stringify({ triage: { units: { web: unit, "skill:tdd": unit }, mask: ["agent", "skill:tdd"], proposal: ["skill:tdd", "web"] } }));
    expect(await store.tools(repo)).toEqual({ triage: { units: { web: unit }, mask: ["agent"], proposal: ["web"] } });
  });

  it("reads a corrupt file as empty and drops a pack whose state is not one", async () => {
    const store = fileStore(dir);
    await mkdir(folder(), { recursive: true });
    await writeFile(join(folder(), "tools.json"), "{nope");
    expect(await store.tools(repo)).toEqual({});
    await writeFile(join(folder(), "tools.json"), JSON.stringify({ triage: { units: 3, mask: [], proposal: [] }, ok: { units: {}, mask: [], proposal: [] } }));
    expect(await store.tools(repo)).toEqual({ ok: { units: {}, mask: [], proposal: [] } });
  });
});

describe("fileStore: the folded runs", () => {
  it("keeps the ids of the runs folded, each once, privately", async () => {
    const store = fileStore(dir);
    expect(await store.imported(repo)).toEqual([]);
    await store.markImported(repo, ["a", "b"]);
    await store.markImported(repo, ["b", "c"]);
    expect(await store.imported(repo)).toEqual(["a", "b", "c"]);
    expect((await stat(join(folder(), "imported.json"))).mode & 0o777).toBe(0o600);
  });

  it("reads a corrupt file as empty", async () => {
    const store = fileStore(dir);
    await store.markImported(repo, ["a"]);
    await writeFile(join(folder(), "imported.json"), "{nope");
    expect(await store.imported(repo)).toEqual([]);
  });
});
