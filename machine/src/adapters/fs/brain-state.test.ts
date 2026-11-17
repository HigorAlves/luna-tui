import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { brainJournal } from "./brain-state.ts";

const empty = { cursor: { tasks: null, verdicts: null, claims: null, wiki: {} }, nodes: {}, edges: [] };

describe("brainJournal", () => {
  it("reads as the empty state when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    expect(await brainJournal(dir).read()).toEqual(empty);
  });

  it("writes the state to a 0600 file in a 0700 folder and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const state = {
      cursor: { tasks: "2026-01-01T00:00:00.000Z", verdicts: null, claims: "2026-01-02T00:00:00.000Z", wiki: { "luna-ab12": "2026-01-02T01:00:00.000Z" } },
      nodes: { "repo:a": { type: "Repo" as const, data: { slug: "repo:a", name: "a" } } },
      edges: [{ edge: "CardInRepo" as const, from: "card:1", to: "repo:a" }],
    };
    const journal = brainJournal(dir);
    await journal.write(state);
    expect(await journal.read()).toEqual(state);
    expect((await stat(join(dir, "brain", "journal.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "brain"))).mode & 0o777).toBe(0o700);
  });

  // The journal is the only copy of what was learned from pruned history: a damaged one must stop the projector, not be written over.
  it("refuses a file that does not parse or has the wrong shape, and never reads it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write(empty);
    await writeFile(join(dir, "brain", "journal.json"), "{not json");
    await expect(journal.read()).rejects.toThrow(/not JSON/);
    await writeFile(join(dir, "brain", "journal.json"), JSON.stringify({ nodes: 3 }));
    await expect(journal.read()).rejects.toThrow(/wrong shape/);
  });

  // A journal written before claims existed has no such key; that is an old file, not a damaged one.
  it("reads a journal with no claims cursor as null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write(empty);
    await writeFile(join(dir, "brain", "journal.json"), JSON.stringify({ cursor: { tasks: "t", verdicts: "v" }, nodes: {}, edges: [] }));
    expect((await journal.read()).cursor).toEqual({ tasks: "t", verdicts: "v", claims: null, wiki: {} });
  });

  // A rebuild that was cut short leaves this flag; a journal from before it has no key, which is not set.
  it("keeps the rebuild flag through a write and a read, and reads a file without the key as not set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write({ ...empty, rebuild: true });
    expect((await journal.read()).rebuild).toBe(true);
    await writeFile(join(dir, "brain", "journal.json"), JSON.stringify(empty));
    expect((await journal.read()).rebuild).toBeFalsy();
  });

  it("serves two writes one at a time, leaving the last", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    const a = { ...empty, cursor: { tasks: "a", verdicts: null, claims: null, wiki: {} } };
    const b = { ...empty, cursor: { tasks: "b", verdicts: null, claims: null, wiki: {} } };
    await Promise.all([journal.write(a), journal.write(b)]);
    expect((await journal.read()).cursor.tasks).toBe("b");
    expect(JSON.parse(await readFile(join(dir, "brain", "journal.json"), "utf8")).cursor.tasks).toBe("b");
  });

  it("keeps the previous journal as journal.json.bak, and the journal itself is there between any two writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    const first = { ...empty, cursor: { tasks: "first", verdicts: null, claims: null, wiki: {} } };
    const second = { ...empty, cursor: { tasks: "second", verdicts: null, claims: null, wiki: {} } };
    await journal.write(first);
    await journal.write(second);
    expect(JSON.parse(await readFile(join(dir, "brain", "journal.json.bak"), "utf8")).cursor.tasks).toBe("first");
    expect(JSON.parse(await readFile(join(dir, "brain", "journal.json"), "utf8")).cursor.tasks).toBe("second");
    expect((await stat(join(dir, "brain", "journal.json.bak"))).mode & 0o777).toBe(0o600);
  });

  // A journal that went missing next to a .bak is a loss to look at, not a new start.
  it("refuses to start empty when journal.json is gone and a .bak is there, and names the .bak", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write(empty);
    await journal.write(empty);
    await rm(join(dir, "brain", "journal.json"));
    await expect(journal.read()).rejects.toThrow(/journal\.json\.bak/);
  });

  // A forgotten slug must never be written again; a file from before the key has none.
  it("keeps the forgotten slugs through a write and a read, and reads a file without the key as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write({ ...empty, forgotten: ["person:ada"] });
    expect((await journal.read()).forgotten).toEqual(["person:ada"]);
    await writeFile(join(dir, "brain", "journal.json"), JSON.stringify(empty));
    expect((await journal.read()).forgotten).toBeUndefined();
  });

  it("removes the previous generation when asked, so it holds nothing that was forgotten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-journal-"));
    const journal = brainJournal(dir);
    await journal.write({ ...empty, nodes: { "person:ada": { type: "Person" as const, data: { slug: "person:ada", login: "ada" } } } });
    await journal.write(empty);
    await expect(access(join(dir, "brain", "journal.json.bak"))).resolves.toBeUndefined();
    await journal.write({ ...empty, forgotten: ["person:ada"] }, { dropPrevious: true });
    await expect(access(join(dir, "brain", "journal.json.bak"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(dir, "brain", "journal.json"), "utf8")).forgotten).toEqual(["person:ada"]);
    // The next ordinary write starts a .bak again.
    await journal.write(empty);
    expect(JSON.parse(await readFile(join(dir, "brain", "journal.json.bak"), "utf8")).forgotten).toEqual(["person:ada"]);
  });
});
