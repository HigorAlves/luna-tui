import { describe, expect, it } from "vitest";

import { ownerApprovals, ownersOf, parseCodeowners, parseCodeownersChecked, requiredOwners } from "./codeowners.ts";

// The examples are GitHub's documented CODEOWNERS file.
const FILE = `
# In this example, @octocat owns any file in the build/logs directory at the root
# of the repository and any of its subdirectories.
*       @global-owner1 @global-owner2
*.js    @js-owner #This is an inline comment.
*.go docs@example.com
*.txt @octo-org/octocats
/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
**/logs @octocat
/apps/github
`;

describe("parseCodeowners", () => {
  it("skips comments and blank lines, strips an inline comment, and keeps a rule with no owners", () => {
    const rules = parseCodeowners(FILE);
    expect(rules).toHaveLength(10);
    expect(rules[0]).toEqual({ pattern: "*", owners: ["@global-owner1", "@global-owner2"] });
    expect(rules[1]).toEqual({ pattern: "*.js", owners: ["@js-owner"] });
    expect(rules[9]).toEqual({ pattern: "/apps/github", owners: [] });
  });
});

describe("ownersOf", () => {
  const rules = parseCodeowners(FILE);

  it("lets the last matching rule win", () => {
    expect(ownersOf("README.md", rules)).toEqual(["@global-owner1", "@global-owner2"]);
    expect(ownersOf("src/app.js", rules)).toEqual(["@js-owner"]);
    expect(ownersOf("main.go", rules)).toEqual(["docs@example.com"]);
    expect(ownersOf("notes/todo.txt", rules)).toEqual(["@octo-org/octocats"]);
  });

  it("anchors a leading slash to the root and takes a trailing slash for a directory, subdirectories included", () => {
    const logs = parseCodeowners("/build/logs/ @doctocat\n");
    expect(ownersOf("build/logs/today.log", logs)).toEqual(["@doctocat"]);
    expect(ownersOf("build/logs/deep/er/today.log", logs)).toEqual(["@doctocat"]);
    expect(ownersOf("src/build/logs/today.log", logs)).toEqual([]);
    expect(ownersOf("docs/guide/setup.md", rules)).toEqual(["@doctocat"]);
    expect(ownersOf("apps/web/index.ts", rules)).toEqual(["@octocat"]);
    expect(ownersOf("packages/apps/web/index.ts", rules)).toEqual(["@octocat"]);
  });

  it("takes docs/* for the files directly under docs and not those below, anchored at the root", () => {
    const only = parseCodeowners("docs/* docs@example.com\n");
    expect(ownersOf("docs/getting-started.md", only)).toEqual(["docs@example.com"]);
    expect(ownersOf("docs/build-app/troubleshooting.md", only)).toEqual([]);
    expect(ownersOf("other/docs/a.md", only)).toEqual([]);
  });

  it("reads **/logs as a logs file or directory anywhere", () => {
    expect(ownersOf("logs", rules)).toEqual(["@octocat"]);
    expect(ownersOf("src/logs/a.txt", rules)).toEqual(["@octocat"]);
  });

  it("clears ownership with a rule that has no owners", () => {
    expect(ownersOf("apps/github", rules)).toEqual([]);
  });

  it("has no owners when nothing matches", () => {
    expect(ownersOf("a.md", parseCodeowners("*.js @a\n"))).toEqual([]);
    expect(ownersOf("a.md", [])).toEqual([]);
  });

  it("matches a bare name anywhere and ? and ** the gitignore way", () => {
    const r = parseCodeowners("Makefile @m\na?c.ts @q\nsrc/**/gen @g\n");
    expect(ownersOf("deep/dir/Makefile", r)).toEqual(["@m"]);
    expect(ownersOf("abc.ts", r)).toEqual(["@q"]);
    expect(ownersOf("src/gen/x.ts", r)).toEqual(["@g"]);
    expect(ownersOf("src/a/b/gen", r)).toEqual(["@g"]);
  });
});

describe("the matcher is linear", () => {
  it("finishes the former pathological case (**e repeated against a long path) at once", () => {
    const pattern = "**e".repeat(12);
    const rules = [{ pattern, owners: ["@a"] }];
    const started = performance.now();
    const owners = ownersOf("e".repeat(30) + "x", rules);
    expect(performance.now() - started).toBeLessThan(50);
    expect(owners).toEqual([]);
    expect(ownersOf("e".repeat(30), rules)).toEqual(["@a"]);
  });

  it("drops a rule over 512 characters or with more than 16 wildcards, and says so", () => {
    const long = `${"a/".repeat(260)}x @a`;
    const wild = `${"*a".repeat(17)} @a`;
    const out = parseCodeownersChecked(`*.ts @ok\n${long}\n${wild}\n`);
    expect(out.rules).toEqual([{ pattern: "*.ts", owners: ["@ok"] }]);
    expect(out.problems).toHaveLength(2);
    expect(out.problems[0]).toMatch(/too complex/);
  });
});

describe("requiredOwners", () => {
  it("lists only the paths that have owners", () => {
    const rules = parseCodeowners("*.ts @a\n/docs/ @b\n");
    expect(requiredOwners(["x.ts", "y.md", "docs/z.md"], rules)).toEqual([
      { path: "x.ts", owners: ["@a"] },
      { path: "docs/z.md", owners: ["@b"] },
    ]);
  });
});

describe("ownerApprovals", () => {
  const required = [
    { path: "a.ts", owners: ["@ana"] },
    { path: "b.ts", owners: ["@acme/core"] },
    { path: "c.ts", owners: ["@acme/ghosts", "@zed"] },
    { path: "d.ts", owners: ["mail@example.com"] },
  ];

  it("satisfies a user by that login's approval (case-insensitive) and a team by any member's", () => {
    const out = ownerApprovals(required.slice(0, 2), { approvers: ["Ana", "bob"], members: { "acme/core": ["bob", "cy"] } });
    expect(out.satisfied).toEqual([
      { path: "a.ts", by: "ana" },
      { path: "b.ts", by: "bob" },
    ]);
    expect(out.missing).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  it("names the path and its owners when nobody of them approved", () => {
    const out = ownerApprovals(required.slice(0, 2), { approvers: ["cy"], members: { "acme/core": ["bob"] } });
    expect(out.missing).toEqual([
      { path: "a.ts", owners: ["@ana"] },
      { path: "b.ts", owners: ["@acme/core"] },
    ]);
  });

  it("calls a team that is not in members, and an email, unresolved, and never a silent pass", () => {
    const out = ownerApprovals([required[2]!, required[3]!], { approvers: [], members: {} });
    expect(out.unresolved).toEqual(["@acme/ghosts", "mail@example.com"]);
    expect(out.missing.map((m) => m.path)).toEqual(["c.ts", "d.ts"]);
  });

  it("is satisfied by another owner on the same path even when a team is unresolved", () => {
    const out = ownerApprovals([required[2]!], { approvers: ["zed"], members: {} });
    expect(out.satisfied).toEqual([{ path: "c.ts", by: "zed" }]);
    expect(out.missing).toEqual([]);
    expect(out.unresolved).toEqual(["@acme/ghosts"]);
  });
});
