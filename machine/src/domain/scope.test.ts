import { describe, expect, it } from "vitest";

import { addedLinesOf, removedLinesOf, scopeFacts, scopeIssues } from "./scope.ts";

const status = (...lines: string[]) => lines.join("\n");
const none = { planned: [], declared: [], addedLines: [] };

describe("addedLinesOf", () => {
  it("lists each added line with its file and, for a toml file, the section above it", () => {
    const diff = [
      "diff --git a/Cargo.toml b/Cargo.toml",
      "--- a/Cargo.toml",
      "+++ b/Cargo.toml",
      "@@ -4,3 +4,4 @@",
      " [dependencies]",
      " serde = \"1\"",
      "+regex = \"1\"",
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      " a",
      "+b // TODO later",
    ].join("\n");
    expect(addedLinesOf(diff)).toEqual([
      { path: "Cargo.toml", line: 'regex = "1"', section: "dependencies" },
      { path: "src/a.ts", line: "b // TODO later" },
    ]);
  });
});

describe("scopeFacts", () => {
  it("lists the changed files, the new path of a rename, and what the plan and the declarations leave out", () => {
    const facts = scopeFacts({
      ...none,
      nameStatus: status("M\tsrc/a.ts", "A\tsrc/b.ts", "R100\tsrc/old.ts\tsrc/new.ts", "A\tsrc/helpers/x.ts", "A\tdocs/n.md"),
      planned: ["src/a.ts", "src/b.ts", "src/new.ts", "src/helpers/"],
      declared: [{ path: "docs/n.md", reason: "docs" }],
    });
    expect(facts.changed).toEqual(["src/a.ts", "src/b.ts", "src/new.ts", "src/helpers/x.ts", "docs/n.md"]);
    expect(facts.undeclared).toEqual([]);
    expect(scopeFacts({ ...none, nameStatus: status("M\tsrc/a.ts", "A\tother.ts"), planned: ["src/a.ts"] }).undeclared).toEqual(["other.ts"]);
    // With a plan present an empty planned list switches nothing off: every changed file is undeclared.
    expect(scopeFacts({ ...none, nameStatus: status("M\tsrc/a.ts"), planned: [], planPresent: true }).undeclared).toEqual(["src/a.ts"]);
  });

  it("reads a planned path literally: brackets and parentheses are part of a real path, and name that file only, or a directory's whole subtree", () => {
    const planned = ["app/[team]/billing.ts", "app/(shop)"];
    expect(scopeFacts({ ...none, nameStatus: "M\tapp/[team]/billing.ts", planned }).undeclared).toEqual([]);
    expect(scopeFacts({ ...none, nameStatus: "M\tapp/t/billing.ts", planned }).undeclared).toEqual(["app/t/billing.ts"]);
    expect(scopeFacts({ ...none, nameStatus: "M\tapp/(shop)/cart.tsx", planned }).undeclared).toEqual([]);
    expect(scopeFacts({ ...none, nameStatus: "M\tapp/x/billing.ts\nM\tapp/a/billing.ts", planned: ["app/[ab]/billing.ts"] }).undeclared).toEqual(["app/x/billing.ts", "app/a/billing.ts"]);
  });

  it("reads a planned entry as a glob only when it holds * ? or {, which only a plan stored before this wave can", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/deep/a.ts\nM\tsrc/b.js", planned: ["src/**/*.ts"] }).undeclared).toEqual(["src/b.js"]);
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/a.ts\nM\tsrc/b.js", planned: ["src/{a,c}.ts"] }).undeclared).toEqual(["src/b.js"]);
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/a1.ts\nM\tsrc/ab.ts", planned: ["src/a?.ts"] }).undeclared).toEqual([]);
  });

  it("matches a planned glob, and has no undeclared files when the plan names none", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/deep/a.ts", planned: ["src/**/*.ts"] }).undeclared).toEqual([]);
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/a.ts", planned: [] }).undeclared).toEqual([]);
  });

  it("names the test files the change removed, but not the ones it added or edited", () => {
    const facts = scopeFacts({ ...none, nameStatus: status("D\tsrc/a.test.ts", "M\tsrc/b.test.ts", "A\tsrc/c.test.ts") });
    expect(facts.removedTests).toEqual(["src/a.test.ts"]);
  });

  it("finds a new dependency in each manifest, and not a version bump of the package itself", () => {
    const added = (path: string, line: string, section?: string) => ({ path, line, ...(section ? { section } : {}) });
    const facts = scopeFacts({
      ...none,
      nameStatus: "M\tpackage.json",
      addedLines: [
        added("package.json", '    "left-pad": "^1.3.0",'),
        added("package.json", '  "version": "1.2.3",'),
        added("package.json", '    "test": "vitest",'),
        added("go.mod", "\tgithub.com/pkg/errors v0.9.1"),
        added("Cargo.toml", 'regex = "1"', "dependencies"),
        added("Cargo.toml", 'name = "x"', "package"),
        added("pyproject.toml", '  "requests>=2",'),
        added("requirements-dev.txt", "pytest==8.0"),
        added("requirements.txt", "# a comment"),
      ],
    });
    expect(facts.newDependencies).toEqual([
      "package.json: left-pad ^1.3.0",
      "go.mod: github.com/pkg/errors v0.9.1",
      "Cargo.toml: regex",
      "pyproject.toml: requests>=2",
      "requirements-dev.txt: pytest==8.0",
    ]);
  });

  it("finds added TODO, FIXME and XXX, and secret-looking lines and files", () => {
    const facts = scopeFacts({
      ...none,
      nameStatus: status("A\t.env.local", "A\tkeys/server.pem", "A\tdeploy.key", "D\told.key", "M\tsrc/a.ts"),
      addedLines: [
        { path: "src/a.ts", line: "  // TODO: handle empty" },
        { path: "src/a.ts", line: "  // FIXME" },
        { path: "src/a.ts", line: "const TODOS = 1" },
        { path: "src/a.ts", line: 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' },
        { path: "src/a.ts", line: "const ok = 1" },
      ],
    });
    expect(facts.todos).toEqual(["src/a.ts: // TODO: handle empty", "src/a.ts: // FIXME"]);
    // A matched token is named by its first four characters only: the fact is that one exists, never its value.
    expect(facts.secrets).toEqual([".env.local", "keys/server.pem", "deploy.key", "src/a.ts: ghp_\u2026"]);
  });
});

