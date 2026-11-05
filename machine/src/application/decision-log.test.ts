import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DecisionRecord } from "@hardness/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { DecisionLog } from "./decision-log.ts";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "decision-log-"));
});

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  schema: 1,
  id: "r1",
  pack: "worth_learning",
  engine: "claude:haiku",
  model: "m",
  at: "2026-11-04T12:00:00.000Z",
  client: "ship",
  context: { ship: { kind: "retro" } },
  answer: { worth: { value: true, p: 0.9 } },
  verdicts: { worth: "proceed" },
  overall: "proceed",
  traceId: "t1",
  ...over,
});

describe("DecisionLog", () => {
  it("appends a record as a private regular file at decisions/<pack>/<day>/<id>.json, leaving no temp file", async () => {
    await new DecisionLog({ stateDir }).append(record());
    const dir = join(stateDir, "decisions", "worth_learning", "2026-11-04");
    expect(readdirSync(dir)).toEqual(["r1.json"]);
    const stat = statSync(join(dir, "r1.json"));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("writes nothing when switched off", async () => {
    await new DecisionLog({ stateDir, enabled: false }).append(record());
    expect(existsSync(join(stateDir, "decisions"))).toBe(false);
  });

  it("lists a pack's records oldest first, filtered by since and by having a truth", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record({ id: "b", at: "2026-11-04T12:00:00.000Z" }));
    await log.append(record({ id: "a", at: "2026-11-02T08:00:00.000Z", truth: { label: { worth: { value: true } }, source: "retro", at: "2026-11-03T00:00:00.000Z" } }));
    await log.append(record({ id: "other", pack: "event_class", answer: {}, verdicts: {} }));
    expect((await log.list("worth_learning")).map((r) => r.id)).toEqual(["a", "b"]);
    expect((await log.list("worth_learning", { since: new Date("2026-11-03T00:00:00Z") })).map((r) => r.id)).toEqual(["b"]);
    expect((await log.list("worth_learning", { withTruth: true })).map((r) => r.id)).toEqual(["a"]);
    expect(await log.list("risk_score")).toEqual([]);
  });

  it("reads one record by id, and refuses an id that is not a file name", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record());
    expect((await log.read("worth_learning", "r1"))?.traceId).toBe("t1");
    expect(await log.read("worth_learning", "nope")).toBeNull();
    expect(await log.read("worth_learning", "../../x")).toBeNull();
  });

  it("sets the truth by rewriting the one file, keeping its mode; false when there is no such record", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record());
    const truth = { label: { worth: { value: false } }, source: "retro", at: "2026-11-05T00:00:00.000Z" };
    expect(await log.setTruth("worth_learning", "r1", truth)).toBe(true);
    expect((await log.read("worth_learning", "r1"))?.truth).toEqual(truth);
    expect(statSync(join(stateDir, "decisions", "worth_learning", "2026-11-04", "r1.json")).mode & 0o777).toBe(0o600);
    expect(await log.setTruth("worth_learning", "gone", truth)).toBe(false);
  });

  it("sweeps the days past the retention and keeps the rest", async () => {
    const log = new DecisionLog({ stateDir });
    await log.append(record({ id: "old", at: "2026-07-01T00:00:00.000Z" }));
    await log.append(record({ id: "new", at: "2026-11-01T00:00:00.000Z" }));
    expect(await log.sweep(90, new Date("2026-11-04T00:00:00Z"))).toBe(1);
    expect((await log.list("worth_learning")).map((r) => r.id)).toEqual(["new"]);
    expect(await log.sweep(0, new Date("2030-01-01T00:00:00Z"))).toBe(0);
  });
});
