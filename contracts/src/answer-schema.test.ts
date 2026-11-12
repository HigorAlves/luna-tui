import { describe, expect, it } from "vitest";
import { answerJsonSchema, PACKS } from "./packs.ts";

/** Keywords the Claude CLI's strict `--json-schema` check rejects, which broke the setup stage on the live machine. */
const REJECTED = ["prefixItems"];

function keywords(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keywords(item, found));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keywords(value, found);
    }
  }
  return found;
}

describe("answerJsonSchema", () => {
  it.each(Object.values(PACKS).map((pack) => [pack.id, pack] as const))("%s: names no keyword the Claude CLI rejects", (_id, pack) => {
    const found = keywords(answerJsonSchema(pack));
    for (const word of REJECTED) expect(found.has(word), word).toBe(false);
  });

  it("keeps a tuple as a bounded array in the setup answer", () => {
    const schema = JSON.stringify(answerJsonSchema(PACKS.setup));
    expect(schema).not.toContain("prefixItems");
    expect(schema).toContain('"maxItems":2');
  });
});
