// A config proposal is a card with no stage: it waits at the setup gate with the new luna.yaml, and approving it writes the file.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Candidate, ConfigChange } from "../domain/config-proposal.ts";
import { freshTestDatabase } from "../test/database.ts";
import { previewOn } from "../test/policies.ts";
import { ConfigRebuildError, Pipeline } from "./pipeline.ts";
import { StubStages } from "./stages/stubs.ts";

let db: DataSource;
const stubs = new StubStages();
beforeAll(async () => {
  db = await freshTestDatabase();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(async () => {
  await db.query("truncate tasks cascade");
});

const make = () => new Pipeline(db, stubs.runnerFor, { inline: true, policies: previewOn });
const repo = (yaml = "checks:\n  - { name: unit, run: pnpm test, timeout: 5 }\nengines:\n  plan: claude:opus\n") => {
  const dir = mkdtempSync(join(tmpdir(), "config-proposal-"));
  writeFileSync(join(dir, "luna.yaml"), yaml);
  return dir;
};
const card = (engine: string, quality: number): Candidate => ({ engine: engine as Candidate["engine"], effort: "high", n: 5, quality, costPerCase: 1, at: "2026-11-01" });
const toSol: ConfigChange = { pack: "plan", engine: { from: "claude:opus", to: "codex:sol" }, effort: null, why: "plan escalated 4 of 12 runs; codex:sol at high passed 0.83 vs 0.67", evidence: { current: card("claude:opus", 0.67), next: card("codex:sol", 0.83), signal: { runs: 12, escalations: 4, stuck: 0, costUsd: 3 } } };
const lowTriage: ConfigChange = { pack: "triage", engine: null, effort: { from: "high", to: "medium" }, why: "triage escalated 0 of 20 runs; claude:opus at medium passed 0.88 vs 0.90", evidence: { current: card("claude:opus", 0.9), next: card("claude:opus", 0.88), signal: { runs: 20, escalations: 0, stuck: 0, costUsd: 3 } } };

describe("pipeline.proposeConfig", () => {
  it("waits at the setup gate with the new file, the old one and the changes, and runs no stage", async () => {
    const p = make();
    const dir = repo();
    const task = await p.proposeConfig(dir, [toSol, lowTriage]);
    expect(task).toMatchObject({ route: "config", state: "awaiting_setup", repoPath: dir, title: "Config proposal: 2 changes" });
    const gate = (await p.approvals(task.id)).find((a) => a.decision === null)!;
    expect(gate.kind).toBe("awaiting_setup");
    expect(gate.requested.previous).toContain("plan: claude:opus");
    expect(gate.requested.config).toContain("plan: codex:sol");
    expect(gate.requested.config).toMatch(/effort:\n {2}triage: medium/);
    expect(gate.requested.config).toContain("name: unit");
    expect(gate.requested.changes).toEqual([toSol, lowTriage]);
    expect(await p.stageRuns(task.id)).toEqual([]);
  });

  it("titles one change in the singular", async () => {
    expect((await make().proposeConfig(repo(), [toSol])).title).toBe("Config proposal: 1 change");
  });

  it("approving writes the file, logs it and closes the card", async () => {
    const p = make();
    const dir = repo();
    const task = await p.proposeConfig(dir, [toSol]);
    const closed = await p.decide(task.id, "approved");
    expect(closed.state).toBe("closed");
    expect(readFileSync(join(dir, "luna.yaml"), "utf8")).toContain("plan: codex:sol");
    expect((await p.events(task.id)).map((e) => e.kind)).toContain("config.written");
  });

  it("approving writes the stored text when the file is unchanged since the card was made", async () => {
    const p = make();
    const dir = repo();
    const task = await p.proposeConfig(dir, [toSol]);
    const stored = (await p.approvals(task.id))[0]!.requested.config;
    await p.decide(task.id, "approved");
    expect(readFileSync(join(dir, "luna.yaml"), "utf8")).toBe(stored);
  });

  it("approving keeps an edit made to the file since the card was made, and applies the changes over it", async () => {
    const p = make();
    const dir = repo();
    const task = await p.proposeConfig(dir, [toSol]);
    writeFileSync(join(dir, "luna.yaml"), "# edited\nchecks:\n  - { name: unit, run: pnpm test, timeout: 5 }\nengines:\n  plan: claude:opus\nlearning:\n  records: false\n");
    await p.decide(task.id, "approved");
    const written = readFileSync(join(dir, "luna.yaml"), "utf8");
    expect(written).toContain("# edited");
    expect(written).toContain("learning:\n  records: false");
    expect(written).toContain("plan: codex:sol");
  });

  it("refuses to approve when the edited file cannot take the changes, and leaves the card and the file", async () => {
    const p = make();
    const dir = repo();
    const task = await p.proposeConfig(dir, [toSol]);
    writeFileSync(join(dir, "luna.yaml"), "engines: [not, a, map\n");
    await expect(p.decide(task.id, "approved")).rejects.toBeInstanceOf(ConfigRebuildError);
    expect(readFileSync(join(dir, "luna.yaml"), "utf8")).toBe("engines: [not, a, map\n");
    expect((await p.get(task.id)).state).toBe("awaiting_setup");
  });

  it("rejecting archives the card, keeps the changes and leaves the file alone", async () => {
    const p = make();
    const dir = repo();
    const before = readFileSync(join(dir, "luna.yaml"), "utf8");
    const task = await p.proposeConfig(dir, [toSol]);
    const archived = await p.decide(task.id, "rejected", "not now");
    expect(archived).toMatchObject({ state: "archived", archiveReason: "rejected" });
    expect(readFileSync(join(dir, "luna.yaml"), "utf8")).toBe(before);
    const gate = (await p.approvals(task.id))[0]!;
    expect(gate).toMatchObject({ decision: "rejected", requested: { changes: [{ pack: "plan" }] } });
  });

  it("reads rejected cards of the last 30 days back as declined, per field", async () => {
    const p = make();
    const dir = repo();
    const one = await p.proposeConfig(dir, [toSol, lowTriage]);
    await p.decide(one.id, "rejected");
    // Another repo's card and an approved one are not declined.
    const other = repo();
    await p.decide((await p.proposeConfig(other, [toSol])).id, "rejected");
    const approved = await p.proposeConfig(dir, [lowTriage]);
    await p.decide(approved.id, "approved");
    const now = new Date();
    const declined = await p.declinedConfigChanges(dir, now);
    expect(declined.map((d) => [d.pack, d.field, d.to]).sort()).toEqual([
      ["plan", "engine", "codex:sol"],
      ["triage", "effort", "medium"],
    ]);
    expect(Date.parse(declined[0]!.at)).toBeLessThanOrEqual(now.getTime());
    // Read 31 days on, none counts.
    expect(await p.declinedConfigChanges(dir, new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000))).toEqual([]);
  });

  it("keeps one open card per repo: a second proposal replaces what the first asked", async () => {
    const p = make();
    const dir = repo();
    const first = await p.proposeConfig(dir, [toSol]);
    const second = await p.proposeConfig(dir, [toSol, lowTriage]);
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Config proposal: 2 changes");
    const gates = await p.approvals(first.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.requested.changes).toHaveLength(2);
    expect((await p.list()).filter((t) => t.route === "config")).toHaveLength(1);
    // Another repo gets its own.
    expect((await p.proposeConfig(repo(), [toSol])).id).not.toBe(first.id);
  });

  it("creates nothing when the new file does not render valid", async () => {
    const p = make();
    const dir = repo();
    // A decision pack takes no effort, so the new luna.yaml would not load.
    const bad: ConfigChange = { ...lowTriage, pack: "risk_score" };
    await expect(p.proposeConfig(dir, [bad])).rejects.toThrow(/risk_score/);
    expect((await p.list()).filter((t) => t.route === "config")).toEqual([]);
  });

  it("starts from an empty file when the repo has no luna.yaml", async () => {
    const p = make();
    const dir = mkdtempSync(join(tmpdir(), "config-proposal-"));
    const task = await p.proposeConfig(dir, [toSol]);
    const gate = (await p.approvals(task.id))[0]!;
    expect(gate.requested.previous).toBe("");
    await p.decide(task.id, "approved");
    expect(existsSync(join(dir, "luna.yaml"))).toBe(true);
  });
});
