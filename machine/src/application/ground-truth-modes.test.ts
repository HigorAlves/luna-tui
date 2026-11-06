// Every ground-truth writer leaves owner-only files in owner-only folders, whatever the process's umask.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { ConversationTruth } from "./conversation-truth.ts";
import { priorityTruth, escalationTruthWriter, evidenceFeedbackWriter, groundTruthWriter, ticketTruthWriter, writeTruthFile } from "./ground-truth.ts";
import { appendAddedFinding, retroTruthOf, writeRetroTruth } from "./retro-outputs.ts";

const mode = (path: string): number => statSync(path).mode & 0o777;
const task = { id: "t1", title: "Login", description: "d", criteria: ["c"], branch: "task/t1" } as unknown as TaskRow;
const gate = { id: "a1", taskId: "t1", kind: "awaiting_approval", requested: { brief: "b" }, decision: "approved", reason: null, response: {}, createdAt: new Date(0), decidedAt: new Date(0) } as unknown as ApprovalRow;
const pack = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "abc1234def5678", media: [], at: "t", revision: 1 } as never;
const facts = { predicted: { size: "small", risk: "low", estLoc: 100, urgency: "high" }, actual: { added: 50, removed: 5, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 1, format: "text", durationMin: 30, overrides: 2 }, runs: 6 };
const classification = { kind: "bug", confidence: 0.9, by: "model" as const, at: "2026-10-28T00:00:00.000Z", records: { assess: "rec-1" }, verdict: "ok" as const, priority: "P0", knockOut: "production_down", total: 22, scores: { who: { score: 3, confidence: 0.9 } } };

let umask = 0;
beforeAll(() => {
  // A permissive umask: only an explicit mode keeps the files private.
  umask = process.umask(0o000);
});
afterAll(() => void process.umask(umask));

const check = (stateDir: string, kind: string, path: string) => {
  expect(mode(path), path).toBe(0o600);
  expect(mode(join(stateDir, "ground-truth", kind)), kind).toBe(0o700);
  expect(mode(join(stateDir, "ground-truth")), "ground-truth").toBe(0o700);
};
const dir = () => mkdtempSync(join(tmpdir(), "gtm-"));

describe("writeTruthFile", () => {
  it("makes folders 0700 and the file 0600, writes through a temporary name, and leaves none behind", async () => {
    const stateDir = dir();
    const path = await writeTruthFile(stateDir, "plan", "t1-a1.json", "{}\n");
    expect(path).toBe(join(stateDir, "ground-truth", "plan", "t1-a1.json"));
    check(stateDir, "plan", path);
    expect(readdirSync(join(stateDir, "ground-truth", "plan"))).toEqual(["t1-a1.json"]);
  });

  it("tightens a file that was left open by an earlier version when it rewrites it", async () => {
    const stateDir = dir();
    await writeTruthFile(stateDir, "plan", "x.json", "1");
    writeFileSync(join(stateDir, "ground-truth", "plan", "x.json"), "old", { mode: 0o644 });
    const path = await writeTruthFile(stateDir, "plan", "x.json", "2");
    expect(mode(path)).toBe(0o600);
  });

  it("refuses a name or a kind that is not made of letters, digits, dots, dashes and underscores", async () => {
    const stateDir = dir();
    for (const name of ["../x.json", "a/b.json", "a b.json", "", ".", ".."]) await expect(writeTruthFile(stateDir, "plan", name, "{}"), name).rejects.toThrow(/name/);
    await expect(writeTruthFile(stateDir, "../plan", "a.json", "{}")).rejects.toThrow(/kind/);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});

describe("every writer leaves owner-only files", () => {
  it("the plan writer", async () => {
    const stateDir = dir();
    check(stateDir, "plan", await groundTruthWriter(stateDir)(task, gate));
  });
  it("the escalation writer", async () => {
    const stateDir = dir();
    check(stateDir, "escalation", await escalationTruthWriter(stateDir)(task, gate, [], null));
  });
  it("the ticket writer", async () => {
    const stateDir = dir();
    check(stateDir, "ticket", await ticketTruthWriter(stateDir)({ key: "ABC-1", draft: "d1", kind: "reply", did: "sent", original: "o", final: null, at: "2026-11-06T10:00:00Z" }));
  });
  it("the evidence writer", async () => {
    const stateDir = dir();
    check(stateDir, "evidence", await evidenceFeedbackWriter(stateDir)(task, pack, { useful: true }, new Date("2026-11-06T10:00:00Z")));
  });
  it("the retro writer", async () => {
    const stateDir = dir();
    check(stateDir, "retro", await writeRetroTruth(stateDir, retroTruthOf({ taskId: "t9", facts, retro: null, adopted: false })));
  });
  it("the added finding", async () => {
    const stateDir = dir();
    await appendAddedFinding(stateDir, "t9", { title: "a finding", severity: "major" });
    await appendAddedFinding(stateDir, "t9", { title: "another", severity: "minor" });
    check(stateDir, "verify", join(stateDir, "ground-truth", "verify", "t9.json"));
  });
  it("the conversation outcome and override", async () => {
    const stateDir = dir();
    const truth = new ConversationTruth(stateDir, null);
    await truth.outcome({ thread: "C1:1.0", draft: "d1", outcome: "ignored", machine: "m", records: {} });
    await truth.override({ thread: "C1:2.0", classification, kind: "question" });
    const folder = join(stateDir, "ground-truth", "conversation");
    const files = readdirSync(folder);
    expect(files).toHaveLength(2);
    for (const file of files) check(stateDir, "conversation", join(folder, file));
  });
});

describe("learning.truth: false for the ticket file", () => {
  it("writes nothing for a ticket whose repository keeps no truth, and writes for one that does or for none known", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ticket-keeps-"));
    const entry = { key: "ABC-9", draft: "d1", kind: "reply", did: "sent", original: "o", final: null, at: "2026-11-06T10:00:00Z" };
    const asked: string[] = [];
    const write = ticketTruthWriter(stateDir, async (repo) => (asked.push(repo), repo !== "/r/off"));
    expect(await write({ ...entry, repoPath: "/r/off" })).toBe("");
    expect(existsSync(join(stateDir, "ground-truth", "ticket"))).toBe(false);
    expect(await write({ ...entry, repoPath: "/r/on" })).toMatch(/ABC-9/);
    expect(await write(entry)).toMatch(/ABC-9/);
    expect(asked).toEqual(["/r/off", "/r/on"]);
  });
});

describe("priorityTruth", () => {
  it("writes the two levels and the sub-scores owner-only under ground-truth/priority, caps a person's text, and writes nothing when the repository keeps no truth", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "priority-"));
    const entry = { machine: "triage" as const, id: "t-1", recordId: "rec-1", subScores: { who: 2, what: 3 }, total: 12, machineLevel: "P2", personLevel: "P0", knockOut: null, at: "2026-11-06T10:00:00.000Z" };
    const path = await priorityTruth(stateDir, entry);
    check(stateDir, "priority", path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ schema: 1, machine: "triage", id: "t-1", recordId: "rec-1", machineLevel: "P2", personLevel: "P0", subScores: { who: 2, what: 3 } });
    expect(await priorityTruth(stateDir, { ...entry, id: "t-2" }, async () => false)).toBe("");
    expect(readdirSync(join(stateDir, "ground-truth", "priority"))).toHaveLength(1);
  });
});
