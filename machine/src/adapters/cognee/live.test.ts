// The contract test against a real Cognee (RFC 0007: an upgrade of the pinned digest must pass it). Skipped unless COGNEE_LIVE_URL names one,
// keyless is fine: `COGNEE_LIVE_URL=http://127.0.0.1:8010 pnpm -C machine test src/adapters/cognee/live`. It registers its own user and
// writes only to datasets named `m1live-*`, which it deletes.
import { randomBytes } from "node:crypto";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { freshTestDatabase } from "../../test/database.ts";
import { PgMemoryStore } from "../persistence/memory-store.ts";
import { cogneeClient } from "./client.ts";
import { cogneeMemory } from "./memory.ts";

const url = process.env.COGNEE_LIVE_URL;

describe.skipIf(!url)("Cognee, live", () => {
  let db: DataSource;
  beforeAll(async () => {
    db = await freshTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("writes, recalls by meaning with the row's id, replaces a document, forgets, and reconciles an upload made outside", async () => {
    const repo = `m1live-${randomBytes(3).toString("hex")}`;
    const client = cogneeClient({ baseUrl: url!, email: "m1-live@luna.example.com", password: "m1-live-password" });
    await client.connect();
    const memory = cogneeMemory({ client, store: new PgMemoryStore(db), mode: "local" });
    const viewer = { kind: "card" as const, repo, source: { kind: "github" as const, ref: null }, publicPost: false };
    const base = { kind: "finding" as const, repo, source: { kind: "github" as const, ref: null }, anchors: { files: [], commit: null }, provenance: { by: "machine" as const, card: "c1", run: null, pack: null }, trust: "fact" as const };

    const [flaky, retries] = await memory.write([{ ...base, text: "Verify escalated because the payments tests were flaky" }, { ...base, text: "Reviewers keep asking for retries to be capped at three" }]);
    expect(flaky!.status).toBe("active");
    expect(flaky!.cogneeDataId).toBeTruthy();
    await memory.cognify([`${repo}:github`]);

    const found = await memory.recall({ query: "which tests were unreliable", viewer });
    expect(found.items.map((i) => i.id)).toContain(flaky!.id);
    expect(found.items.find((i) => i.id === flaky!.id)!.score).toBeGreaterThan(0);

    const doc = await memory.ingestDoc({ repo, path: "docs/a.md", name: "a.md", content: Buffer.from("# Runbook\nRotate the signing key every ninety days.") });
    expect(doc!.status).toBe("active");
    // Nothing is searchable before cognify: it chunks and embeds what was added.
    await memory.cognify([`${repo}:docs`]);
    const docHit = await memory.recall({ query: "how often is the signing key rotated", viewer, scope: "docs" });
    expect(docHit.items.map((i) => i.id)).toContain(doc!.id);
    const v2 = await memory.ingestDoc({ repo, path: "docs/a.md", name: "a.md", content: Buffer.from("# Runbook\nRotate the signing key every thirty days.") });
    expect((await memory.get(doc!.id))!.status).toBe("retired");
    expect(v2!.id).not.toBe(doc!.id);

    const datasets = await client.datasets();
    const github = datasets.find((d) => d.name === `${repo}:github`)!;
    await client.add({ dataset: `${repo}:github`, items: [{ lunaId: "outside-1", text: "Pasted in the UI: deploys happen on Tuesdays" }] });
    const reconciled = await memory.reconcile();
    expect(reconciled.added).toBeGreaterThanOrEqual(1);
    expect((await memory.list({ repo, trust: ["outside"] })).length).toBeGreaterThanOrEqual(1);

    expect(await memory.forget(retries!.id, "live-test")).toBe(true);
    const gone = await client.data(github.id);
    expect(gone.some((i) => i.id === retries!.cogneeDataId)).toBe(false);

    for (const name of [`${repo}:github`, `${repo}:docs`]) {
      const d = (await client.datasets()).find((x) => x.name === name);
      if (d) for (const item of await client.data(d.id)) await client.deleteData(d.id, item.id);
    }
  }, 120_000);
});
