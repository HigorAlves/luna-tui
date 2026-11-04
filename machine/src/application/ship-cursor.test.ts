import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SEEN_CAP, type ShipCursor, emptyCursor, loadCursor, saveCursor } from "./ship-cursor.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ship-cursor-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("the ship cursor", () => {
  it("is null before the first save", async () => {
    expect(await loadCursor(dir, "t1")).toBeNull();
  });

  it("round-trips under tasks/<id>/ship.json", async () => {
    const cursor: ShipCursor = { ...emptyCursor({ slug: "o/a", number: 3 }), since: "2026-11-04T10:00:00Z", seen: ["comment:1"], threads: { T1: { replies: 1, lastAt: "t" } }, fixRounds: 1, published: { sha: "abc" } };
    await saveCursor(dir, "t1", cursor);
    expect(await loadCursor(dir, "t1")).toEqual(cursor);
    expect(JSON.parse(await readFile(join(dir, "tasks", "t1", "ship.json"), "utf8"))).toMatchObject({ schema: 1, pr: { slug: "o/a", number: 3 } });
  });

  it("writes atomically: no temp file is left beside it", async () => {
    await saveCursor(dir, "t1", emptyCursor({ slug: "o/a", number: 3 }));
    await saveCursor(dir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), fixRounds: 2 });
    expect(await readdir(join(dir, "tasks", "t1"))).toEqual(["ship.json"]);
  });

  it("caps the seen ids at the newest ones", async () => {
    const seen = Array.from({ length: SEEN_CAP + 20 }, (_, i) => `comment:${i}`);
    await saveCursor(dir, "t1", { ...emptyCursor({ slug: "o/a", number: 3 }), seen });
    const back = await loadCursor(dir, "t1");
    expect(back!.seen).toHaveLength(SEEN_CAP);
    expect(back!.seen.at(-1)).toBe(`comment:${SEEN_CAP + 19}`);
  });

  it("reads a damaged or foreign file as no cursor, never a crash", async () => {
    await saveCursor(dir, "t1", emptyCursor({ slug: "o/a", number: 3 }));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "tasks", "t1", "ship.json"), "{not json");
    expect(await loadCursor(dir, "t1")).toBeNull();
    await writeFile(join(dir, "tasks", "t1", "ship.json"), JSON.stringify({ schema: 2 }));
    expect(await loadCursor(dir, "t1")).toBeNull();
  });
});
