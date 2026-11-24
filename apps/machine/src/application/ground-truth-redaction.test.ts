// Every ground-truth writer passes what it writes through the machine's secret values and the token shapes; a private thread's outcome keeps no text.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalRow, TaskRow } from "../domain/task.ts";
import { ConversationTruth } from "./conversation-truth.ts";
import { escalationTruthWriter, evidenceFeedbackWriter, groundTruthWriter, ticketTruthWriter, useTruthSecrets, writeTruthFile } from "./ground-truth.ts";
import { appendAddedFinding, retroTruthOf, writeRetroTruth } from "./retro-outputs.ts";

// Built at run time: no literal here has a secret's shape.
const SECRET = ["sec", "ret-", "value-", "9f8e7d6c5b"].join("");
const TOKEN = ["gh", "p_"].join("") + "a".repeat(36);
const dir = () => mkdtempSync(join(tmpdir(), "gt-redact-"));
const files = (stateDir: string): string[] => {
  const root = join(stateDir, "ground-truth");
  return readdirSync(root).flatMap((kind) => readdirSync(join(root, kind)).map((name) => readFileSync(join(root, kind, name), "utf8")));
};
const clean = (stateDir: string) => {
  const all = files(stateDir);
  expect(all.length).toBeGreaterThan(0);
  for (const text of all) {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(TOKEN);
  }
  return all.join("\n");
};

afterEach(() => useTruthSecrets(() => ({})));

const task = { id: "t1", title: `Login ${SECRET}`, description: `d ${TOKEN}`, criteria: [`c ${SECRET}`], branch: "task/t1" } as unknown as TaskRow;
const gate = { id: "a1", taskId: "t1", kind: "awaiting_approval", requested: { brief: `b ${SECRET}`, escalationDecision: { reason: `r ${SECRET}` } }, decision: "approved", reason: null, response: {}, createdAt: new Date(0), decidedAt: new Date(0) } as unknown as ApprovalRow;
const pack = { summary: "s", format: "video", scenarios: [], findings: [], outOfMap: [], risk: "low", rollback: "r", howToVerify: "h", commitSha: "abc1234def5678", media: [], at: "t", revision: 1 } as never;
const facts = { predicted: { size: "small", risk: "low", estLoc: 100, urgency: "high" }, actual: { added: 50, removed: 5, retries: { verify: 1, e2e: 0, ci: 0, total: 1 }, escalations: 1, format: "text", durationMin: 30, overrides: 2 }, runs: 6 };

describe("a planted secret never reaches a truth file", () => {
  it("the machine's own value and a token shape, in every writer", async () => {
    useTruthSecrets(() => ({ SOME_KEY: SECRET }));
    const stateDir = dir();
    await groundTruthWriter(stateDir)(task, gate);
    await escalationTruthWriter(stateDir)(task, gate, [{ sha: "abc", files: [{ path: `src/${SECRET}.ts`, added: 1, removed: 0 }] }], null);
    await ticketTruthWriter(stateDir)({ key: "ABC-1", draft: "d1", kind: "reply", did: "edited", original: `o ${SECRET}`, final: `f ${TOKEN}`, at: "2026-11-06T10:00:00Z" });
    await evidenceFeedbackWriter(stateDir)(task, pack, { useful: false, note: `bad ${SECRET} ${TOKEN}` }, new Date("2026-11-06T10:00:00Z"));
    await writeRetroTruth(stateDir, { ...retroTruthOf({ taskId: "t9", facts, retro: null, adopted: false }), recalibration: [{ dimension: "d", predicted: `p ${SECRET}`, actual: "a", note: `n ${TOKEN}` }] } as never);
    await appendAddedFinding(stateDir, "t9", { title: `finding ${SECRET} ${TOKEN}`, severity: "major" });
    await writeTruthFile(stateDir, "evidence", "t1-abc-edit.json", { section: `the section ${SECRET} ${TOKEN}` });
    const truth = new ConversationTruth(stateDir, null);
    await truth.outcome({ private: false, thread: "C1:1.0", draft: "d1", outcome: "edited", machine: `draft ${SECRET}`, person: `sent ${TOKEN}`, records: {} });
    const text = clean(stateDir);
    expect(text).toContain("[secret:SOME_KEY]");
    expect(text).toContain("[redacted]");
  });

  it("redacts a key of an object as well as its values", async () => {
    useTruthSecrets(() => ({ SOME_KEY: SECRET }));
    const stateDir = dir();
    await writeTruthFile(stateDir, "plan", "k.json", { [SECRET]: 1 });
    clean(stateDir);
  });
});

describe("a private thread's outcome", () => {
  it("keeps the outcome, the size of the difference and the record ids, and no text", async () => {
    const stateDir = dir();
    const truth = new ConversationTruth(stateDir, null);
    await truth.outcome({ private: true, thread: "D1:1.0", draft: "d1", outcome: "edited", machine: "fire Bob\non friday", person: "hold off on Bob", records: { assess: "rec-1" } });
    await truth.outcome({ private: true, thread: "D1:2.0", draft: "d2", outcome: "expired", machine: "fire Bob on friday", records: { assess: "rec-2" } });
    const all = files(stateDir).map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("Bob");
    const edited = all.find((entry) => entry.outcome === "edited")!;
    expect(edited).toMatchObject({ outcome: "edited", lineDifference: -1, records: { assess: "rec-1" }, private: true });
    expect(edited).not.toHaveProperty("machine");
    expect(edited).not.toHaveProperty("person");
  });
});
