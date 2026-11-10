// The judge's mailbox: the guard's question goes out as a file and returns at once; the host's verdict comes back as a file, once.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { mailboxJudge } from "./judge-mailbox.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "judge-mailbox-")), "checks");
const answer = (checks: string, n: number, body: unknown) => writeFileSync(join(checks, `loop-answer-${n}.json`), typeof body === "string" ? body : JSON.stringify(body));

describe("mailboxJudge", () => {
  it("is null without a checks directory", () => {
    expect(mailboxJudge(undefined)).toBeNull();
  });

  it("writes the request as a whole file and returns at once, leaving nothing half-written", () => {
    const checks = dir();
    const judge = mailboxJudge(checks)!;
    expect(judge.ask("turns=30")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(checks, "loop-request-1.json"), "utf8"))).toEqual({ n: 1, digest: "turns=30" });
    expect(readdirSync(checks)).toEqual(["loop-request-1.json"]);
    judge.ask("turns=40");
    expect(JSON.parse(readFileSync(join(checks, "loop-request-2.json"), "utf8"))).toEqual({ n: 2, digest: "turns=40" });
  });

  it("has no verdict until the host answers, then gives it once", () => {
    const checks = dir();
    const judge = mailboxJudge(checks)!;
    expect(judge.poll()).toBeNull();
    judge.ask("d");
    expect(judge.poll()).toBeNull();
    answer(checks, 1, { stuck: true, confidence: 0.9, cause: "repeating_failure", redirect: "Try another file." });
    expect(judge.poll()).toEqual({ stuck: true, confidence: 0.9, cause: "repeating_failure", redirect: "Try another file." });
    expect(judge.poll()).toBeNull();
    expect(existsSync(join(checks, "loop-answer-1.json"))).toBe(false);
  });

  it("gives a verdict with no redirect as it is", () => {
    const checks = dir();
    const judge = mailboxJudge(checks)!;
    judge.ask("d");
    answer(checks, 1, { stuck: false, confidence: 0, cause: "productive" });
    expect(judge.poll()).toEqual({ stuck: false, confidence: 0, cause: "productive" });
  });

  it("drops each malformed answer and gives the next good one", () => {
    const checks = dir();
    const judge = mailboxJudge(checks)!;
    const bad = ["{ not json", { stuck: "yes", confidence: 1, cause: "x" }, { stuck: true, cause: "x" }, { stuck: true, confidence: "high", cause: "x" }, { stuck: true, confidence: 1 }, [], "null"];
    for (const [i, body] of bad.entries()) {
      judge.ask("d");
      answer(checks, i + 1, body);
      expect(judge.poll(), JSON.stringify(body)).toBeNull();
      expect(existsSync(join(checks, `loop-answer-${i + 1}.json`))).toBe(false);
    }
    judge.ask("d");
    answer(checks, bad.length + 1, { stuck: false, confidence: 0.2, cause: "productive" });
    expect(judge.poll()).toEqual({ stuck: false, confidence: 0.2, cause: "productive" });
  });

  it("clamps a confidence outside 0 to 1 and cuts a redirect to 1200 characters", () => {
    const checks = dir();
    const judge = mailboxJudge(checks)!;
    judge.ask("d");
    answer(checks, 1, { stuck: true, confidence: 7, cause: "environment", redirect: "x".repeat(2000) });
    const verdict = judge.poll()!;
    expect(verdict.confidence).toBe(1);
    expect(verdict.redirect).toHaveLength(1200);
  });

  it("never throws: an unwritable directory is no verdict", () => {
    const file = join(mkdtempSync(join(tmpdir(), "judge-mailbox-")), "a-file");
    writeFileSync(file, "x");
    const judge = mailboxJudge(join(file, "checks"))!;
    expect(() => judge.ask("d")).not.toThrow();
    expect(judge.poll()).toBeNull();
  });
});
