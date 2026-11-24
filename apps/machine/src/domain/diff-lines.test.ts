import { describe, expect, it } from "vitest";

import { addedWithNumbers, pathsWithRemovals } from "./diff-lines.ts";

const diff = [
  "diff --git a/src/ui.rs b/src/ui.rs",
  "index 1..2 100644",
  "--- a/src/ui.rs",
  "+++ b/src/ui.rs",
  "@@ -10,3 +10,5 @@ fn x() {",
  " ctx",
  "+added one",
  " ctx2",
  "+added two",
  "@@ -40,2 +42,3 @@",
  " c",
  "-gone",
  "+new",
  "+newer",
  "diff --git a/new.rs b/new.rs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.rs",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
].join("\n");

describe("addedWithNumbers", () => {
  it("numbers each added line in the new file, across hunks and files", () => {
    expect(addedWithNumbers(diff).map((a) => [a.path, a.no, a.line])).toEqual([
      ["src/ui.rs", 11, "added one"],
      ["src/ui.rs", 13, "added two"],
      ["src/ui.rs", 43, "new"],
      ["src/ui.rs", 44, "newer"],
      ["new.rs", 1, "a"],
      ["new.rs", 2, "b"],
    ]);
  });
});

describe("pathsWithRemovals", () => {
  it("names the files that lost a line, not new files", () => {
    expect([...pathsWithRemovals(diff)]).toEqual(["src/ui.rs"]);
  });
});