describe("secret patterns", () => {
  it("knows the common token shapes and key files, and masks every match", () => {
    // Built at runtime so no token-shaped literal sits in the repository (GitHub's push protection reads test files too).
    const filler = (n: number) => "a1b2c3d4e5".repeat(4).slice(0, n);
    const lines = [
      ["sk", "live", filler(24)].join("_"),
      `token = ${["gho", filler(36)].join("_")}`,
      `key: ${"AIza" + filler(35)}`,
      ["-----BEGIN RSA PRIVATE", "KEY-----"].join(" "),
      ["npm", filler(36)].join("_"),
    ].map((line) => ({ path: "src/x.ts", line }));
    const facts = scopeFacts({ nameStatus: "A\tsrc/x.ts\nA\t.ssh/id_rsa\nA\t.npmrc\nA\tcerts/a.p12\nA\t.envrc", addedLines: lines, planned: [], declared: [] });
    expect(facts.secrets).toEqual([".ssh/id_rsa", ".npmrc", "certs/a.p12", ".envrc", "src/x.ts: sk_l\u2026", "src/x.ts: gho_\u2026", "src/x.ts: AIza\u2026", "src/x.ts: ----\u2026", "src/x.ts: npm_\u2026"]);
    expect(JSON.stringify(facts)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("tests switched off in place", () => {
  const line = (text: string) => [{ path: "src/cart.test.ts", line: text }];
  it.each([
    ["it.skip('x', () => {})"], ["describe.only('x', () => {})"], ["xit('x', () => {})"], ["xdescribe('x', () => {})"], ["@Ignore"], ["@Disabled(\"later\")"], ["t.Skip(\"flaky\")"], ["#[ignore]"], ["@pytest.mark.skip(reason='x')"], ["pytest.mark.skip"],
    ["it.skipIf(process.env.CI)('x', () => {})"], ["test.runIf(false)('x', () => {})"], ["it.todo('x')"], ["test.fixme('x', () => {})"], ["this.skip()"], ["pytest.skip('later')"], ["@unittest.skip('later')"], ["@pytest.mark.xfail"], ["t.SkipNow()"], ['#[ignore = "flaky"]'],
  ])("lists %s on an added line of a file", (text) => {
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/cart.test.ts", addedLines: line(text) }).switchedOff).toEqual([`src/cart.test.ts: ${text}`]);
  });
  it("leaves an ordinary test and a word that only contains skip alone", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/a.ts", addedLines: [{ path: "src/a.ts", line: "const skipped = true; it('x', () => {})" }] }).switchedOff).toEqual([]);
  });
});

describe("scenario tests are fixed once committed", () => {
  const tests = [{ scenario: "S1", file: "web/cart.test.ts" }, { scenario: "S2", file: "web/cart.test.ts" }, { scenario: "S3", file: "web/other.test.ts" }];

  it("lists every scenario of a tagged test file the change touched at all, even with the tag untouched (an emptied body, a deleted expect)", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tweb/cart.test.ts", scenarioTests: tests }).weakened).toEqual(["S1", "S2"]);
    expect(scopeFacts({ ...none, nameStatus: "D\tweb/other.test.ts", scenarioTests: tests }).weakened).toEqual(["S3"]);
    expect(scopeFacts({ ...none, nameStatus: "R100\tweb/other.test.ts\tweb/moved.test.ts", scenarioTests: tests }).weakened).toEqual(["S3"]);
  });

  it("protects every path of the tests commit, not only the first file that holds each tag: a helper or a fixture it added is weakened when changed", () => {
    const protectedPaths = ["web/cart.test.ts", "web/helper.test.ts", "web/__fixtures__/cart.json"];
    const facts = scopeFacts({ ...none, nameStatus: "M\tweb/helper.test.ts\nD\tweb/__fixtures__/cart.json", scenarioTests: tests, protectedPaths });
    expect(facts.weakened).toEqual(["file:web/helper.test.ts", "file:web/__fixtures__/cart.json"]);
    const issues = scopeIssues({ ...facts, changed: [], undeclared: [], removedTests: [], newDependencies: [], todos: [], secrets: [], switchedOff: [] }, []);
    expect(issues).toEqual([expect.objectContaining({ severity: "blocker", kind: "test_weakened", path: "web/helper.test.ts" }), expect.objectContaining({ severity: "blocker", kind: "test_weakened", path: "web/__fixtures__/cart.json" })]);
  });

  it("is empty when the change leaves the scenario test files alone", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tsrc/a.ts\nA\tweb/new.test.ts", scenarioTests: tests }).weakened).toEqual([]);
  });

  it("counts a kept tag only on an added line of a test file: re-adding the tag in production code does not keep the scenario", () => {
    const removed = [{ path: "web/cart.test.ts", line: "it('x @scenario:S1', () => {" }];
    const inProduction = [{ path: "src/cart.ts", line: "// @scenario:S1" }];
    expect(scopeFacts({ ...none, nameStatus: "M\tweb/cart.test.ts", removedLines: removed, addedLines: inProduction }).weakened).toEqual(["S1"]);
  });
});

describe("weakened scenario tests", () => {
  const removed = [{ path: "web/cart.test.ts", line: "it('exports two rows @scenario:S1', () => {" }];
  it("lists a scenario whose tag the change removed from a test and did not put back", () => {
    expect(scopeFacts({ ...none, nameStatus: "M\tweb/cart.test.ts", removedLines: removed }).weakened).toEqual(["S1"]);
  });
  it("is empty when the tag is still on an added line (the test was reworded, not dropped)", () => {
    const added = [{ path: "web/cart.test.ts", line: "it('exports rows @scenario:S1', () => {" }];
    expect(scopeFacts({ ...none, nameStatus: "M\tweb/cart.test.ts", removedLines: removed, addedLines: added }).weakened).toEqual([]);
  });
});

describe("file headers in a diff", () => {
  const diffOf = (...lines: string[]) => ["diff --git a/db/t.sql b/db/t.sql", "index 1..2 100644", "--- a/db/t.sql", "+++ b/db/t.sql", "@@ -1,2 +1,2 @@", ...lines].join("\n");

  it("reads a header only right after the diff line: a content line that looks like one is content", () => {
    const diff = diffOf("--- @scenario:S1 the old tag comment", "+++ b/src/prod.ts", "+-- @scenario:S2 the new one", " kept");
    expect(removedLinesOf(diff)).toEqual([{ path: "db/t.sql", line: "-- @scenario:S1 the old tag comment" }]);
    expect(addedLinesOf(diff)).toEqual([{ path: "db/t.sql", line: "++ b/src/prod.ts" }, { path: "db/t.sql", line: "-- @scenario:S2 the new one" }]);
  });

  it("follows each file's own header in a diff of several files", () => {
    const diff = [diffOf("+one"), "diff --git a/b.ts b/b.ts", "new file mode 100644", "index 0..3", "--- /dev/null", "+++ b/b.ts", "@@ -0,0 +1 @@", "+two"].join("\n");
    expect(addedLinesOf(diff)).toEqual([{ path: "db/t.sql", line: "one" }, { path: "b.ts", line: "two" }]);
  });
});

describe("removedLinesOf", () => {
  it("lists each removed line with its file", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1 @@", "-gone", " kept"].join("\n");
    expect(removedLinesOf(diff)).toEqual([{ path: "a.ts", line: "gone" }]);
  });
});

describe("scopeIssues texts", () => {
  const token = ["ghp", "a".repeat(36)].join("_");
  const facts = { changed: [], undeclared: [], removedTests: [], newDependencies: [], todos: [`a.ts: // TODO ${token}`], secrets: [], switchedOff: [`a.test.ts: it.skip("x", () => { const k = "${token}" })`], weakened: [] };

  it("carries no raw added line: redacted by safe() and capped at 120, with the path beside it", () => {
    const issues = scopeIssues(facts, []);
    for (const issue of issues) {
      expect(issue.text).not.toContain(token);
      expect(issue.text.length).toBeLessThanOrEqual(120);
    }
    expect(issues.find((i) => i.kind === "switched_off_test")).toMatchObject({ path: "a.test.ts" });
  });
});

describe("scopeIssues", () => {
  const facts = { changed: [], undeclared: ["b.ts"], removedTests: ["a.test.ts"], newDependencies: ["package.json: left-pad ^1"], todos: ["a.ts: TODO later"], secrets: ["x: ghp_\u2026"], switchedOff: ["a.test.ts: it.skip(x)"], weakened: ["S2"] };
  it("is a blocker for an undeclared file, a removed or switched-off or weakened test and a secret; should_fix for a dependency; nit for a TODO", () => {
    const bySeverity = (s: string) => scopeIssues(facts, []).filter((i) => i.severity === s).map((i) => i.kind).sort();
    expect(bySeverity("blocker")).toEqual(["secret", "switched_off_test", "test_removed", "test_weakened", "undeclared_file"]);
    expect(bySeverity("should_fix")).toEqual(["new_dependency"]);
    expect(bySeverity("nit")).toEqual(["todo"]);
  });
  it("adds an unrelated refactor the scope check judged as should_fix", () => {
    const issues = scopeIssues({ ...facts, undeclared: [], removedTests: [], secrets: [], switchedOff: [], weakened: [], newDependencies: [], todos: [] }, ["unrelated_refactor"]);
    expect(issues).toEqual([expect.objectContaining({ severity: "should_fix", kind: "unrelated_refactor" })]);
  });
});
