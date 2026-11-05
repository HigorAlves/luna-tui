import { describe, expect, it } from "vitest";

import { scenarioTags } from "./scenario-tags.ts";

const diff = (path: string, ...added: string[]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -0,0 +1 @@", ...added.map((l) => `+${l}`)].join("\n");
const scenarios = [{ id: "S1" }, { id: "S2" }];

describe("scenarioTags", () => {
  it("finds the tag in a test's name or in the comment on the line above it, on an added line of a test file", () => {
    const text = [diff("web/cart.test.ts", `it("exports two rows @scenario:S1", () => {`), diff("web/cart.test.ts", "// @scenario:S2", "it('x', () => {")].join("\n");
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts", diff: text, scenarios });
    expect(facts).toMatchObject({ ok: true, missing: [], tagged: { S1: "web/cart.test.ts", S2: "web/cart.test.ts" } });
  });

  it("names a scenario with no tagged test, and ignores a tag outside a test file", () => {
    const text = [diff("web/cart.test.ts", `it("a @scenario:S1", () => {`), diff("web/cart.tsx", "// @scenario:S2")].join("\n");
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nM\tweb/cart.tsx", diff: text, scenarios });
    expect(facts).toMatchObject({ ok: false, missing: ["S2"], nonTest: ["web/cart.tsx"] });
  });

  it("refuses a production file in the diff and a removed test, allowing fixtures beside the tests", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1 @scenario:S2", () => {`);
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nA\tweb/__fixtures__/cart.json\nA\tsrc/prod.ts\nD\tweb/old.test.ts", diff: text, scenarios });
    expect(facts.nonTest).toEqual(["src/prod.ts"]);
    expect(facts.removed).toEqual(["web/old.test.ts"]);
    expect(facts.ok).toBe(false);
  });

  it("takes the map's test files as test files", () => {
    const text = diff("checks/cart.check.ts", `it("a @scenario:S1 @scenario:S2", () => {`);
    expect(scenarioTags({ nameStatus: "A\tchecks/cart.check.ts", diff: text, scenarios, testFiles: ["checks/cart.check.ts"] }).ok).toBe(true);
  });
});
