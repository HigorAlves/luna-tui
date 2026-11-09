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

describe("scenarioTags: Rust's inline tests", () => {
  const rs = (path: string, start: number, ...added: string[]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, `@@ -${start},0 +${start},${added.length} @@`, ...added.map((l) => `+${l}`)].join("\n");
  const body = ["#[cfg(test)]", "mod tests {", "    // @scenario:S1", "    #[test] fn s1() {}", "    // @scenario:S2", "    #[test] fn s2() {}", "}"];
  const regions = { "board/src/ui.rs": [[101, 107]] as Array<[number, number]> };

  it("takes a tagged test added inside a #[cfg(test)] module of a source file, and says the file is inline", () => {
    const facts = scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: rs("board/src/ui.rs", 101, ...body), scenarios, testRegions: regions });
    expect(facts).toMatchObject({ ok: true, missing: [], nonTest: [], tagged: { S1: "board/src/ui.rs", S2: "board/src/ui.rs" }, inline: ["board/src/ui.rs"] });
  });
  it("refuses the file when a line is added outside the module", () => {
    const text = [rs("board/src/ui.rs", 20, "fn sneaky() {}"), rs("board/src/ui.rs", 101, ...body)].join("\n");
    const facts = scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: text, scenarios, testRegions: regions });
    expect(facts).toMatchObject({ ok: false, nonTest: ["board/src/ui.rs"], inline: [] });
  });
  it("refuses the file when a line is removed, even inside the module", () => {
    const text = `${rs("board/src/ui.rs", 101, ...body)}\n-    #[test] fn old() {}`;
    const facts = scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: text, scenarios, testRegions: regions });
    expect(facts.ok).toBe(false);
    expect(facts.nonTest).toEqual(["board/src/ui.rs"]);
  });
  it("gives a tag outside any module no credit, and does not take the file without regions", () => {
    const facts = scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: rs("board/src/ui.rs", 101, ...body), scenarios });
    expect(facts).toMatchObject({ ok: false, missing: ["S1", "S2"], nonTest: ["board/src/ui.rs"] });
  });
  it("does not change a test file's own rules", () => {
    const facts = scenarioTags({ nameStatus: "A\tweb/cart.test.ts", diff: diff("web/cart.test.ts", "// @scenario:S1", "// @scenario:S2"), scenarios });
    expect(facts).toMatchObject({ ok: true, inline: [] });
  });
  it("takes an existing test edited inside the module (a call updated to a new argument, a tag added), as the writer of the split-card ticket did", () => {
    const text = [
      "diff --git a/board/src/detail.rs b/board/src/detail.rs",
      "--- a/board/src/detail.rs",
      "+++ b/board/src/detail.rs",
      "@@ -2000,2 +2000,3 @@",
      "+    // @scenario:S1",
      "     #[test]",
      "-    fn t() { overview_lines(&task, None, 100, 0); }",
      "+    fn t() { overview_lines(&task, None, 100, 0, &[]); }",
      "@@ -2100,0 +2101 @@",
      "+    // @scenario:S2",
    ].join("\n");
    const after = { "board/src/detail.rs": [[1590, 2500]] as Array<[number, number]> };
    const ok = scenarioTags({ nameStatus: "M\tboard/src/detail.rs", diff: text, scenarios, testRegions: after, testRegionsBefore: { "board/src/detail.rs": [[1590, 2497]] } });
    expect(ok).toMatchObject({ ok: true, nonTest: [], inline: ["board/src/detail.rs"] });
    // The same removed line, when it was outside the module before, is a production change.
    const outside = scenarioTags({ nameStatus: "M\tboard/src/detail.rs", diff: text, scenarios, testRegions: after, testRegionsBefore: { "board/src/detail.rs": [[2050, 2497]] } });
    expect(outside).toMatchObject({ ok: false, nonTest: ["board/src/detail.rs"] });
  });
  it("takes a second test module added after the first, with the blank line between them (the split-card writer's ui.rs)", () => {
    const text = [
      "diff --git a/board/src/ui.rs b/board/src/ui.rs",
      "--- a/board/src/ui.rs",
      "+++ b/board/src/ui.rs",
      "@@ -3984,0 +3985,6 @@",
      "+",
      "+#[cfg(test)]",
      "+mod split_render_tests {",
      "+    // @scenario:S1",
      "+    // @scenario:S2",
      "+}",
    ].join("\n");
    const facts = scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: text, scenarios, testRegions: { "board/src/ui.rs": [[3986, 3990]] }, testRegionsBefore: {} });
    expect(facts).toMatchObject({ ok: true, nonTest: [], inline: ["board/src/ui.rs"] });
  });
  it("still refuses code added between two modules", () => {
    const text = ["diff --git a/board/src/ui.rs b/board/src/ui.rs", "--- a/board/src/ui.rs", "+++ b/board/src/ui.rs", "@@ -3984,0 +3985,6 @@", "+fn sneaky() {}", "+#[cfg(test)]", "+mod t {", "+    // @scenario:S1", "+    // @scenario:S2", "+}"].join("\n");
    expect(scenarioTags({ nameStatus: "M\tboard/src/ui.rs", diff: text, scenarios, testRegions: { "board/src/ui.rs": [[3986, 3990]] } }).nonTest).toEqual(["board/src/ui.rs"]);
  });
});
