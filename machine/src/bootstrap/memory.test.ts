// Boot: memory is the quiet port until Cognee takes the machine's login, then the real one; off and unreachable are told on the Floor.
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryConfig } from "../config.ts";
import { fakeCognee } from "../test/cognee.ts";
import { freshTestDatabase } from "../test/database.ts";
import { memoryBoot } from "./memory.ts";

let db: DataSource;
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate memory_items, memory_cognify_days");
});

const config = (extra: Partial<MemoryConfig> = {}): MemoryConfig => ({ enabled: true, url: "http://cognee:8000", email: "m@x.example.com", password: "pw-123456", mode: "local", dailyCognifyItems: 200, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const draft = { kind: "finding" as const, repo: "app", source: { kind: "github" as const, ref: null }, anchors: { files: [], commit: null }, provenance: { by: "machine" as const, card: null, run: null, pack: null }, trust: "fact" as const, text: "a lesson" };

describe("memoryBoot", () => {
  it("stays quiet and says so when memory is off, and never touches Cognee", async () => {
    const boot = memoryBoot({ config: config({ enabled: false }), db, log: () => {}, makeClient: () => { throw new Error("must not connect"); } });
    boot.start();
    expect(boot.memory.enabled).toBe(false);
    expect(await boot.memory.write([draft])).toEqual([]);
    expect(await boot.floor()).toMatchObject({ enabled: false, mode: null, note: "memory is off (MACHINE_MEMORY=off)" });
  });

  it("says there is no password until `pnpm start` made one", async () => {
    const boot = memoryBoot({ config: config({ password: null }), db, log: () => {}, retryMs: 5000 });
    boot.start();
    await wait(20);
    expect((await boot.floor()).note).toMatch(/pnpm start/);
    boot.stop();
  });

  it("starts quiet when Cognee is down, connects on a later try, and is then the real memory with its mode on the Floor", async () => {
    const cognee = fakeCognee();
    cognee.down = true;
    const boot = memoryBoot({ config: config({ mode: "openai" }), db, log: () => {}, makeClient: () => cognee, retryMs: 30, reconcileMs: 10_000 });
    boot.start();
    await wait(20);
    expect(boot.memory.enabled).toBe(false);
    expect((await boot.floor()).note).toMatch(/did not take the login/);
    cognee.down = false;
    await wait(120);
    expect(boot.memory.enabled).toBe(true);
    expect(boot.memory.mode).toBe("openai");
    const [item] = await boot.memory.write([draft]);
    expect(item!.status).toBe("active");
    expect(await boot.floor()).toMatchObject({ enabled: true, mode: "openai", items: 1, pending: 0, dailyCognifyItems: 200 });
    boot.stop();
  });

  it("sends rows left pending by a Cognee that went away, on its retry loop", async () => {
    const cognee = fakeCognee();
    const boot = memoryBoot({ config: config(), db, log: () => {}, makeClient: () => cognee, retryMs: 30, reconcileMs: 10_000 });
    boot.start();
    await wait(60);
    cognee.failAdds = 1;
    const [lost] = await boot.memory.write([draft]);
    expect(lost!.status).toBe("pending");
    await wait(120);
    expect(await boot.memory.get(lost!.id)).toMatchObject({ status: "active" });
    boot.stop();
  });
});
