import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewOn } from "../../test/policies.ts";

import { ConfigProofs } from "../../application/config-proofs.ts";
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

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as const;

describe("the setup skill's luna.yaml routes", () => {
  const pipeline = () => new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true });

  it("POST /repos/config/check reads the text it is given: problems, warnings and unknown keys", async () => {
    const app = createApp({ db, pipeline: pipeline(), bus: new Bus() });
    const good = await app.request("/repos/config/check", post({ text: "checks:\n  - { name: unit, run: pnpm test, timeout: 5 }\n" }));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, problems: [], warnings: [], unknownKeys: ["checks[0].timeout"] });
    const bad = await app.request("/repos/config/check", post({ text: "policy:\n  qa: sometimes\n" }));
    expect(await bad.json()).toMatchObject({ ok: false, problems: [expect.stringContaining("policy.qa")] });
    expect((await app.request("/repos/config/check", post({}))).status).toBe(400);
  });

  it("POST /repos/config/prove starts a job read by id, and answers 503 with no sandbox", async () => {
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    writeFileSync(join(repo, "luna.yaml"), "checks:\n  - { name: unit, run: pnpm test }\n");
    const configProofs = new ConfigProofs({ exec: async () => ({ code: 0, stdout: "ok", stderr: "" }), gitIdentity: async () => null });
    const app = createApp({ db, pipeline: pipeline(), bus: new Bus(), configProofs });
    const started = await app.request("/repos/config/prove", post({ repoPath: repo }));
    expect(started.status).toBe(202);
    const { id } = (await started.json()) as { id: string };
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 100 && job.state !== "done"; i++) {
      job = (await (await app.request(`/repos/config/prove/${id}`)).json()) as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job).toMatchObject({ state: "done", proof: { proof: [{ name: "unit", ok: true }] } });
    expect((await app.request("/repos/config/prove/nope")).status).toBe(404);
    expect((await app.request("/repos/config/prove", post({ repoPath: "relative" }))).status).toBe(400);
    const off = createApp({ db, pipeline: pipeline(), bus: new Bus() });
    expect((await off.request("/repos/config/prove", post({ repoPath: repo }))).status).toBe(503);
  });
});
