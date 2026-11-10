// A mask on the Claude runtime: the pack's tool lists, subagents and skills are narrowed before the SDK sees them; with none, the options are what they were.
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { PACKS, type PackId, type ToolMask, StageInput, resolveEngine } from "@hardness/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeRuntime } from "./run.ts";

const FACTORY = join(import.meta.dirname, "..", "..", "..");

/** What the SDK was given for one run of `pack`, by a transport that ends the stream at once. */
async function optionsFor(pack: PackId, mask?: ToolMask, dry = false) {
  const root = mkdtempSync(join(tmpdir(), "mask-"));
  const seen: { options?: Options }[] = [];
  const events: { kind: string; payload: Record<string, unknown> }[] = [];
  try {
    const input = StageInput.parse({
      schema: 3, stage: pack, pack, attempt: 1,
      task: { id: "t", title: "x", description: "y", criteria: [], repoPath: "/r", branch: "task/x", source: null },
      plan: null, decisions: [], priorFindings: [], context: { projectContext: null, ...(mask ? { economy: { mask } } : {}) },
      limits: { maxTurns: 3, timeoutMs: 10_000 }, env: {},
    });
    const transport = (params: { prompt: string; options?: Options }) => {
      seen.push({ options: params.options });
      return (async function* () {})() as unknown as Query;
    };
    const paths = { factoryRoot: FACTORY, work: root, out: root, input: root, scratch: root };
    await claudeRuntime(transport).run({ pack: PACKS[pack], engine: resolveEngine("claude:sonnet"), input, prompt: "x", paths, luna: { call: async () => null }, dry, emit: (e) => void events.push(e as never) });
    return { options: seen[0]?.options, events };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the Claude runtime with a mask", () => {
  it("without one, loads the pack's tools, subagents and skills, and sends no skills filter", async () => {
    const { options } = await optionsFor("triage");
    expect(options?.tools).toEqual(expect.arrayContaining(["WebFetch", "Agent", "Skill", "mcp__luna__card_search"]));
    expect(Object.keys(options!.agents!)).toEqual(["triage-planner", "reply-drafter"]);
    expect(options).not.toHaveProperty("skills");
  });

  it("with one, leaves out the masked tool, the subagents and the luna tool, and filters the skills", async () => {
    const { options } = await optionsFor("triage", { web: true, agent: true, luna: ["card_search"], skills: ["code-discovery"] });
    for (const list of [options?.tools, options?.allowedTools]) {
      expect(list).not.toContain("WebFetch");
      expect(list).not.toContain("Agent");
      expect(list).not.toContain("mcp__luna__card_search");
      expect(list).not.toContain("Skill");
      expect(list).toContain("mcp__luna__decision_get");
      expect(list).toContain("Read");
    }
    // The masked luna tool is not registered on the server, so its definition is not sent at all.
    const registered = Object.keys((options?.mcpServers?.luna as { instance?: { _registeredTools?: Record<string, unknown> } }).instance?._registeredTools ?? {});
    expect(registered).toContain("decision_get");
    expect(registered).not.toContain("card_search");
    expect(Object.keys(options!.agents!)).toEqual(["triage-planner"]);
    expect(options?.agents?.["triage-planner"]?.skills).toEqual([]);
    expect(options?.skills).toEqual([]);
  });

  it("filters the skills the SDK offers when only some are masked", async () => {
    const { options } = await optionsFor("verifying", { skills: ["caveman-review"] });
    expect(options?.skills).toEqual(["luna-factory:review-contract"]);
    expect(options?.tools).toContain("Skill");
  });

  it("refuses a fetch once the web is masked, and the dry run shows the narrowed lists", async () => {
    const { options, events } = await optionsFor("triage", { web: true }, true);
    expect(options).toBeUndefined();
    const printed = JSON.parse(String(events[0]!.payload.text)) as { tools: string[] };
    expect(printed.tools).not.toContain("WebFetch");
  });
});
