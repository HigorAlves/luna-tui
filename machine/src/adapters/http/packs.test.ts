import { PACKS, PackId } from "@hardness/contracts";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});

describe("GET /packs", () => {
  it("lists every pack in the registry with the states it runs in", async () => {
    const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });
    const response = await createApp({ db, pipeline, bus: new Bus() }).request("/packs");
    expect(response.status).toBe(200);
    const packs = (await response.json()) as Array<Record<string, unknown>>;
    expect(packs.map((p) => p.id)).toEqual(PackId.options);
    expect(packs.find((p) => p.id === "implementing")).toEqual({
      id: "implementing",
      agent: "implementer",
      kind: "agent",
      engines: PACKS.implementing.engines,
      effort: PACKS.implementing.effort,
      writable: true,
      maxTurns: PACKS.implementing.maxTurns,
      timeoutMs: PACKS.implementing.timeoutMs,
      states: ["implementing"],
    });
  });
});
