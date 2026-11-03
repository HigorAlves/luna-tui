// The golden test for the Claude tool lists: __fixtures__/pack-tools.json holds, for every pack,
// the `allowedTools` and `tools` the SDK got before packs declared a runtime-neutral access. The
// mapping from `access` must give exactly those. They compare sorted: the SDK reads both lists
// as sets, so their order carries no meaning.
import { AGENT_PACKS, NO_ACCESS } from "@hardness/contracts";
import { describe, expect, it } from "vitest";

import fixture from "./__fixtures__/pack-tools.json" with { type: "json" };
import { claudeTools } from "./access.ts";

const golden = fixture as Record<string, { allowedTools: string[]; tools: string[] }>;
const sorted = (list: string[]) => [...list].sort();

describe("access as Claude tools", () => {
  it("covers every pack a role or a script runs", () => {
    expect(Object.keys(golden).sort()).toEqual(AGENT_PACKS.map((p) => p.id).sort());
  });

  it.each(AGENT_PACKS.map((p) => [p.id, p] as const))("%s: gives the tool lists the fixture pins", (id, pack) => {
    const { tools, allowedTools } = claudeTools(pack.access);
    expect(sorted(allowedTools)).toEqual(sorted(golden[id]!.allowedTools));
    expect(sorted(tools)).toEqual(sorted(golden[id]!.tools));
  });

  it("gives `tools` bare names only: a scoped rule such as Bash(git add:*) would drop Bash", () => {
    expect(claudeTools({ ...NO_ACCESS, read: true, commands: ["git add", "npm"] })).toEqual({ tools: ["Read", "Glob", "Grep", "Bash"], allowedTools: ["Read", "Glob", "Grep", "Bash(git add:*)", "Bash(npm:*)"] });
    expect(claudeTools(NO_ACCESS)).toEqual({ tools: [], allowedTools: [] });
  });
});
