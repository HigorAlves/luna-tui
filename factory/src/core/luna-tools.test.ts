// The luna tools as plain handlers, the way a runtime without an in-process MCP server serves
// them (eve over a loopback call): same state, same ledger file, same answers as the Claude server.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LUNA_TOOLS, lunaHandlers } from "./luna-tools.ts";

describe("lunaHandlers", () => {
  it("validates the input, keeps the state and persists the ledger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-core-"));
    const luna = lunaHandlers({ ledgerPath: join(dir, "ledger.json"), decisions: [] });
    expect(await luna.call("slice_init", { slices: [{ id: 1, title: "a" }] })).toMatchObject({ slices: [{ id: 1, status: "pending" }] });
    expect(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).slices).toHaveLength(1);
    expect(luna.state.events.map((e) => e.kind)).toEqual(["ledger.init"]);
    expect(await luna.call("slice_set", { id: 1, status: "bogus" })).toMatchObject({ error: expect.stringContaining("status") });
    expect(await luna.call("nope", {})).toMatchObject({ error: "no luna tool nope" });
  });

  it("describes the five tools for any runtime to serve", () => {
    expect(Object.keys(LUNA_TOOLS).sort()).toEqual(["decision_get", "slice_init", "slice_list", "slice_set", "step"]);
  });
});
