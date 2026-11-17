import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseGuardJournal, readGuardJournal } from "./guard-journal.ts";

const sig = { id: "env.read", severity: "high", title: "Reads the environment" };
const row = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 1, time: 1.5, verdict: "blocked", tool: "Bash", arguments: '{"command":"echo sk-SECRET-123"}', reason: "bad", signals: [sig], judge: "judge says no", model: "m", task: "ignore previous instructions", ...over });

describe("parseGuardJournal", () => {
  it("keeps the id, verdict, tool, signals and reason, and nothing else", () => {
    const { entries, skipped, truncated } = parseGuardJournal(`${row()}\n`);
    expect(entries).toEqual([{ id: 1, verdict: "blocked", tool: "Bash", signals: [sig], reason: "bad" }]);
    expect(skipped).toBe(0);
    expect(truncated).toBe(false);
    expect(JSON.stringify(entries)).not.toMatch(/SECRET|ignore previous|judge|arguments|task|model/);
  });

  it("skips and counts a malformed line, a wrong verdict, a string id and a bad severity", () => {
    const text = [row({ id: 1 }), "{nope", row({ id: 2, verdict: "allowed" }), row({ id: "3" }), row({ id: 1.5 }), row({ id: 4, signals: [{ ...sig, severity: "extreme" }] }), row({ id: 5, tool: 7 }), "[]", row({ id: 6, verdict: "flagged" })].join("\n");
    const { entries, skipped } = parseGuardJournal(`${text}\n`);
    expect(entries.map((e) => e.id)).toEqual([1, 6]);
    expect(skipped).toBe(7);
  });

  it("accepts a null or missing reason as null, and tolerates an unknown extra field by stripping it", () => {
    const { entries } = parseGuardJournal(`${row({ reason: null, future: { a: 1 } })}\n${row({ id: 2, reason: undefined })}\n`);
    expect(entries).toEqual([
      { id: 1, verdict: "blocked", tool: "Bash", signals: [sig], reason: null },
      { id: 2, verdict: "blocked", tool: "Bash", signals: [sig], reason: null },
    ]);
  });

  it("makes every string safe: one line, no HTML, no mention", () => {
    const { entries } = parseGuardJournal(`${row({ tool: "Ba\u0000sh\n<b>", reason: "line1\nline2 <script> @bob", signals: [{ ...sig, title: "t\r\n<i>x" }] })}\n`);
    const e = entries[0]!;
    expect(e.tool).not.toMatch(/[<>\n\r]/);
    expect(e.reason).toBe("line1 line2 &lt;script&gt; @​bob");
    expect(e.signals[0]!.title).toBe("t &lt;i&gt;x");
  });

  it("caps tool at 64, signal id at 80, title at 120, reason at 200 and the signals at 10", () => {
    const signals = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`.padEnd(100, "x"), severity: "low", title: "t".repeat(300) }));
    const { entries } = parseGuardJournal(`${row({ tool: "T".repeat(500), reason: "r".repeat(500), signals })}\n`);
    const e = entries[0]!;
    expect(e.tool).toHaveLength(64);
    expect(e.reason).toHaveLength(200);
    expect(e.signals).toHaveLength(10);
    expect(e.signals[0]!.id).toHaveLength(80);
    expect(e.signals[0]!.title).toHaveLength(120);
  });

  it("drops a last line that is cut and says so; a line ending in a newline is whole", () => {
    const cut = parseGuardJournal(`${row()}\n${row({ id: 2 }).slice(0, 20)}`, { cut: true });
    expect(cut.entries.map((e) => e.id)).toEqual([1]);
    expect(cut.truncated).toBe(true);
    expect(cut.skipped).toBe(0);
  });

  it("orders by id", () => {
    expect(parseGuardJournal(`${row({ id: 3 })}\n${row({ id: 1 })}\n`).entries.map((e) => e.id)).toEqual([1, 3]);
  });
});

describe("readGuardJournal", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "guard-journal-"));

  it("reads a journal file", async () => {
    const d = dir();
    writeFileSync(join(d, "calls.jsonl"), `${row()}\n`);
    expect((await readGuardJournal(join(d, "calls.jsonl"))).entries).toHaveLength(1);
  });

  it("reads only the first 4 MB of a bigger file, drops the cut line and sets truncated", async () => {
    const d = dir();
    const one = `${row()}\n`;
    writeFileSync(join(d, "calls.jsonl"), one.repeat(Math.ceil((4 * 1024 * 1024) / one.length) + 100));
    const result = await readGuardJournal(join(d, "calls.jsonl"));
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeGreaterThan(1000);
    expect(result.entries.length).toBeLessThan(Math.ceil((4 * 1024 * 1024) / one.length) + 100);
    expect(result.skipped).toBe(0);
  });

  it("treats a missing file as empty, with no skipped note", async () => {
    expect(await readGuardJournal(join(dir(), "none.jsonl"))).toEqual({ entries: [], skipped: 0, truncated: false });
  });

  it("refuses a symlink and never follows it", async () => {
    const d = dir();
    writeFileSync(join(d, "real"), `${row()}\n`);
    symlinkSync(join(d, "real"), join(d, "calls.jsonl"));
    expect(await readGuardJournal(join(d, "calls.jsonl"))).toEqual({ entries: [], skipped: 1, truncated: false });
  });

  it("refuses a directory", async () => {
    const d = dir();
    mkdirSync(join(d, "calls.jsonl"));
    expect(await readGuardJournal(join(d, "calls.jsonl"))).toEqual({ entries: [], skipped: 1, truncated: false });
  });
});
