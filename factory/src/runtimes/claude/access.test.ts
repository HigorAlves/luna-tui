// The golden test for the Claude tool lists: __fixtures__/pack-tools.json holds, for every pack,
// the `allowedTools` and `tools` the SDK got before packs declared a runtime-neutral access.
import { PACKS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import fixture from "./__fixtures__/pack-tools.json" with { type: "json" };
import { toolNames } from "./run.ts";

const golden = fixture as Record<string, { allowedTools: string[]; tools: string[] }>;

describe("the Claude tool lists", () => {
  it("cover every pack", () => {
    expect(Object.keys(golden).sort()).toEqual(Object.keys(PACKS).sort());
  });

  it.each(Object.values(PACKS).map((p) => [p.id, p] as const))("%s: are the ones the fixture pins", (id, pack) => {
    expect(pack.tools).toEqual(golden[id]!.allowedTools);
    expect(toolNames(pack.tools)).toEqual(golden[id]!.tools);
  });
});
