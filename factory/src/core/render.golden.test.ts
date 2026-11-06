// The rendering of every pack's prompt, with no foreign text in it, is what it was before ticket and
// model text became quoted data: the same prompt with the one data note added to the header. Goldens live
// in __golden__/<pack>.txt; `UPDATE_GOLDEN=1` rewrites them (only ever from the code before a rendering change).
import { PACKS, type StageInput } from "@hardness/contracts";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DATA_NOTE } from "./data-block.ts";
import { renderPrompt } from "./render.ts";

const dir = new URL("./__golden__/", import.meta.url);
const prompts = new URL("../../prompts/", import.meta.url);

const inputFor = (pack: keyof typeof PACKS): StageInput => ({
  schema: 3,
  stage: pack as never,
  pack: pack as never,
  attempt: 1,
  task: { id: "t1", title: "Fix the bug", description: "", criteria: [], repoPath: "/r", branch: "task/t1-fix", source: null },
  plan: null,
  decisions: [],
  priorFindings: [],
  context: { projectContext: null },
  limits: { maxTurns: 10, timeoutMs: 1000 },
  env: { LUNA_FACTORY: "1" },
});

const packs = readdirSync(prompts).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).filter((id) => id in PACKS);

describe("every pack's prompt without foreign text", () => {
  it("covers the packs that have a template", () => {
    expect(packs.length).toBeGreaterThan(15);
  });

  for (const id of packs) {
    it(`${id}: renders as it did, plus the data note in the header`, () => {
      const template = readFileSync(new URL(`${id}.md`, prompts), "utf8");
      const rendered = renderPrompt({ pack: PACKS[id as keyof typeof PACKS] as never, input: inputFor(id as keyof typeof PACKS), template, projectContext: null });
      const golden = new URL(`${id}.txt`, dir);
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(golden, rendered);
      }
      expect(existsSync(golden), `golden for ${id}`).toBe(true);
      // The old output, with the note added after the first line: nothing else differs.
      const before = readFileSync(golden, "utf8");
      const expected = process.env.UPDATE_GOLDEN === "1" ? rendered : before.replace(/^(.*\n)/, `$1${DATA_NOTE}\n`);
      expect(rendered).toBe(expected);
    });
  }
});
