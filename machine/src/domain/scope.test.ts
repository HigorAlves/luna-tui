import { describe, expect, it } from "vitest";

import { addedLinesOf, scopeFacts } from "./scope.ts";

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
