// `POST /tasks/:id/evidence/feedback`: a person says whether the Evidence Pack was useful. A card with no pack is a 409; the answer is a boolean and an optional note
// (500 characters at most, flattened); the machine writes the ground-truth file and logs `evidence.feedback` with no text.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { evidenceFeedbackWriter } from "../../application/ground-truth.ts";
import { Pipeline } from "../../application/pipeline.ts";
import { StubStages } from "../../application/stages/stubs.ts";
import { freshTestDatabase } from "../../test/database.ts";
import { previewOn } from "../../test/policies.ts";
import { createApp } from "./app.ts";
import { Bus } from "./bus.ts";

let db: DataSource;
let pipeline: Pipeline;
let stateDir: string;
const pack = { summary: "s", format: "text" as const, scenarios: [], findings: [], outOfMap: [], risk: "low" as const, rollback: "r", howToVerify: "h", commitSha: "abc1234def5678", media: [], at: "2026-11-04T00:00:00.000Z" };

beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
  stateDir = mkdtempSync(join(tmpdir(), "feedback-"));
  pipeline = new Pipeline(db, new StubStages().runnerFor, { inline: true, policies: previewOn, hasConfig: () => true, evidenceFeedback: evidenceFeedbackWriter(stateDir) });
});

const post = async (id: string, body: unknown) => {
  const response = await createApp({ db, pipeline, bus: new Bus() }).request(`/tasks/${id}/evidence/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("POST /tasks/:id/evidence/feedback", () => {
  it("refuses a card with no pack: 409 no_evidence", async () => {
    const task = await pipeline.createTask({ title: "Login" });
    expect(await post(task.id, { useful: true })).toMatchObject({ status: 409, body: { error: "no_evidence" } });
  });

  it("is a 400 for a value outside the fixed set, a note over 500 characters, and an unknown task a 404", async () => {
    const task = await pipeline.createTask({ title: "Login", evidence: pack });
    for (const body of [{ useful: "yes" }, {}, { useful: true, note: "x".repeat(501) }, { useful: 1 }]) expect((await post(task.id, body)).status).toBe(400);
    expect((await post("00000000-0000-4000-8000-000000000000", { useful: true })).status).toBe(404);
  });

  it("writes the ground-truth file, logs evidence.feedback with ids and enums only, and the last answer for a commit wins", async () => {
    const task = await pipeline.createTask({ title: "Login", evidence: pack });
    expect((await post(task.id, { useful: false, note: "<b>too</b> long @bob" })).status).toBe(200);
    expect((await post(task.id, { useful: true })).status).toBe(200);
    const path = join(stateDir, "ground-truth", "evidence", `${task.id}-abc1234.json`);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ useful: true, taskId: task.id, commit: "abc1234def5678" });
    const rows = (await pipeline.events(task.id)).filter((e) => e.kind === "evidence.feedback");
    expect(rows.map((r) => r.payload)).toEqual([{ useful: false, format: "text", sha: "abc1234" }, { useful: true, format: "text", sha: "abc1234" }]);
  });

  it("flattens the note in the file", async () => {
    const task = await pipeline.createTask({ title: "Login", evidence: pack });
    await post(task.id, { useful: false, note: "<b>too</b>\nlong @bob" });
    const file = JSON.parse(readFileSync(join(stateDir, "ground-truth", "evidence", `${task.id}-abc1234.json`), "utf8")) as { note: string };
    expect(file.note).not.toMatch(/[<>\n]/);
    expect(file.note).not.toContain("@bob");
  });
});
