// The luna tools as plain handlers, the way a runtime without an in-process MCP server serves
// them (eve over a loopback call): same state, same ledger file, same answers as the Claude server.
import type { RunEvent } from "@hardness/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LUNA_TOOLS, lunaHandlers } from "./luna-tools.ts";

describe("lunaHandlers", () => {
  it("validates the input, keeps the state and persists the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-core-"));
    const events: RunEvent[] = [];
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [], emit: (e) => events.push(e) });
    expect(await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] })).toMatchObject({ slices: [{ id: 1, status: "pending" }] });
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).slices).toHaveLength(1);
    expect(events.map((e) => e.kind)).toEqual(["ledger.init"]);
    expect(await luna.call("slice_set", { id: 1, status: "bogus" })).toMatchObject({ error: expect.stringContaining("status") });
    expect(await luna.call("nope", {})).toMatchObject({ error: "no luna tool nope" });
  });

  it("describes the six tools for any runtime to serve", () => {
    expect(Object.keys(LUNA_TOOLS).sort()).toEqual(["card_search", "decision_get", "scenario_red", "scope_check", "slice_init", "slice_list", "slice_set", "step"]);
  });
});

describe("scenario_red", () => {
  it("records each scenario's failing output in the checks folder, the latest report of a scenario winning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-reds-"));
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [], emit: () => {}, checksDir: join(dir, "checks") });
    expect(await luna.call("scenario_red", { scenario: "S1", output: "FAIL: cart.export is not a function" })).toMatchObject({ recorded: true });
    await luna.call("scenario_red", { scenario: "S2", output: "FAIL two" });
    await luna.call("scenario_red", { scenario: "S1", output: "FAIL: again" });
    expect(JSON.parse(readFileSync(join(dir, "checks", "scenario-reds.json"), "utf8"))).toEqual({ S1: "FAIL: again", S2: "FAIL two" });
  });

  it("keeps the tail of a long output, and stops taking reports once the file would pass what the machine reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-reds-"));
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [], emit: () => {}, checksDir: join(dir, "checks") });
    await luna.call("scenario_red", { scenario: "S1", output: `${"x".repeat(9000)}THE TAIL` });
    const reds = JSON.parse(readFileSync(join(dir, "checks", "scenario-reds.json"), "utf8"));
    expect(reds.S1.length).toBeLessThanOrEqual(2000);
    expect(reds.S1.endsWith("THE TAIL")).toBe(true);
    let refused = false;
    for (let i = 2; i < 60 && !refused; i++) refused = JSON.stringify(await luna.call("scenario_red", { scenario: `S${i}`, output: "y".repeat(2000) })).includes("too many");
    expect(refused).toBe(true);
    expect(readFileSync(join(dir, "checks", "scenario-reds.json")).length).toBeLessThan(64 * 1024);
  });

  it("asks for a scenario id and an output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-reds-"));
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [], emit: () => {} });
    expect(await luna.call("scenario_red", { scenario: "S1" })).toMatchObject({ error: expect.stringContaining("output") });
  });
});

describe("the build checks", () => {
  const setup = (checkWaitMs: number) => {
    const dir = mkdtempSync(join(tmpdir(), "luna-checks-"));
    const checksDir = join(dir, "checks");
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [], emit: () => {}, checksDir, checkWaitMs });
    return { dir, checksDir, luna };
  };
  const note = "AssertionError: expected 404 to be 200 at export.test.ts:12";

  it("refuses a red slice without a note of at least 20 characters", async () => {
    const { luna } = setup(0);
    await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] });
    expect(await luna.call("slice_set", { id: 1, status: "red" })).toMatchObject({ error: expect.stringContaining("note") });
    expect(await luna.call("slice_set", { id: 1, status: "red", note: "too short" })).toMatchObject({ error: expect.stringContaining("note") });
    expect(luna.state.ledger.slices[0]!.status).toBe("pending");
  });

  it("writes the ledger, waits for checks/red-<id>.json and returns its verdict with the slice", async () => {
    const { dir, checksDir, luna } = setup(2000);
    await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] });
    setTimeout(() => {
      mkdirSync(checksDir, { recursive: true });
      writeFileSync(join(checksDir, "red-1.json"), JSON.stringify({ verdict: "flag", problems: ["typo in the import"] }));
    }, 20);
    const result = await luna.call("slice_set", { id: 1, status: "red", note });
    expect(result).toMatchObject({ id: 1, status: "red", check: { verdict: "flag", problems: ["typo in the import"] } });
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).slices[0].status).toBe("red");
  });

  it("returns skipped when nothing answers in time", async () => {
    const { luna } = setup(50);
    await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] });
    expect(await luna.call("slice_set", { id: 1, status: "red", note })).toMatchObject({ status: "red", check: { verdict: "skipped", problems: [] } });
  });

  it("does not wait for a status other than red", async () => {
    const { luna } = setup(2000);
    await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] });
    const result = (await luna.call("slice_set", { id: 1, status: "green" })) as Record<string, unknown>;
    expect(result).not.toHaveProperty("check");
  });

  it("scope_check writes the request and returns the answer, or skipped", async () => {
    const { checksDir, luna } = setup(2000);
    setTimeout(() => writeFileSync(join(checksDir, "scope.json"), JSON.stringify({ verdict: "proceed", problems: [], facts: { undeclared: [] } })), 20);
    const answered = await luna.call("scope_check", { diffSummary: "adds export", outOfMap: [{ path: "src/util.ts", reason: "shared helper" }] });
    expect(answered).toMatchObject({ verdict: "proceed" });
    expect(JSON.parse(readFileSync(join(checksDir, "scope-request.json"), "utf8"))).toMatchObject({ diffSummary: "adds export", outOfMap: [{ path: "src/util.ts" }] });
    const quiet = setup(0);
    expect(await quiet.luna.call("scope_check", { diffSummary: "x", outOfMap: [] })).toMatchObject({ verdict: "skipped", problems: [] });
    expect(existsSync(join(quiet.checksDir, "scope-request.json"))).toBe(true);
  });

  it("a stale answer from an earlier request is not read for the next one", async () => {
    const { checksDir, luna } = setup(30);
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, "scope.json"), JSON.stringify({ verdict: "proceed", problems: [] }));
    expect(await luna.call("scope_check", { diffSummary: "x", outOfMap: [] })).toMatchObject({ verdict: "skipped" });
  });

  it("card_search writes the query for the machine and returns its answer, or skipped; a query is bounded", async () => {
    const { checksDir, luna } = setup(2000);
    setTimeout(() => writeFileSync(join(checksDir, "card-search.json"), JSON.stringify({ verdict: "ok", cards: [{ id: "c1", title: "Export CSV", state: "triage" }] })), 20);
    expect(await luna.call("card_search", { query: "export csv" })).toMatchObject({ verdict: "ok", cards: [{ id: "c1" }] });
    expect(JSON.parse(readFileSync(join(checksDir, "card-search-request.json"), "utf8"))).toEqual({ query: "export csv" });
    expect(await setup(0).luna.call("card_search", { query: "x" })).toMatchObject({ verdict: "skipped" });
    expect(await luna.call("card_search", { query: "x".repeat(301) })).toMatchObject({ error: expect.stringContaining("query") });
    expect(await luna.call("card_search", {})).toMatchObject({ error: expect.stringContaining("query") });
  });
});
