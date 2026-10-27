import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { StageInput } from "@hardness/contracts";

import { lunaTools } from "./luna.ts";

/** Calls a tool on the in-process server the way the SDK would, returning the parsed text. */
async function call(server: ReturnType<typeof lunaTools>["server"], name: string, args: Record<string, unknown>): Promise<unknown> {
  const instance = server.instance as unknown as { _registeredTools?: Record<string, { handler: (a: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }> }> };
  const tool = instance._registeredTools?.[name];
  if (!tool) throw new Error(`no tool ${name}: ${Object.keys(instance._registeredTools ?? {}).join(",")}`);
  const result = await tool.handler(args, {});
  const text = result.content[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("luna tools", () => {
  const setup = (over: Partial<Parameters<typeof lunaTools>[0]> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "luna-"));
    const steps: string[] = [];
    const luna = lunaTools({ ledgerPath: join(dir, "ledger.json"), decisions: [], onStep: (label, n, of) => steps.push(`${label} ${n}/${of}`), ...over });
    return { dir, steps, ...luna };
  };

  it("serves the five tools under the luna name", () => {
    const { server } = setup();
    expect(server.name).toBe("luna");
    expect(server.type).toBe("sdk");
  });

  it("keeps the slice ledger: init once, set by id, list, persisted to disk after every change", async () => {
    const { dir, server, state } = setup();
    expect(await call(server, "slice_init", { slices: [{ id: 1, title: "a", estLoc: 10 }, { id: 2, title: "b" }] })).toMatchObject({ schema: 1, slices: [{ id: 1, status: "pending", estLoc: 10 }, { id: 2, status: "pending", estLoc: null }] });
    expect(await call(server, "slice_init", { slices: [{ id: 9, title: "z" }] })).toMatchObject({ error: expect.stringContaining("already exists") });
    expect(await call(server, "slice_set", { id: 1, status: "red" })).toMatchObject({ id: 1, status: "red" });
    expect(await call(server, "slice_set", { id: 1, status: "committed", commit: "abc", actualLoc: 12 })).toMatchObject({ status: "committed", commit: "abc", actualLoc: 12 });
    expect(await call(server, "slice_set", { id: 3, status: "red" })).toMatchObject({ error: expect.stringContaining("no slice 3") });
    expect(await call(server, "slice_list", {})).toEqual(state.ledger);
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"))).toEqual(state.ledger);
    expect(state.events.map((e) => e.kind)).toEqual(["ledger.init", "slice.red", "slice.committed"]);
  });

  it("starts from a ledger the machine passed in", async () => {
    const ledger = { schema: 1 as const, slices: [{ id: 1, title: "a", status: "committed" as const, commit: "x" }] };
    const { server } = setup({ ledger });
    expect(await call(server, "slice_list", {})).toEqual(ledger);
  });

  it("records steps as events and echoes them", async () => {
    const { server, state, steps } = setup();
    expect(await call(server, "step", { label: "writing failing test", n: 2, of: 5 })).toBe("ok");
    expect(state.events).toEqual([{ kind: "step", payload: { label: "writing failing test", n: 2, of: 5 } }]);
    expect(steps).toEqual(["writing failing test 2/5"]);
  });

  it("answers decision_get from the stage input's decisions", async () => {
    const decisions: StageInput["decisions"] = [
      { at: "triage", decision: "answered", reason: null, answers: { driver: "playwright" } },
      { at: "awaiting_approval", decision: "approved", reason: "go", answers: {} },
    ];
    const { server } = setup({ decisions });
    expect(await call(server, "decision_get", { key: "driver" })).toEqual([decisions[0]]);
    expect(await call(server, "decision_get", { key: "approved" })).toEqual([decisions[1]]);
    expect(await call(server, "decision_get", { key: "nothing" })).toEqual({ decided: null });
  });
});
