// The seam between the factory runner and the machine, checked from the registry's side:
// every answer a pack's schema allows, wrapped in the envelope the runner writes, must be a
// StageOutput the machine ingests. Both sides live here now; this test keeps them together.
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { PACKS, PACK_LIMITS, PackId, StageOutput, answerJsonSchema } from "./index.ts";

/** A minimal instance of a JSON schema: every required property, the first enum value,
 *  one item per array (so item shapes such as findings get exercised). */
function instance(schema: any): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return instance(schema.anyOf[0]);
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

/** The envelope the runner writes around a pack's structured answer, with its outcome rule. */
function envelope(answer: any): Record<string, unknown> {
  const asked = answer.kind === "questions" || (Array.isArray(answer.questions) && answer.questions.length > 0);
  const outcome = asked ? "needs_input" : answer.kind === "test_change" ? "test_change" : answer.kind === "escalated" ? "escalated" : "pass";
  return {
    schema: 3,
    ok: true,
    outcome,
    summary: String(answer.summary ?? ""),
    answer,
    needsInput: asked ? (answer.questions ?? []) : null,
    requested: answer.requested ?? [],
    findings: answer.findings ?? [],
    artifacts: [],
    slices: { done: 0, total: 0 },
    commit: answer.commit ?? null,
    usage: { turns: 1, costUsd: 0.01, durationMs: 10, model: "sonnet" },
    error: null,
    rateLimited: false,
    resetsAt: null,
    ledger: { schema: 1, slices: [] },
    sessionId: "s",
  };
}

const agentPacks = Object.values(PACKS).filter((pack) => pack.agent != null);

describe("the pack registry", () => {
  it("has one pack per PackId, each with a template and a model, and the limits the machine reads", () => {
    expect(Object.keys(PACKS).sort()).toEqual([...PackId.options].sort());
    for (const pack of Object.values(PACKS)) {
      expect(pack.template).toMatch(/^[a-z0-9_]+\.md$/);
      expect(PACK_LIMITS[pack.id]).toEqual({ maxTurns: pack.maxTurns, timeoutMs: pack.timeoutMs, writable: pack.writable });
      if (pack.agent) expect(pack.maxTurns).toBeGreaterThan(0);
      else expect(pack.tools).toEqual([]);
    }
  });

  it("gives a writable pack the tools to commit and a read-only pack none that edit", () => {
    for (const pack of agentPacks) {
      const edits = pack.tools.some((t) => t === "Write" || t === "Edit" || t.startsWith("Bash(git commit"));
      expect(edits, pack.id).toBe(pack.writable);
    }
  });

  it("turns each answer schema into a JSON schema the SDK can take: an object with properties and no $schema", () => {
    for (const pack of agentPacks) {
      const schema = answerJsonSchema(pack);
      expect(schema.type).toBe("object");
      expect(schema.properties).toBeTypeOf("object");
      expect(schema).not.toHaveProperty("$schema");
    }
  });
});

describe("factory contract", () => {
  it.each(agentPacks.map((p) => [p.id, p] as const))("accepts a minimal %s answer, for every answer kind its schema allows", (_id, pack) => {
    const schema = answerJsonSchema(pack) as any;
    const kinds: unknown[] = schema.properties?.kind?.enum ?? schema.properties?.kind?.anyOf?.[0]?.enum ?? [undefined];
    for (const kind of kinds) {
      const answer = instance(schema) as Record<string, unknown>;
      if (kind !== undefined) answer.kind = kind;
      // Fill the optional, shape-bearing fields too: that is where drift hides.
      for (const key of ["findings", "results", "cases", "questions", "requested", "slices", "criteria"]) {
        if (schema.properties?.[key] && answer[key] === undefined) answer[key] = instance(schema.properties[key]);
      }
      expect(pack.answer.safeParse(answer).error, `${pack.id} kind=${String(kind)} answer`).toBeUndefined();
      const parsed = StageOutput.safeParse(envelope(answer));
      expect(parsed.error, `${pack.id} kind=${String(kind)}: ${JSON.stringify(parsed.error?.issues)}`).toBeUndefined();
    }
  });

  it("still accepts a schema-1 and schema-2 result from an older runner", () => {
    const base = envelope({ kind: "brief", summary: "s" });
    const { ledger: _l, sessionId: _s, ...older } = base;
    expect(StageOutput.safeParse({ ...older, schema: 1 }).error).toBeUndefined();
    expect(StageOutput.safeParse({ ...older, schema: 2 }).error).toBeUndefined();
  });

  it("keeps the answer schemas zod objects the runner can also validate with", () => {
    for (const pack of agentPacks) expect(pack.answer).toBeInstanceOf(z.ZodObject);
  });
});
