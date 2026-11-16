import { DEFAULT_MACHINE_POLICY, type MachinePolicy } from "@hardness/contracts";
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

const health = async (problems?: () => Promise<string[]> | string[], sandboxPolicy?: MachinePolicy) => {
  const pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, maxConcurrentTasks: 2 });
  const response = await createApp({ db, pipeline, bus: new Bus(), ...(problems ? { problems } : {}), ...(sandboxPolicy ? { sandboxPolicy } : {}) }).request("/health");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("GET /health", () => {
  it("answers 200 when the machine can do its job, and when nothing reports a problem", async () => {
    expect(await health()).toMatchObject({ status: 200, body: { ok: true } });
    expect(await health(() => [])).toMatchObject({ status: 200, body: { ok: true, slots: { max: 2 } } });
  });

  it("answers 503 with the problems, and still the stage pool, so the compose healthcheck fails and a client can show why", async () => {
    const res = await health(async () => ["no GitHub token", "git has no identity"]);
    expect(res).toMatchObject({ status: 503, body: { ok: false, problems: ["no GitHub token", "git has no identity"], slots: { max: 2 } } });
  });

  it("shows the sandbox policy in force, on a 200 and on a 503", async () => {
    const policy = { ...DEFAULT_MACHINE_POLICY, limits: { ...DEFAULT_MACHINE_POLICY.limits, max_cpu: 4 } };
    expect(await health(undefined, policy)).toMatchObject({ status: 200, body: { ok: true, sandboxPolicy: { limits: { max_cpu: 4 } } } });
    expect(await health(() => ["x"], policy)).toMatchObject({ status: 503, body: { sandboxPolicy: { limits: { max_cpu: 4 } } } });
    expect((await health()).body).not.toHaveProperty("sandboxPolicy");
  });
});
