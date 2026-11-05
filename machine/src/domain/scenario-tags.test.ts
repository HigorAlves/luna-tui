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
    const text = diff("web/cart.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nA\tweb/__fixtures__/cart.json\nA\tsrc/prod.ts\nD\tweb/old.test.ts", diff: text, scenarios });
    expect(facts.nonTest).toEqual(["src/prod.ts"]);
    expect(facts.removed).toEqual(["web/old.test.ts"]);
    expect(facts.ok).toBe(false);
  });

  it("takes the map's test files as test files", () => {
    const text = diff("checks/cart.check.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    expect(scenarioTags({ nameStatus: "A\tchecks/cart.check.ts", diff: text, scenarios, testFiles: ["checks/cart.check.ts"] }).ok).toBe(true);
  });

  it("counts a deleted or renamed-away file that is not a test or a fixture as a change to production code", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    expect(scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nD\tsrc/auth/guard.ts\nD\t.github/workflows/ci.yml", diff: text, scenarios }).nonTest).toEqual(["src/auth/guard.ts", ".github/workflows/ci.yml"]);
    expect(scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nR100\tsrc/payments.ts\tweb/payments.test.ts", diff: text, scenarios }).nonTest).toEqual(["src/payments.ts"]);
  });

  it("never takes a control-plane path for a test file or a fixture, whatever its name", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    for (const path of [".github/workflows/test.yml", "scripts/test.sh", "Dockerfile.test", "docker-compose.test.yml", ".github/CODEOWNERS", "tests/__fixtures__/.github/workflows/x.yml"]) {
      expect(scenarioTags({ nameStatus: `A\tweb/cart.test.ts\nA\t${path}`, diff: text, scenarios }).nonTest, path).toEqual([path]);
    }
  });

  it("takes a file under a test folder only with a source extension, or inside a fixture folder", () => {
    const text = diff("tests/a.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    expect(scenarioTags({ nameStatus: "A\ttests/a.test.ts\nA\ttests/run.sh\nA\ttests/fixtures/data.json", diff: text, scenarios }).nonTest).toEqual(["tests/run.sh"]);
  });

  it("refuses a symlink or a nested repository the writer added, and a tag on a symlink does not count", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1", () => {`);
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts\nA\ttests/link.test.ts\nA\ttests/vendor", diff: text, scenarios, modes: { "tests/link.test.ts": "120000", "tests/vendor": "160000", "web/cart.test.ts": "100644" } });
    expect(facts.nonTest).toEqual(["tests/link.test.ts", "tests/vendor"]);
  });

  it("sends back a line that carries several scenario ids instead of crediting each", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1 @scenario:S2", () => {`);
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts", diff: text, scenarios });
    expect(facts).toMatchObject({ ok: false, ambiguous: ["web/cart.test.ts"], missing: ["S1", "S2"] });
  });

  it("accepts a fixture only as an added file under a test directory or beside a tagged test: a modified or deleted fixture elsewhere, or an added one far from the tests, is a production change", () => {
    const text = diff("web/cart.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    const run = (rows: string[]) => scenarioTags({ nameStatus: ["A\tweb/cart.test.ts", ...rows].join("\n"), diff: text, scenarios }).nonTest;
    expect(run(["M\tsrc/mocks/server.ts"])).toEqual(["src/mocks/server.ts"]);
    expect(run(["D\tsrc/__mocks__/db.ts"])).toEqual(["src/__mocks__/db.ts"]);
    expect(run(["A\tsrc/mocks/new.ts"])).toEqual(["src/mocks/new.ts"]);
    expect(run(["A\tweb/__fixtures__/cart.json", "A\ttests/mocks/db.ts", "M\ttests/fixtures/old.json"])).toEqual([]);
  });

  it("counts a bare test.<ext> or spec.<ext> as a test only inside a test directory", () => {
    const text = diff("tests/a.test.ts", `it("a @scenario:S1", () => {`, `it("b @scenario:S2", () => {`);
    const run = (rows: string[]) => scenarioTags({ nameStatus: ["A\ttests/a.test.ts", ...rows].join("\n"), diff: text, scenarios }).nonTest;
    expect(run(["A\tsrc/spec.ts", "A\tlib/test.py", "A\ttests/spec.ts", "A\ttests/test.py", "A\tsrc/test_cart.py", "A\tsrc/cart.spec.ts"])).toEqual(["src/spec.ts", "lib/test.py"]);
  });
});
