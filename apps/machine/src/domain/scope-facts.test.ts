import { describe, expect, it } from "vitest";

import { scopeFacts } from "./scope-facts.ts";

// A token-shaped string built at runtime: GitHub's push protection reads source files.
const token = ["gh", "p_"].join("") + "a".repeat(36);

const diff = (...files: string[]) => files.join("\n");
const file = (path: string, body: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n${body.join("\n")}`;

describe("scopeFacts", () => {
  it("says nothing about a diff with nothing in it", () => {
    expect(scopeFacts("")).toEqual({});
  });

  it("answers no_new_dependency false when a manifest gains a dependency line, and says nothing when none does", () => {
    const added = file("package.json", [' "dependencies": {', '+    "left-pad": "^1.3.0",', " }"]);
    expect(scopeFacts(added)).toEqual({ no_new_dependency: false });
    expect(scopeFacts(file("package.json", ['-    "name": "a",', '+    "name": "b",']))).toEqual({});
    expect(scopeFacts(file("src/a.ts", ['+    "left-pad": "^1.3.0",']))).toEqual({});
    expect(scopeFacts(file("pnpm-lock.yaml", ["+  left-pad@1.3.0:"]))).toEqual({ no_new_dependency: false });
  });

  it("answers no_test_removed false for a deleted test file, or a test case removed with none added in that file", () => {
    expect(scopeFacts(`diff --git a/src/a.test.ts b/src/a.test.ts\ndeleted file mode 100644\n--- a/src/a.test.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-it("x", () => {})`)).toEqual({ no_test_removed: false });
    expect(scopeFacts(file("src/a.test.ts", ['-  it("old case", () => {', "-  });"]))).toEqual({ no_test_removed: false });
    expect(scopeFacts(file("src/a.test.ts", ['-  it("old case", () => {', '+  it("renamed case", () => {']))).toEqual({});
    expect(scopeFacts(file("src/a.ts", ['-  it("not a test file", () => {']))).toEqual({});
  });

  it("answers no_todo false when an added line holds TODO, FIXME or XXX, and ignores a removed one", () => {
    expect(scopeFacts(file("src/a.ts", ["+  // TODO: later"]))).toEqual({ no_todo: false });
    expect(scopeFacts(file("src/a.ts", ["+  // fixme"]))).toEqual({});
    expect(scopeFacts(file("src/a.ts", ["+  // XXX hack"]))).toEqual({ no_todo: false });
    expect(scopeFacts(file("src/a.ts", ["-  // TODO: later"]))).toEqual({});
  });

  it("answers no_secret_or_pii false only in the negative: an added line the redactor matches", () => {
    expect(scopeFacts(file("src/a.ts", [`+  const t = "${token}";`]))).toEqual({ no_secret_or_pii: false });
    expect(scopeFacts(file("src/a.ts", ['+  const t = "nothing here";']))).toEqual({});
  });

  it("never answers planned_or_declared or unrelated_refactors", () => {
    const all = scopeFacts(diff(file("package.json", ['+    "x": "1",']), file("src/a.test.ts", ['-it("a", () => {']), file("src/a.ts", ["+// TODO", `+"${token}"`])));
    expect(Object.keys(all).sort()).toEqual(["no_new_dependency", "no_secret_or_pii", "no_test_removed", "no_todo"]);
  });
});
