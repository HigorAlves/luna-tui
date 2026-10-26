// The seam with orc, checked from orc's side: every pack's output schema, as orc ships it
// (vendored under fixtures/orc/ by `pnpm vendor:orc`), must produce results these zod
// schemas accept. Before this test the two repos had drifted in five places and nothing
// could see it: a finding without start_line failed every verifying run that reported one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StageInput, StageOutput } from "./index.ts";

const fixtures = join(import.meta.dirname, "..", "fixtures", "orc");
const read = (name: string): any => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const stages = read("stages.json");
const outputExample = read("stage-output.example.json");
const inputExample = read("stage-input.example.json");

/** A minimal instance of a JSON schema: every required property, the first enum value,
 *  one item per array (so item shapes such as findings get exercised). */
function instance(schema: any): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = instance(schema.properties?.[key] ?? {});
      return out;
    }
    case "array":
      return schema.items ? [instance(schema.items)] : [];
    case "string":
      return "x";
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** The envelope run.mjs writes around a pack's structured answer, with its outcome rule. */
function envelope(answer: any): Record<string, unknown> {
  const asked = answer.kind === "questions" || (Array.isArray(answer.questions) && answer.questions.length > 0);
  const outcome = asked ? "needs_input" : answer.kind === "test_change" ? "test_change" : answer.kind === "escalated" ? "escalated" : "pass";
  return {
    ...outputExample,
    schema: 2,
    outcome,
    answer,
    needsInput: asked ? answer.questions ?? [] : null,
    requested: answer.requested ?? [],
    findings: answer.findings ?? [],
  };
}

const agentPacks = Object.entries(stages.packs).filter(([, pack]: [string, any]) => pack.agent != null);

describe(`orc contract (vendored at ${readFileSync(join(fixtures, "SHA"), "utf8").trim()})`, () => {
  it("accepts orc's own example output and input", () => {
    expect(StageOutput.safeParse(outputExample).error).toBeUndefined();
    expect(StageInput.safeParse(inputExample).error).toBeUndefined();
  });

  it.each(agentPacks)("accepts a minimal %s answer, for every answer kind its schema allows", (_pack, pack: any) => {
    const schema = pack.outputSchema;
    const kinds: unknown[] = schema.properties?.kind?.enum ?? [undefined];
    for (const kind of kinds) {
      const answer = instance(schema) as Record<string, unknown>;
      if (kind !== undefined) answer.kind = kind;
      // Fill the optional, shape-bearing fields too: that is where the drift was.
      for (const key of ["findings", "results", "cases", "questions", "requested"]) {
        if (schema.properties?.[key] && answer[key] === undefined) answer[key] = instance(schema.properties[key]);
      }
      const parsed = StageOutput.safeParse(envelope(answer));
      expect(parsed.error, `${_pack} kind=${String(kind)}: ${JSON.stringify(parsed.error?.issues)}`).toBeUndefined();
    }
  });

  it("still accepts a schema-1 result from an older runner image", () => {
    expect(StageOutput.safeParse({ ...outputExample, schema: 1 }).error).toBeUndefined();
  });

  const orcPath = [process.env.ORC_PATH, join(fixtures, "..", "..", "..", "..", "orc")].find((p) => p && existsSync(join(p, "orc", "factory", "stages.json")));
  it.skipIf(!orcPath)("matches the orc checkout next to this repo (run pnpm vendor:orc after bumping orc)", () => {
    const pairs: Array<[string, string]> = [
      ["stages.json", "orc/factory/stages.json"],
      ["stage-input.json", "orc/factory/schema/stage-input.json"],
      ["stage-output.json", "orc/factory/schema/stage-output.json"],
    ];
    for (const [vendored, upstream] of pairs) {
      expect(readFileSync(join(fixtures, vendored), "utf8"), vendored).toBe(readFileSync(join(orcPath!, upstream), "utf8"));
    }
  });
});
