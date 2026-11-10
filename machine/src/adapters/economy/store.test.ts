import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ledgerRecord } from "../../domain/economy/ledger.ts";
import { repoSlug } from "../graph/slug.ts";
import { fileStore } from "./store.ts";

let dir: string;
const repo = "/work/api";
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), "economy-store-"))));
afterEach(() => rm(dir, { recursive: true, force: true }));
const folder = () => join(dir, "economy", repoSlug(repo));
const row = (n: number) => ({ action: "gate" as const, calls: n, at: "t", runId: `r${n}`, pack: "implementing" });

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
